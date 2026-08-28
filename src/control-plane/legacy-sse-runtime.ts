import type { CatalogStore, RuntimeActionDefinition } from "../catalog-store.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { ConnectionLeaseClaims } from "./types.ts";
import type { DatabaseSync } from "node:sqlite";

import { randomUUID } from "node:crypto";
import { ConnectionLeaseService, LeaseError } from "./lease.ts";
import { redactSecrets } from "./redaction.ts";
import { createLeasePolicy, createTenantRuntime } from "./service.ts";

export interface LegacySseRuntimeOptions {
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  controlDatabase: DatabaseSync;
  secretCodec: ISecretCodec;
  publicOrigin: string;
  transitFiles?: import("../core/types.ts").TransitFileWriter;
}

export interface LegacySseScope {
  connectionId: string;
  invocationId: string;
  audience: string;
}

export class LegacySseRuntime {
  private readonly leases: ConnectionLeaseService;
  private readonly options: LegacySseRuntimeOptions;

  constructor(options: LegacySseRuntimeOptions) {
    this.options = options;
    this.leases = new ConnectionLeaseService(options.controlDatabase);
    options.controlDatabase.exec(`
      create table if not exists legacy_mcp_sessions (
        id text primary key,
        lease_jti text not null,
        connection_id text not null,
        invocation_id text not null,
        audience text not null,
        created_at text not null,
        expires_at text not null
      );
      create table if not exists legacy_mcp_messages (
        id integer primary key autoincrement,
        session_id text not null,
        payload_json text not null,
        created_at text not null
      );
      create index if not exists idx_legacy_mcp_messages_session
        on legacy_mcp_messages (session_id, id);
    `);
  }

  open(leaseToken: string, scope: LegacySseScope): string {
    const claims = this.leases.verifyRuntime(leaseToken, scope);
    this.leases.verifyRuntime(leaseToken, {
      ...scope,
      connectionRevision: this.connectionRevision(scope.connectionId, claims.jti),
    });
    const id = randomUUID();
    this.options.controlDatabase
      .prepare(
        `insert into legacy_mcp_sessions
          (id, lease_jti, connection_id, invocation_id, audience, created_at, expires_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        claims.jti,
        scope.connectionId,
        scope.invocationId,
        scope.audience,
        new Date().toISOString(),
        claims.expiresAt,
      );
    return id;
  }

  async receive(sessionId: string, leaseToken: string, message: unknown): Promise<void> {
    const session = this.session(sessionId);
    const request = jsonRpcRequest(message);
    const claims = this.leases.verifyRuntime(leaseToken, {
      connectionId: session.connectionId,
      connectionRevision: this.connectionRevision(session.connectionId, session.leaseJti),
      invocationId: session.invocationId,
      audience: session.audience,
    });
    if (request.id === undefined) return;
    try {
      const result = await this.result(request.method, request.params, session, claims);
      this.enqueue(sessionId, { jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      this.enqueue(sessionId, {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: error instanceof LeaseError ? -32_001 : -32_603,
          message: error instanceof Error ? error.message : "MCP request failed.",
        },
      });
    }
  }

  take(sessionId: string, leaseToken: string): string[] {
    const session = this.session(sessionId);
    this.leases.verifyRuntime(leaseToken, {
      connectionId: session.connectionId,
      connectionRevision: this.connectionRevision(session.connectionId, session.leaseJti),
      invocationId: session.invocationId,
      audience: session.audience,
    });
    const rows = this.options.controlDatabase
      .prepare("select id, payload_json from legacy_mcp_messages where session_id=? order by id limit 32")
      .all(sessionId) as Array<{ id: number; payload_json: string }>;
    if (rows.length) {
      this.options.controlDatabase
        .prepare("delete from legacy_mcp_messages where session_id=? and id<=?")
        .run(sessionId, rows.at(-1)!.id);
    }
    return rows.map((row) => row.payload_json);
  }

  close(sessionId: string): void {
    this.options.controlDatabase.prepare("delete from legacy_mcp_messages where session_id=?").run(sessionId);
    this.options.controlDatabase.prepare("delete from legacy_mcp_sessions where id=?").run(sessionId);
  }

  private async result(
    method: string,
    params: Record<string, unknown>,
    session: PersistedSession,
    claims: ConnectionLeaseClaims,
  ): Promise<unknown> {
    if (method === "initialize") {
      return {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "connection-service", version: "1.0.0" },
      };
    }
    if (method === "ping") return {};
    const tools = await this.tools(session, claims.allowedActions);
    if (method === "tools/list") {
      return {
        tools: tools.map(({ toolName: name, action }) => ({
          name,
          description: action.description,
          inputSchema: action.inputSchema,
        })),
      };
    }
    if (method === "tools/call") {
      const name = requiredString(params.name, "tool name");
      const selected = tools.find((tool) => tool.toolName === name);
      if (!selected) throw new LeaseError("lease_scope_denied", "Tool is not granted by the connection lease.");
      const runtime = await this.runtimeForSession(session);
      const result = await runtime.actions.run({
        actionId: selected.action.id,
        input: object(params.arguments),
        caller: "mcp",
        connectionName: runtime.connectionName,
        invocationId: session.invocationId,
        policy: createLeasePolicy(claims),
        runtimeTokenId: claims.jti,
      });
      if (!result || result.auditPersisted !== true) {
        return {
          content: [{ type: "text", text: "Connection action audit could not be persisted." }],
          structuredContent: {
            ok: false,
            error: { code: "audit_unavailable", message: "Connection action audit could not be persisted." },
          },
          isError: true,
        };
      }
      const payload = {
        executionId: result.executionId,
        auditPersisted: true,
        ok: result.result.ok,
        result: redactSecrets(result.result),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: !payload.ok || payload.auditPersisted !== true,
      };
    }
    throw new Error(`Unsupported MCP method: ${method}.`);
  }

  private async tools(session: PersistedSession, allowedActions: string[]) {
    const runtime = await this.runtimeForSession(session);
    return this.options.catalog.actions
      .filter((action) => allowedActions.includes(action.id) && action.execution.locallyExecutable)
      .filter((action) => action.service === runtime.service)
      .map((action) => ({ toolName: toolName(session.connectionId, action), action }));
  }

  private async runtimeForSession(session: Pick<PersistedSession, "connectionId" | "leaseJti">) {
    const claims = this.options.controlDatabase
      .prepare("select tenant_id, workspace_id, subject, audience from connection_leases where jti=?")
      .get(session.leaseJti) as Record<string, unknown> | undefined;
    if (!claims) throw new LeaseError("invalid_lease", "Connection lease was not found.");
    const runtime = createTenantRuntime(this.options, {
      tenantId: String(claims.tenant_id),
      workspaceId: String(claims.workspace_id),
      subject: String(claims.subject),
      ownerId: String(claims.subject),
      audience: String(claims.audience),
    });
    const connection = (await runtime.records()).find((record) => record.id === session.connectionId);
    if (!connection) throw new LeaseError("lease_scope_denied", "Connection is not visible to the lease.");
    return { ...runtime, service: connection.service, connectionName: connection.connectionName };
  }

  private session(id: string): PersistedSession {
    const row = this.options.controlDatabase.prepare("select * from legacy_mcp_sessions where id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new LeaseError("invalid_lease", "MCP session was not found.");
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
      this.close(id);
      throw new LeaseError("lease_expired", "Connection lease expired.");
    }
    return persistedSession(row);
  }

  private enqueue(sessionId: string, payload: unknown): void {
    this.options.controlDatabase
      .prepare("insert into legacy_mcp_messages (session_id, payload_json, created_at) values (?, ?, ?)")
      .run(sessionId, JSON.stringify(payload), new Date().toISOString());
  }

  private connectionRevision(connectionId: string, leaseJti: string): number {
    const row = this.options.controlDatabase
      .prepare(
        `select tenant_connections.revision
           from tenant_connections
           join connection_leases
             on connection_leases.tenant_id = tenant_connections.tenant_id
            and connection_leases.workspace_id = tenant_connections.workspace_id
          where tenant_connections.id = ? and connection_leases.jti = ?
            and tenant_connections.status <> 'revoked'`,
      )
      .get(connectionId, leaseJti) as { revision?: unknown } | undefined;
    if (!row || !Number.isInteger(Number(row.revision))) {
      throw new LeaseError("lease_scope_denied", "Connection is not available to the lease.");
    }
    return Number(row.revision);
  }
}

interface PersistedSession {
  id: string;
  leaseJti: string;
  connectionId: string;
  invocationId: string;
  audience: string;
}

function persistedSession(row: Record<string, unknown>): PersistedSession {
  return {
    id: String(row.id),
    leaseJti: String(row.lease_jti),
    connectionId: String(row.connection_id),
    invocationId: String(row.invocation_id),
    audience: String(row.audience),
  };
}

function jsonRpcRequest(value: unknown): { id?: string | number; method: string; params: Record<string, unknown> } {
  const request = object(value);
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    throw new Error("Invalid JSON-RPC request.");
  }
  return {
    ...(typeof request.id === "string" || typeof request.id === "number" ? { id: request.id } : {}),
    method: request.method,
    params: object(request.params),
  };
}

function toolName(connectionId: string, action: RuntimeActionDefinition): string {
  return `${connectionId.slice(0, 12)}__${action.id}`.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}
