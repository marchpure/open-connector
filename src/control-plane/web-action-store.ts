import type { ActionDefinition, CredentialProfile, ResolvedCredential } from "../core/types.ts";
import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { TenantPrincipal } from "./types.ts";
import type { WebCandidate } from "./web-discovery.ts";
import type { DatabaseSync } from "node:sqlite";

import { randomUUID } from "node:crypto";
import { redactSecrets, safeConnectionProfile } from "./redaction.ts";

export type WebAuthProfile =
  | { type: "none" }
  | { type: "api_key"; header: string }
  | { type: "bearer" }
  | { type: "cookie" };

export interface WebActionDefinition extends ActionDefinition {
  service: "web_api";
  connectionId: string;
  origin: string;
  method: string;
  path: string;
  readOnly: boolean;
  enabled: boolean;
  authentication: WebAuthProfile;
  parameterSources: Record<string, "path" | "query" | "body">;
  pagination: { supported: boolean; maxPages: number };
  rateLimit: { maxRequestsPerMinute: number };
  timeoutMs: number;
  idempotency: { required: boolean; header: "Idempotency-Key" };
  sideEffect: { confirmed: boolean; defaultDisabled: boolean };
  credentialRef: string;
}

export interface ConfirmedWebActionInput {
  candidate: WebCandidate;
  operationId: string;
  connectionName?: string;
  authentication: WebAuthProfile;
  credential?: ResolvedCredential;
  parameterSources?: Record<string, "path" | "query" | "body">;
  pagination?: { supported: boolean; maxPages: number };
  rateLimit?: { maxRequestsPerMinute: number };
  timeoutMs?: number;
  sideEffectConfirmed?: boolean;
  enabled?: boolean;
}

export function webCredentialFromInput(authentication: WebAuthProfile, value: unknown): ResolvedCredential | undefined {
  if (authentication.type === "none") return undefined;
  const body = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const profile: CredentialProfile = {
    accountId: typeof body.accountId === "string" && body.accountId.trim() ? body.accountId : "web-account",
    displayName: typeof body.displayName === "string" && body.displayName.trim() ? body.displayName : "Web Account",
    grantedScopes: Array.isArray(body.grantedScopes) ? body.grantedScopes.map(String) : [],
  };
  const secret = typeof body.secret === "string" ? body.secret.trim() : "";
  if (!secret) throw new WebActionError("web_credential_invalid", "Web Action credential secret is required.");
  if (authentication.type === "bearer") {
    return {
      authType: "oauth2",
      accessToken: secret,
      tokenType: "Bearer",
      profile,
      metadata: {},
    };
  }
  if (authentication.type === "cookie") {
    return {
      authType: "custom_credential",
      values: { cookie: secret },
      profile,
      metadata: {},
    };
  }
  return {
    authType: "api_key",
    apiKey: secret,
    values: { secret },
    profile,
    metadata: {},
  };
}

export class WebActionError extends Error {
  readonly code:
    | "invalid_web_action"
    | "web_action_not_found"
    | "web_action_disabled"
    | "side_effect_confirmation_required"
    | "idempotency_required"
    | "web_credential_invalid";

  constructor(code: WebActionError["code"], message: string) {
    super(message);
    this.name = "WebActionError";
    this.code = code;
  }
}

export class TenantWebActionStore {
  private readonly database: DatabaseSync;
  private readonly principal: TenantPrincipal;
  private readonly secretCodec: ISecretCodec;

  constructor(database: DatabaseSync, principal: TenantPrincipal, secretCodec: ISecretCodec) {
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
      create table if not exists connection_acl (
        connection_id text not null,
        tenant_id text not null,
        workspace_id text not null,
        subject text not null,
        permission text not null check (permission in ('use')),
        created_at text not null,
        primary key (connection_id, subject, permission)
      );
      create table if not exists control_execution_audit (
        id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        subject text not null,
        invocation_id text not null,
        caller text,
        connection_id text not null,
        action_id text not null,
        ok integer not null,
        error_code text,
        started_at text not null,
        completed_at text not null,
        detail_json text not null
      );
      create table if not exists web_connections (
        id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        owner_id text not null,
        origin text not null,
        connection_name text not null,
        credential_ref text not null,
        credential_ciphertext text not null,
        profile_json text not null,
        status text not null,
        revision integer not null,
        created_at text not null,
        updated_at text not null,
        unique (tenant_id, workspace_id, origin, connection_name)
      );
      create table if not exists web_actions (
        id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        connection_id text not null,
        definition_ciphertext text not null,
        created_at text not null,
        updated_at text not null,
        foreign key (connection_id) references web_connections(id)
      );
      create index if not exists idx_web_actions_scope
        on web_actions (tenant_id, workspace_id, connection_id);
    `);
  }

  async confirm(input: ConfirmedWebActionInput): Promise<WebActionDefinition> {
    validateCandidate(input.candidate);
    const write = !input.candidate.readOnly;
    if (write && input.sideEffectConfirmed !== true) {
      throw new WebActionError("side_effect_confirmation_required", "Write Web Actions require explicit confirmation.");
    }
    const credential = normalizeCredential(input.authentication, input.credential);
    const connectionName = input.connectionName?.trim() || "default";
    const existing = this.database
      .prepare(
        `select * from web_connections
         where tenant_id=? and workspace_id=? and origin=? and connection_name=? and status='ready'`,
      )
      .get(this.principal.tenantId, this.principal.workspaceId, input.candidate.origin, connectionName) as
      | Record<string, unknown>
      | undefined;
    const now = new Date().toISOString();
    const connectionId = existing?.id ? String(existing.id) : randomUUID();
    const credentialRef = `web_cred_${connectionId}`;
    const revision = Number(existing?.revision ?? 0) + 1;
    const profile = credential.authType === "no_auth" ? publicProfile(input.candidate.origin) : credential.profile;
    const credentialCiphertext = await this.secretCodec.encode(JSON.stringify(credential));
    this.database
      .prepare(
        `insert into web_connections
          (id, tenant_id, workspace_id, owner_id, origin, connection_name, credential_ref,
           credential_ciphertext, profile_json, status, revision, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)
         on conflict(tenant_id, workspace_id, origin, connection_name) do update set
           credential_ref=excluded.credential_ref, credential_ciphertext=excluded.credential_ciphertext,
           profile_json=excluded.profile_json, status='ready', revision=excluded.revision, updated_at=excluded.updated_at`,
      )
      .run(
        connectionId,
        this.principal.tenantId,
        this.principal.workspaceId,
        this.principal.ownerId,
        input.candidate.origin,
        connectionName,
        credentialRef,
        credentialCiphertext,
        JSON.stringify(safeConnectionProfile(profile)),
        revision,
        String(existing?.created_at ?? now),
        now,
      );

    const actionId = `web_api.${randomUUID()}`;
    const parameterSources = input.parameterSources ?? inferParameterSources(input.candidate);
    const pagination = input.pagination ?? { supported: input.candidate.method === "GET", maxPages: 10 };
    const rateLimit = input.rateLimit ?? { maxRequestsPerMinute: 60 };
    const timeoutMs = input.timeoutMs ?? 30_000;
    if (!Number.isInteger(pagination.maxPages) || pagination.maxPages < 1 || pagination.maxPages > 100) {
      throw new WebActionError("invalid_web_action", "Pagination must be between 1 and 100 pages.");
    }
    if (!Number.isInteger(rateLimit.maxRequestsPerMinute) || rateLimit.maxRequestsPerMinute < 1) {
      throw new WebActionError("invalid_web_action", "Rate limit must be a positive integer.");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new WebActionError("invalid_web_action", "Timeout must be between 100 and 30000 milliseconds.");
    }
    const definition: WebActionDefinition = {
      id: actionId,
      service: "web_api",
      name: input.operationId,
      description: `Confirmed ${input.candidate.method} ${input.candidate.path} Web Action.`,
      requiredScopes: [],
      providerPermissions: [],
      inputSchema: {
        type: "object",
        properties: {
          pathParams: { type: "object", properties: pathProperties(input.candidate.path) },
          query: input.candidate.querySchema ?? { type: "object", properties: {} },
          body: input.candidate.requestSchema ?? { type: "object", properties: {} },
          confirmed: { type: "boolean" },
          idempotencyKey: { type: "string" },
          pagination: { type: "object", properties: { maxPages: { type: "integer", minimum: 1, maximum: 100 } } },
        },
      },
      outputSchema: input.candidate.responseSchema ?? { type: "object" },
      connectionId,
      origin: input.candidate.origin,
      method: input.candidate.method,
      path: input.candidate.path,
      readOnly: input.candidate.readOnly,
      enabled: input.enabled ?? input.candidate.readOnly,
      authentication: input.authentication,
      parameterSources,
      pagination,
      rateLimit,
      timeoutMs,
      idempotency: { required: write, header: "Idempotency-Key" },
      sideEffect: { confirmed: input.sideEffectConfirmed === true, defaultDisabled: write },
      credentialRef,
    };
    const actionCiphertext = await this.secretCodec.encode(JSON.stringify(definition));
    this.database
      .prepare(
        `insert into web_actions
          (id, tenant_id, workspace_id, connection_id, definition_ciphertext, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set definition_ciphertext=excluded.definition_ciphertext, updated_at=excluded.updated_at`,
      )
      .run(
        definition.id,
        this.principal.tenantId,
        this.principal.workspaceId,
        connectionId,
        actionCiphertext,
        now,
        now,
      );
    this.ensureLeaseConnection(connectionId, connectionName, input.candidate.origin, profile, revision, now);
    return definition;
  }

  async get(actionId: string): Promise<WebActionDefinition | undefined> {
    const row = this.database
      .prepare(
        `select definition_ciphertext from web_actions
         where id=? and tenant_id=? and workspace_id=?`,
      )
      .get(actionId, this.principal.tenantId, this.principal.workspaceId) as Record<string, unknown> | undefined;
    return row
      ? (JSON.parse(await this.secretCodec.decode(String(row.definition_ciphertext))) as WebActionDefinition)
      : undefined;
  }

  async list(connectionId?: string): Promise<WebActionDefinition[]> {
    const rows = this.database
      .prepare(
        `select definition_ciphertext from web_actions
         where tenant_id=? and workspace_id=? ${connectionId ? "and connection_id=?" : ""}
         order by created_at`,
      )
      .all(
        ...(connectionId
          ? [this.principal.tenantId, this.principal.workspaceId, connectionId]
          : [this.principal.tenantId, this.principal.workspaceId]),
      ) as Record<string, unknown>[];
    return Promise.all(
      rows.map(
        async (row) =>
          JSON.parse(await this.secretCodec.decode(String(row.definition_ciphertext))) as WebActionDefinition,
      ),
    );
  }

  async credential(action: WebActionDefinition): Promise<ResolvedCredential> {
    const row = this.database
      .prepare(
        `select credential_ciphertext from web_connections
         where id=? and tenant_id=? and workspace_id=? and status='ready'`,
      )
      .get(action.connectionId, this.principal.tenantId, this.principal.workspaceId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new WebActionError("web_credential_invalid", "Web Action credential is unavailable.");
    return JSON.parse(await this.secretCodec.decode(String(row.credential_ciphertext))) as ResolvedCredential;
  }

  actionIds(connectionId: string): string[] {
    return (
      this.database
        .prepare(
          `select id from web_actions
           where tenant_id=? and workspace_id=? and connection_id=?`,
        )
        .all(this.principal.tenantId, this.principal.workspaceId, connectionId) as Array<{ id?: unknown }>
    ).map((row) => String(row.id));
  }

  connectionForAction(actionId: string): string | undefined {
    const row = this.database
      .prepare(
        `select connection_id from web_actions
         where id=? and tenant_id=? and workspace_id=?`,
      )
      .get(actionId, this.principal.tenantId, this.principal.workspaceId) as { connection_id?: unknown } | undefined;
    return row?.connection_id ? String(row.connection_id) : undefined;
  }

  audit(event: string, detail: Record<string, unknown>, actionId?: string, invocationId?: string): void {
    this.database.exec(`
      create table if not exists web_action_audit (
        id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        subject text not null,
        invocation_id text,
        action_id text,
        event text not null,
        detail_json text not null,
        created_at text not null
      );
    `);
    this.database
      .prepare(
        `insert into web_action_audit
          (id, tenant_id, workspace_id, subject, invocation_id, action_id, event, detail_json, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        this.principal.tenantId,
        this.principal.workspaceId,
        this.principal.subject,
        invocationId ?? null,
        actionId ?? null,
        event,
        JSON.stringify(redactSecrets(detail)),
        new Date().toISOString(),
      );
  }

  revokeConnection(connectionId: string): void {
    this.database
      .prepare(
        `update web_connections set status='revoked', revision=revision+1, updated_at=?
         where id=? and tenant_id=? and workspace_id=?`,
      )
      .run(new Date().toISOString(), connectionId, this.principal.tenantId, this.principal.workspaceId);
  }

  private ensureLeaseConnection(
    id: string,
    connectionName: string,
    origin: string,
    profile: CredentialProfile,
    revision: number,
    now: string,
  ): void {
    this.database
      .prepare(
        `insert into tenant_connections
          (id, tenant_id, workspace_id, owner_id, service, connection_name,
           connector_definition_version, credential_ref, credential_ciphertext,
           profile_json, status, revision, visibility, created_at, updated_at)
         values (?, ?, ?, ?, 'web_api', ?, 'web-1', ?, ?, ?, 'ready', ?, 'personal', ?, ?)
         on conflict(id) do update set profile_json=excluded.profile_json, revision=excluded.revision, updated_at=excluded.updated_at`,
      )
      .run(
        id,
        this.principal.tenantId,
        this.principal.workspaceId,
        this.principal.ownerId,
        connectionName,
        `web_cred_${id}`,
        `enc:web-credential-ref:${id}`,
        JSON.stringify(
          safeConnectionProfile({ accountId: origin, displayName: origin, grantedScopes: profile.grantedScopes }),
        ),
        revision,
        now,
        now,
      );
  }
}

function validateCandidate(candidate: WebCandidate): void {
  if (
    !isHttpsOrigin(candidate.origin) ||
    !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(candidate.method) ||
    !candidate.path.startsWith("/") ||
    candidate.path.includes("?") ||
    candidate.path.includes("#")
  ) {
    throw new WebActionError("invalid_web_action", "Web Action candidate is not a valid same-origin API contract.");
  }
}

function inferParameterSources(candidate: WebCandidate): Record<string, "path" | "query" | "body"> {
  const sources: Record<string, "path" | "query" | "body"> = {};
  for (const match of candidate.path.matchAll(/\{([^}]+)\}/g)) sources[match[1]] = "path";
  if (candidate.requestSchema && typeof candidate.requestSchema === "object") {
    for (const key of Object.keys((candidate.requestSchema.properties as Record<string, unknown>) ?? {})) {
      sources[key] ??= candidate.method === "GET" ? "query" : "body";
    }
  }
  return sources;
}

function pathProperties(path: string): Record<string, unknown> {
  return Object.fromEntries([...path.matchAll(/\{([^}]+)\}/g)].map(([_, name]) => [name, { type: "string" }]));
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash
    );
  } catch {
    return false;
  }
}

function normalizeCredential(auth: WebAuthProfile, credential?: ResolvedCredential): ResolvedCredential {
  if (auth.type === "none") return { authType: "no_auth" };
  if (!credential || credential.authType === "no_auth") {
    throw new WebActionError("web_credential_invalid", "An encrypted Web Action credential is required.");
  }
  if (auth.type === "bearer" && credential.authType !== "oauth2") {
    if (credential.authType === "api_key") return { ...credential, apiKey: credential.apiKey };
    throw new WebActionError("web_credential_invalid", "Bearer authentication requires a secret credential.");
  }
  if (auth.type === "api_key" && !["api_key", "custom_credential"].includes(credential.authType)) {
    throw new WebActionError("web_credential_invalid", "API-key authentication requires a secret credential.");
  }
  if (auth.type === "cookie" && credential.authType !== "custom_credential") {
    throw new WebActionError("web_credential_invalid", "Cookie authentication requires a cookie credential.");
  }
  return credential;
}

function publicProfile(origin: string): CredentialProfile {
  return { accountId: origin, displayName: origin, grantedScopes: [] };
}

export function publicWebAction(definition: WebActionDefinition): Record<string, unknown> {
  return redactSecrets({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    connectionId: definition.connectionId,
    origin: definition.origin,
    method: definition.method,
    path: definition.path,
    readOnly: definition.readOnly,
    enabled: definition.enabled,
    authentication: definition.authentication,
    parameterSources: definition.parameterSources,
    pagination: definition.pagination,
    rateLimit: definition.rateLimit,
    timeoutMs: definition.timeoutMs,
    idempotency: definition.idempotency,
    sideEffect: definition.sideEffect,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    credentialRef: definition.credentialRef,
  }) as Record<string, unknown>;
}
