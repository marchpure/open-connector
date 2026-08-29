import type { ConnectionLeaseClaims, TenantPrincipal } from "./types.ts";
import type { DatabaseSync } from "node:sqlite";

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export class LeaseError extends Error {
  readonly code: "invalid_lease" | "lease_expired" | "lease_revoked" | "lease_scope_denied";

  constructor(code: LeaseError["code"], message: string) {
    super(message);
    this.name = "LeaseError";
    this.code = code;
  }
}

export class ConnectionLeaseService {
  private readonly database: DatabaseSync;
  private readonly now: () => Date;
  private readonly signingKey: string;

  constructor(database: DatabaseSync, now: () => Date = () => new Date()) {
    this.database = database;
    this.now = now;
    this.database.exec(`
      create table if not exists connection_lease_signing_key (
        singleton integer primary key check (singleton = 1),
        signing_key text not null
      );
      create table if not exists connection_leases (
        token_hash text primary key,
        jti text not null unique,
        tenant_id text not null,
        workspace_id text not null,
        subject text not null,
        owner_id text,
        invocation_id text not null,
        audience text not null,
        connection_ids_json text not null,
        connection_revisions_json text,
        allowed_actions_json text not null,
        issued_at text not null,
        expires_at text not null,
        revoked_at text
      );
      create index if not exists idx_connection_leases_scope
        on connection_leases (tenant_id, workspace_id, expires_at);
    `);
    ensureConnectionRevisionColumn(this.database);
    ensureOwnerIdColumn(this.database);
    this.database
      .prepare("insert or ignore into connection_lease_signing_key (singleton, signing_key) values (1, ?)")
      .run(randomBytes(32).toString("base64url"));
    const key = this.database
      .prepare("select signing_key from connection_lease_signing_key where singleton=1")
      .get() as { signing_key?: unknown } | undefined;
    if (!key?.signing_key) throw new Error("Connection lease signing key is unavailable.");
    this.signingKey = String(key.signing_key);
  }

  issue(
    principal: TenantPrincipal,
    input: {
      connectionIds: string[];
      connectionRevisions?: Record<string, number>;
      allowedActions: string[];
      invocationId: string;
      audience: string;
      ttlSeconds?: number;
    },
  ): { token: string; claims: ConnectionLeaseClaims } {
    const connectionIds = uniqueNonEmpty(input.connectionIds);
    const allowedActions = uniqueNonEmpty(input.allowedActions);
    if (connectionIds.length === 0 || allowedActions.length === 0) {
      throw new LeaseError("invalid_lease", "connection_ids and allowed_actions must both be non-empty.");
    }
    const connectionRevisions = normalizeConnectionRevisions(connectionIds, input.connectionRevisions);
    if (!input.invocationId.trim() || !input.audience.trim()) {
      throw new LeaseError("invalid_lease", "invocation_id and audience are required.");
    }
    const ttlSeconds = input.ttlSeconds ?? 300;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) {
      throw new LeaseError("invalid_lease", "Lease TTL must be between 1 and 900 seconds.");
    }
    const issued = this.now();
    const expires = new Date(issued.getTime() + ttlSeconds * 1000);
    const claims: ConnectionLeaseClaims = {
      tenantId: principal.tenantId,
      workspaceId: principal.workspaceId,
      subject: principal.subject,
      ownerId: principal.ownerId,
      invocationId: input.invocationId,
      audience: input.audience,
      connectionIds,
      connectionRevisions,
      allowedActions,
      issuedAt: issued.toISOString(),
      expiresAt: expires.toISOString(),
      jti: randomUUID(),
    };
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const token = `cl_${payload}.${signLease(payload, this.signingKey)}`;
    this.database
      .prepare(
        `insert into connection_leases
          (token_hash, jti, tenant_id, workspace_id, subject, invocation_id, audience,
           owner_id, connection_ids_json, connection_revisions_json, allowed_actions_json, issued_at, expires_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hashToken(token),
        claims.jti,
        claims.tenantId,
        claims.workspaceId,
        claims.subject,
        claims.invocationId,
        claims.audience,
        claims.ownerId,
        JSON.stringify(claims.connectionIds),
        claims.connectionRevisions ? JSON.stringify(claims.connectionRevisions) : null,
        JSON.stringify(claims.allowedActions),
        claims.issuedAt,
        claims.expiresAt,
      );
    return { token, claims };
  }

  verify(
    token: string,
    principal: TenantPrincipal,
    expected: {
      connectionId: string;
      connectionRevision?: number;
      actionId: string;
      audience: string;
      invocationId: string;
    },
  ): ConnectionLeaseClaims {
    const claims = this.verifyConnection(token, principal, expected);
    if (!claims.allowedActions.includes(expected.actionId)) {
      throw new LeaseError("lease_scope_denied", "Connection lease does not grant this invocation.");
    }
    return claims;
  }

  verifyConnection(
    token: string,
    principal: TenantPrincipal,
    expected: {
      connectionId: string;
      connectionRevision?: number;
      audience: string;
      invocationId: string;
    },
  ): ConnectionLeaseClaims {
    const claims = this.resolve(token, expected);
    if (
      claims.tenantId !== principal.tenantId ||
      claims.workspaceId !== principal.workspaceId ||
      claims.subject !== principal.subject ||
      claims.ownerId !== principal.ownerId ||
      !claims.connectionIds.includes(expected.connectionId) ||
      (expected.connectionRevision !== undefined &&
        claims.connectionRevisions?.[expected.connectionId] !== expected.connectionRevision)
    ) {
      throw new LeaseError("lease_scope_denied", "Connection lease does not grant this invocation.");
    }
    return claims;
  }

  resolve(
    token: string,
    expected: {
      audience: string;
      invocationId: string;
    },
  ): ConnectionLeaseClaims {
    const claims = readSignedLease(token, this.signingKey);
    if (!claims) {
      throw new LeaseError("invalid_lease", "Malformed connection lease.");
    }
    const tokenHash = hashToken(token);
    const row = this.database.prepare("select * from connection_leases where token_hash = ?").get(tokenHash) as
      | Record<string, unknown>
      | undefined;
    if (!row || !equalHash(String(row.token_hash), tokenHash)) {
      throw new LeaseError("invalid_lease", "Connection lease was not found.");
    }
    if (row.revoked_at) {
      throw new LeaseError("lease_revoked", "Connection lease was revoked.");
    }
    if (new Date(String(row.expires_at)).getTime() <= this.now().getTime()) {
      throw new LeaseError("lease_expired", "Connection lease expired.");
    }
    if (JSON.stringify(claims) !== JSON.stringify(rowToClaims(row))) {
      throw new LeaseError("invalid_lease", "Connection lease claims do not match stored state.");
    }
    if (claims.audience !== expected.audience || claims.invocationId !== expected.invocationId) {
      throw new LeaseError("lease_scope_denied", "Connection lease does not grant this invocation.");
    }
    return claims;
  }

  revoke(jti: string, principal: TenantPrincipal): boolean {
    const result = this.database
      .prepare(
        "update connection_leases set revoked_at = ? where jti = ? and tenant_id = ? and workspace_id = ? and revoked_at is null",
      )
      .run(this.now().toISOString(), jti, principal.tenantId, principal.workspaceId);
    return Number(result.changes) === 1;
  }

  revokeForConnection(connectionId: string, principal: TenantPrincipal): number {
    const pattern = `%"${connectionId.replaceAll("%", "\\%").replaceAll("_", "\\_")}"%`;
    const result = this.database
      .prepare(
        `update connection_leases set revoked_at = ?
          where tenant_id = ? and workspace_id = ? and revoked_at is null
            and connection_ids_json like ? escape '\\'`,
      )
      .run(this.now().toISOString(), principal.tenantId, principal.workspaceId, pattern);
    return Number(result.changes);
  }
}

function ensureConnectionRevisionColumn(database: DatabaseSync): void {
  const columns = database.prepare("pragma table_info(connection_leases)").all() as Array<{ name?: unknown }>;
  if (!columns.some((column) => column.name === "connection_revisions_json")) {
    database.exec("alter table connection_leases add column connection_revisions_json text");
  }
}

function ensureOwnerIdColumn(database: DatabaseSync): void {
  const columns = database.prepare("pragma table_info(connection_leases)").all() as Array<{ name?: unknown }>;
  if (!columns.some((column) => column.name === "owner_id")) {
    database.exec("alter table connection_leases add column owner_id text");
  }
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function signLease(payload: string, signingKey: string): string {
  return createHmac("sha256", signingKey).update(payload).digest("base64url");
}

function readSignedLease(token: string, signingKey: string): ConnectionLeaseClaims | undefined {
  if (!token.startsWith("cl_")) return undefined;
  const [payload, signature, ...extra] = token.slice(3).split(".");
  if (!payload || !signature || extra.length > 0 || !equalHash(signature, signLease(payload, signingKey))) {
    return undefined;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<ConnectionLeaseClaims>;
    if (
      typeof claims.tenantId !== "string" ||
      typeof claims.workspaceId !== "string" ||
      typeof claims.subject !== "string" ||
      typeof claims.ownerId !== "string" ||
      typeof claims.invocationId !== "string" ||
      typeof claims.audience !== "string" ||
      !Array.isArray(claims.connectionIds) ||
      !claims.connectionIds.every((value) => typeof value === "string") ||
      !Array.isArray(claims.allowedActions) ||
      !claims.allowedActions.every((value) => typeof value === "string") ||
      typeof claims.issuedAt !== "string" ||
      typeof claims.expiresAt !== "string" ||
      typeof claims.jti !== "string"
    ) {
      return undefined;
    }
    return claims as ConnectionLeaseClaims;
  } catch {
    return undefined;
  }
}

function rowToClaims(row: Record<string, unknown>): ConnectionLeaseClaims {
  const connectionRevisions = row.connection_revisions_json
    ? (JSON.parse(String(row.connection_revisions_json)) as Record<string, number>)
    : undefined;
  return {
    tenantId: String(row.tenant_id),
    workspaceId: String(row.workspace_id),
    subject: String(row.subject),
    ownerId: String(row.owner_id ?? row.subject),
    invocationId: String(row.invocation_id),
    audience: String(row.audience),
    connectionIds: JSON.parse(String(row.connection_ids_json)) as string[],
    connectionRevisions,
    allowedActions: JSON.parse(String(row.allowed_actions_json)) as string[],
    issuedAt: String(row.issued_at),
    expiresAt: String(row.expires_at),
    jti: String(row.jti),
  };
}

function normalizeConnectionRevisions(
  connectionIds: string[],
  revisions: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!revisions) return undefined;
  const output: Record<string, number> = {};
  for (const connectionId of connectionIds) {
    const revision = revisions[connectionId];
    if (Number.isInteger(revision) && revision >= 0) output[connectionId] = revision;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}
