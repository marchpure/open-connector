import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { withMcpClient } from "../providers/mcp-client.ts";
import type { McpHttpTransport } from "../providers/mcp-client.ts";
import type { Client } from "@modelcontextprotocol/client";
import { createGuardedFetch } from "../core/guarded-fetch.ts";

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
}

export class McpAdapterError extends Error {
  readonly code: "invalid_definition" | "command_not_allowed" | "header_not_allowed" | "request_failed";

  constructor(code: McpAdapterError["code"], message: string) {
    super(message);
    this.name = "McpAdapterError";
    this.code = code;
  }
}

export class ControlledMcpAdapter {
  private readonly definition: McpDefinition;

  constructor(definition: McpDefinition) {
    this.definition = definition;
    validateDefinition(definition);
  }

  async discover(): Promise<{ tools: unknown[]; resources: unknown[]; prompts: unknown[] }> {
    return this.withClient(async (client) => ({
      tools: (await client.listTools()).tools as unknown[],
      resources: (await client.listResources()).resources as unknown[],
      prompts: (await client.listPrompts()).prompts as unknown[],
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.withClient((client) => client.callTool({ name, arguments: args }));
  }

  private async withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
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
        await client.connect(transport, { timeout: 30_000 });
        return await run(client);
      } finally {
        await client.close().catch(() => undefined);
      }
    }
    const endpoint = new URL(this.definition.endpoint!);
    return withMcpClient({
      endpoint,
      transport: this.definition.transport,
      headers: this.definition.headers,
      fetcher: createGuardedFetch(),
    }, run);
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
