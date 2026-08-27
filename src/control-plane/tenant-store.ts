import type { IConnectionStore, StoredConnection } from "../connection-service.ts";
import type { ResolvedCredential } from "../core/types.ts";
import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { IRunLogStore, RunLog, RunLogListInput, RunLogPage, RunLogWriteResult } from "../server/storage/runtime-store.ts";
import type { IOAuthClientConfigStore, OAuthClientConfig } from "../oauth/oauth-client-config-service.ts";
import type { IOAuthStateStore, OAuthAuthorizationState } from "../oauth/oauth-flow-service.ts";

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ConnectionRecord, TenantPrincipal } from "./types.ts";
import { redactSecrets, safeConnectionProfile } from "./redaction.ts";

export class TenantConnectionStore implements IConnectionStore {
  private readonly database: DatabaseSync;
  private readonly principal: TenantPrincipal;
  private readonly secretCodec: ISecretCodec;

  constructor(
    database: DatabaseSync,
    principal: TenantPrincipal,
    secretCodec: ISecretCodec,
  ) {
    this.database = database;
    this.principal = principal;
    this.secretCodec = secretCodec;
    this.database.exec(`
      create table if not exists tenant_connections (
        id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        owner_id text not null,
        service text not null,
        connection_name text not null,
        connector_definition_version text not null,
        credential_ref text not null,
        credential_ciphertext text not null,
        profile_json text not null,
        status text not null,
        revision integer not null,
        visibility text not null,
        created_at text not null,
        updated_at text not null,
        unique (tenant_id, workspace_id, service, connection_name)
      );
      create index if not exists idx_tenant_connections_scope
        on tenant_connections (tenant_id, workspace_id);
      create table if not exists control_execution_audit (
        id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        subject text not null,
        invocation_id text not null,
        connection_id text not null,
        action_id text not null,
        ok integer not null,
        error_code text,
        started_at text not null,
        completed_at text not null,
        detail_json text not null
      );
      create index if not exists idx_control_execution_audit_scope
        on control_execution_audit (tenant_id, workspace_id, started_at);
    `);
  }

  async get(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    const row = this.database
      .prepare(
        "select * from tenant_connections where tenant_id = ? and workspace_id = ? and service = ? and connection_name = ?",
      )
      .get(this.principal.tenantId, this.principal.workspaceId, service, connectionName) as Record<string, unknown> | undefined;
    return row ? await this.toStored(row) : undefined;
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential): Promise<StoredConnection> {
    const existing = await this.get(service, connectionName);
    const now = new Date().toISOString();
    const id = existing?.id ?? randomUUID();
    const revision = (existing ? Number(existing.revision) : 0) + 1;
    const profile = credential.authType === "no_auth"
      ? { accountId: `${service}:public`, displayName: service, grantedScopes: [] }
      : credential.profile;
    const ciphertext = await this.secretCodec.encode(JSON.stringify(credential));
    this.database
      .prepare(
        `insert into tenant_connections
          (id, tenant_id, workspace_id, owner_id, service, connection_name,
           connector_definition_version, credential_ref, credential_ciphertext,
           profile_json, status, revision, visibility, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)
         on conflict(tenant_id, workspace_id, service, connection_name) do update set
           credential_ciphertext=excluded.credential_ciphertext,
           profile_json=excluded.profile_json, status='ready',
           revision=excluded.revision, updated_at=excluded.updated_at`,
      )
      .run(
        id,
        this.principal.tenantId,
        this.principal.workspaceId,
        this.principal.ownerId,
        service,
        connectionName,
        "1.0.0",
        `cred_${id}`,
        ciphertext,
        JSON.stringify(safeConnectionProfile(profile)),
        revision,
        "personal",
        existing ? String((existing as StoredConnection & { updatedAt?: string }).updatedAt ?? now) : now,
        now,
      );
    return { id, revision: String(revision), service, connectionName, credential };
  }

  async updateCredential(input: StoredConnection): Promise<boolean> {
    const result = this.database
      .prepare(
        `update tenant_connections set credential_ciphertext=?, profile_json=?, revision=?, updated_at=?
         where id=? and tenant_id=? and workspace_id=?`,
      )
      .run(
        await this.secretCodec.encode(JSON.stringify(input.credential)),
        JSON.stringify(safeConnectionProfile(input.credential.authType === "no_auth" ? {} : input.credential.profile)),
        Number(input.revision),
        new Date().toISOString(),
        input.id,
        this.principal.tenantId,
        this.principal.workspaceId,
      );
    return Number(result.changes) === 1;
  }

  async delete(service: string, connectionName: string): Promise<void> {
    this.database
      .prepare(
        "update tenant_connections set status='revoked', revision=revision+1, updated_at=? where tenant_id=? and workspace_id=? and service=? and connection_name=?",
      )
      .run(new Date().toISOString(), this.principal.tenantId, this.principal.workspaceId, service, connectionName);
  }

  async list(): Promise<StoredConnection[]> {
    const rows = this.database
      .prepare("select * from tenant_connections where tenant_id=? and workspace_id=? and status <> 'revoked' order by created_at")
      .all(this.principal.tenantId, this.principal.workspaceId) as Record<string, unknown>[];
    return Promise.all(rows.map((row) => this.toStored(row)));
  }

  async listRecords(): Promise<ConnectionRecord[]> {
    const rows = this.database
      .prepare("select * from tenant_connections where tenant_id=? and workspace_id=? order by created_at")
      .all(this.principal.tenantId, this.principal.workspaceId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      workspaceId: String(row.workspace_id),
      ownerId: String(row.owner_id),
      service: String(row.service),
      connectionName: String(row.connection_name),
      connectorDefinitionVersion: String(row.connector_definition_version),
      credentialRef: String(row.credential_ref),
      status: String(row.status) as ConnectionRecord["status"],
      revision: Number(row.revision),
      visibility: String(row.visibility) as ConnectionRecord["visibility"],
      profile: JSON.parse(String(row.profile_json)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  async connectionNameForId(id: string): Promise<{ service: string; connectionName: string } | undefined> {
    const row = this.database
      .prepare("select service, connection_name from tenant_connections where id=? and tenant_id=? and workspace_id=?")
      .get(id, this.principal.tenantId, this.principal.workspaceId) as Record<string, unknown> | undefined;
    return row ? { service: String(row.service), connectionName: String(row.connection_name) } : undefined;
  }

  private async toStored(row: Record<string, unknown>): Promise<StoredConnection> {
    return {
      id: String(row.id),
      revision: String(row.revision),
      service: String(row.service),
      connectionName: String(row.connection_name),
      credential: JSON.parse(await this.secretCodec.decode(String(row.credential_ciphertext))) as ResolvedCredential,
    };
  }
}

export class TenantRunLogStore implements IRunLogStore {
  private readonly database: DatabaseSync;
  private readonly principal: TenantPrincipal;

  constructor(database: DatabaseSync, principal: TenantPrincipal) {
    this.database = database;
    this.principal = principal;
  }

  async add(run: RunLog): Promise<RunLogWriteResult> {
    this.database
      .prepare(
        `insert into control_execution_audit
          (id, tenant_id, workspace_id, subject, invocation_id, connection_id,
           action_id, ok, error_code, started_at, completed_at, detail_json)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        this.principal.tenantId,
        this.principal.workspaceId,
        this.principal.subject,
        run.id,
        run.connectionId ?? "",
        run.actionId,
        run.ok ? 1 : 0,
        run.errorCode ?? null,
        run.startedAt,
        run.completedAt,
        JSON.stringify(redactSecrets({ input: run.inputSummary, output: run.outputSummary, error: run.errorMessage })),
      );
    return { retentionApplied: true };
  }

  async get(id: string): Promise<RunLog | undefined> {
    const row = this.database
      .prepare("select * from control_execution_audit where id=? and tenant_id=? and workspace_id=?")
      .get(id, this.principal.tenantId, this.principal.workspaceId) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : undefined;
  }

  async list(_input: RunLogListInput = {}): Promise<RunLogPage> {
    const rows = this.database
      .prepare("select * from control_execution_audit where tenant_id=? and workspace_id=? order by started_at desc limit 100")
      .all(this.principal.tenantId, this.principal.workspaceId) as Record<string, unknown>[];
    return { items: rows.map(rowToRun) };
  }
}

export class TenantOAuthClientConfigStore implements IOAuthClientConfigStore {
  private readonly database: DatabaseSync;
  private readonly principal: TenantPrincipal;
  private readonly secretCodec: ISecretCodec;

  constructor(database: DatabaseSync, principal: TenantPrincipal, secretCodec: ISecretCodec) {
    this.database = database;
    this.principal = principal;
    this.secretCodec = secretCodec;
    this.database.exec(`
      create table if not exists tenant_oauth_client_configs (
        tenant_id text not null,
        workspace_id text not null,
        service text not null,
        value_ciphertext text not null,
        updated_at text not null,
        primary key (tenant_id, workspace_id, service)
      );
    `);
  }

  async get(service: string): Promise<OAuthClientConfig | undefined> {
    const row = this.database
      .prepare("select value_ciphertext from tenant_oauth_client_configs where tenant_id=? and workspace_id=? and service=?")
      .get(this.principal.tenantId, this.principal.workspaceId, service) as Record<string, unknown> | undefined;
    return row
      ? JSON.parse(await this.secretCodec.decode(String(row.value_ciphertext))) as OAuthClientConfig
      : undefined;
  }

  async set(config: OAuthClientConfig): Promise<void> {
    this.database
      .prepare(
        `insert into tenant_oauth_client_configs
          (tenant_id, workspace_id, service, value_ciphertext, updated_at)
         values (?, ?, ?, ?, ?)
         on conflict(tenant_id, workspace_id, service) do update set
           value_ciphertext=excluded.value_ciphertext, updated_at=excluded.updated_at`,
      )
      .run(
        this.principal.tenantId,
        this.principal.workspaceId,
        config.service,
        await this.secretCodec.encode(JSON.stringify(config)),
        new Date().toISOString(),
      );
  }

  async delete(service: string): Promise<void> {
    this.database
      .prepare("delete from tenant_oauth_client_configs where tenant_id=? and workspace_id=? and service=?")
      .run(this.principal.tenantId, this.principal.workspaceId, service);
  }

  async list(): Promise<OAuthClientConfig[]> {
    const rows = this.database
      .prepare("select value_ciphertext from tenant_oauth_client_configs where tenant_id=? and workspace_id=?")
      .all(this.principal.tenantId, this.principal.workspaceId) as Record<string, unknown>[];
    return Promise.all(rows.map(async (row) =>
      JSON.parse(await this.secretCodec.decode(String(row.value_ciphertext))) as OAuthClientConfig));
  }
}

export class TenantOAuthStateStore implements IOAuthStateStore {
  private readonly database: DatabaseSync;
  private readonly principal: TenantPrincipal;
  private readonly secretCodec: ISecretCodec;

  constructor(database: DatabaseSync, principal: TenantPrincipal, secretCodec: ISecretCodec) {
    this.database = database;
    this.principal = principal;
    this.secretCodec = secretCodec;
    this.database.exec(`
      create table if not exists tenant_oauth_states (
        state text primary key,
        tenant_id text not null,
        workspace_id text not null,
        value_ciphertext text not null,
        created_at text not null
      );
      create index if not exists idx_tenant_oauth_states_expiry on tenant_oauth_states (tenant_id, workspace_id, created_at);
    `);
  }

  async set(state: OAuthAuthorizationState): Promise<void> {
    this.database
      .prepare(
        "insert into tenant_oauth_states (state, tenant_id, workspace_id, value_ciphertext, created_at) values (?, ?, ?, ?, ?)",
      )
      .run(
        state.state,
        this.principal.tenantId,
        this.principal.workspaceId,
        await this.secretCodec.encode(JSON.stringify(state)),
        state.createdAt,
      );
  }

  async take(state: string): Promise<OAuthAuthorizationState | undefined> {
    const row = this.database
      .prepare("select value_ciphertext from tenant_oauth_states where state=? and tenant_id=? and workspace_id=?")
      .get(state, this.principal.tenantId, this.principal.workspaceId) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    this.database
      .prepare("delete from tenant_oauth_states where state=? and tenant_id=? and workspace_id=?")
      .run(state, this.principal.tenantId, this.principal.workspaceId);
    return JSON.parse(await this.secretCodec.decode(String(row.value_ciphertext))) as OAuthAuthorizationState;
  }
}

function rowToRun(row: Record<string, unknown>): RunLog {
  const detail = JSON.parse(String(row.detail_json)) as Record<string, unknown>;
  return {
    id: String(row.id),
    service: String(row.action_id).split(".")[0] ?? "",
    actionId: String(row.action_id),
    caller: "http",
    startedAt: String(row.started_at),
    completedAt: String(row.completed_at),
    durationMs: new Date(String(row.completed_at)).getTime() - new Date(String(row.started_at)).getTime(),
    ok: Boolean(row.ok),
    connectionId: String(row.connection_id) || undefined,
    inputSummary: detail.input,
    outputSummary: detail.output,
    errorCode: row.error_code ? String(row.error_code) : undefined,
    errorMessage: typeof detail.error === "string" ? detail.error : undefined,
  };
}
