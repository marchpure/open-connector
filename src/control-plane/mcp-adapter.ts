import type { McpHttpTransport } from "../providers/mcp-client.ts";
import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { Client } from "@modelcontextprotocol/client";
import type { DatabaseSync } from "node:sqlite";

import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { randomUUID } from "node:crypto";
import { createGuardedFetch } from "../core/guarded-fetch.ts";
import { withMcpClient } from "../providers/mcp-client.ts";

export type McpTransport = McpHttpTransport | "stdio";

export interface McpDefinition {
  transport: McpTransport;
  endpoint?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  allowedCommands?: string[];
  allowedHeaderNames?: string[];
  allowedTools?: string[];
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
}

export class McpAdapterError extends Error {
  readonly code:
    | "invalid_definition"
    | "command_not_allowed"
    | "header_not_allowed"
    | "tool_not_allowed"
    | "invalid_schema"
    | "request_failed";

  constructor(code: McpAdapterError["code"], message: string) {
    super(message);
    this.name = "McpAdapterError";
    this.code = code;
  }
}

export class TenantMcpDefinitionStore {
  private readonly database: DatabaseSync;
  private readonly scope: { tenantId: string; workspaceId: string };
  private readonly secretCodec: ISecretCodec;

  constructor(database: DatabaseSync, scope: { tenantId: string; workspaceId: string }, secretCodec: ISecretCodec) {
    this.database = database;
    this.scope = scope;
    this.secretCodec = secretCodec;
    this.database.exec(`
      create table if not exists tenant_mcp_definitions (
        id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        definition_ciphertext text not null,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists idx_tenant_mcp_definitions_scope
        on tenant_mcp_definitions (tenant_id, workspace_id);
    `);
  }

  async save(definition: McpDefinition): Promise<{ id: string }> {
    validateDefinition(definition);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(
        `insert into tenant_mcp_definitions
          (id, tenant_id, workspace_id, definition_ciphertext, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.scope.tenantId,
        this.scope.workspaceId,
        await this.secretCodec.encode(JSON.stringify(definition)),
        now,
        now,
      );
    return { id };
  }

  async get(id: string): Promise<McpDefinition | undefined> {
    const row = this.database
      .prepare(
        `select definition_ciphertext from tenant_mcp_definitions
          where id=? and tenant_id=? and workspace_id=?`,
      )
      .get(id, this.scope.tenantId, this.scope.workspaceId) as Record<string, unknown> | undefined;
    return row
      ? (JSON.parse(await this.secretCodec.decode(String(row.definition_ciphertext))) as McpDefinition)
      : undefined;
  }
}

export class ControlledMcpAdapter {
  private readonly definition: McpDefinition;
  private readonly clientRunner?: <T>(run: (client: Client) => Promise<T>) => Promise<T>;

  constructor(definition: McpDefinition, clientRunner?: <T>(run: (client: Client) => Promise<T>) => Promise<T>) {
    this.definition = definition;
    this.clientRunner = clientRunner;
    validateDefinition(definition);
  }

  async discover(): Promise<{ tools: unknown[]; resources: unknown[]; prompts: unknown[] }> {
    return this.withClient(async (client) => {
      const tools = (await client.listTools()).tools.filter(
        (tool) => !this.definition.allowedTools || this.definition.allowedTools.includes(tool.name),
      );
      for (const tool of tools) assertSafeToolSchema(tool.inputSchema);
      return {
        tools: tools as unknown[],
        resources: (await client.listResources()).resources as unknown[],
        prompts: (await client.listPrompts()).prompts as unknown[],
      };
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.definition.allowedTools?.includes(name)) {
      throw new McpAdapterError("tool_not_allowed", `MCP tool is not in the allowlist: ${name}.`);
    }
    return this.withClient((client) => client.callTool({ name, arguments: args }));
  }

  private async withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
    if (this.clientRunner) {
      return withTimeout(this.clientRunner(run), this.definition.timeoutMs ?? 30_000);
    }
    if (this.definition.transport === "stdio") {
      const transport = new StdioClientTransport({
        command: this.definition.command!,
        args: this.definition.args,
        env: this.definition.env,
        stderr: "pipe",
      });
      const client = new (await import("@modelcontextprotocol/client")).Client(
        { name: "connection-service", version: "1.0.0" },
        { capabilities: {} },
      );
      try {
        await client.connect(transport, { timeout: this.definition.timeoutMs ?? 30_000 });
        return await withTimeout(run(client), this.definition.timeoutMs ?? 30_000);
      } finally {
        await client.close().catch(() => undefined);
      }
    }
    const endpoint = new URL(this.definition.endpoint!);
    return withMcpClient(
      {
        endpoint,
        transport: this.definition.transport,
        headers: this.definition.headers,
        fetcher: createGuardedFetch({ allowPrivateNetwork: this.definition.allowPrivateNetwork }),
      },
      run,
    );
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new McpAdapterError("request_failed", "MCP request timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertSafeToolSchema(schema: unknown): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new McpAdapterError("invalid_schema", "MCP tool inputSchema must be a JSON object schema.");
  }
  const value = schema as Record<string, unknown>;
  if (value.type !== "object") {
    throw new McpAdapterError("invalid_schema", "MCP tool inputSchema must have type object.");
  }
  const serialized = JSON.stringify(value);
  if (/["'](?:__proto__|prototype|constructor)["']/.test(serialized) || /"\$ref":"https?:/i.test(serialized)) {
    throw new McpAdapterError("invalid_schema", "MCP tool inputSchema contains unsafe references or properties.");
  }
}

function validateDefinition(definition: McpDefinition): void {
  if (definition.transport === "stdio") {
    if (!definition.command || !definition.allowedCommands?.includes(definition.command)) {
      throw new McpAdapterError("command_not_allowed", "stdio command is not in the allowlist.");
    }
  } else {
    if (!definition.endpoint || !/^https?:\/\//.test(definition.endpoint)) {
      throw new McpAdapterError("invalid_definition", "MCP endpoint must be HTTP(S).");
    }
  }
  for (const name of Object.keys(definition.headers ?? {})) {
    if (!definition.allowedHeaderNames?.includes(name.toLowerCase())) {
      throw new McpAdapterError("header_not_allowed", `MCP header is not allowlisted: ${name}.`);
    }
  }
}
