import type { ResolvedCredential } from "../core/types.ts";
import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { RestDefinition, RestOperation } from "./rest-adapter.ts";
import type { WebEgressPolicy } from "./service.ts";
import type { DatabaseSync } from "node:sqlite";

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { assertPublicHttpUrl } from "../core/request.ts";

export interface WebObservation {
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestSample?: unknown;
  requestQuerySample?: Record<string, string>;
  responseStatus: number;
  responseContentType: string;
  responseSample?: unknown;
  redirectUrl?: string;
}

export interface WebCandidate {
  id: string;
  origin: string;
  method: string;
  path: string;
  readOnly: boolean;
  requestSchema?: Record<string, unknown>;
  querySchema?: Record<string, unknown>;
  responseSchema?: Record<string, unknown>;
}

export class WebDiscoveryError extends Error {
  readonly code:
    | "invalid_origin"
    | "session_not_found"
    | "sensitive_observation"
    | "cross_origin"
    | "not_api"
    | "confirmation_mismatch";

  constructor(code: WebDiscoveryError["code"], message: string) {
    super(message);
    this.name = "WebDiscoveryError";
    this.code = code;
  }
}

export class TenantWebDiscoveryStore {
  private readonly database: DatabaseSync;
  private readonly principal: { tenantId: string; workspaceId: string; subject: string };
  private readonly secretCodec: ISecretCodec;
  private readonly webEgress?: WebEgressPolicy;

  constructor(
    database: DatabaseSync,
    principal: { tenantId: string; workspaceId: string; subject: string },
    secretCodec: ISecretCodec,
    webEgress?: WebEgressPolicy,
  ) {
    this.database = database;
    this.principal = principal;
    this.secretCodec = secretCodec;
    this.webEgress = webEgress;
    this.database.exec(`
      create table if not exists web_discovery_sessions (
        id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        subject text not null,
        origin text not null,
        worker_token_hash text not null,
        created_at text not null,
        expires_at text not null
      );
      create table if not exists web_discovery_candidates (
        id text primary key,
        session_id text not null,
        tenant_id text not null,
        workspace_id text not null,
        candidate_ciphertext text not null,
        confirmed_at text,
        created_at text not null,
        foreign key (session_id) references web_discovery_sessions(id)
      );
      create index if not exists idx_web_discovery_scope
        on web_discovery_sessions (tenant_id, workspace_id, subject);
      create table if not exists web_discovery_audit (
        id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        subject text not null,
        session_id text,
        candidate_id text,
        event text not null,
        detail_json text not null,
        created_at text not null
      );
      create index if not exists idx_web_discovery_audit_scope
        on web_discovery_audit (tenant_id, workspace_id, created_at);
      create table if not exists web_discovery_credentials (
        session_id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        subject text not null,
        credential_ciphertext text not null,
        created_at text not null,
        foreign key (session_id) references web_discovery_sessions(id)
      );
    `);
  }

  async start(input: { origin: string }): Promise<{ id: string; workerToken: string; expiresAt: string }> {
    const origin = normalizeOrigin(input.origin, this.webEgress);
    const id = randomUUID();
    const workerToken = `wd_${randomBytes(32).toString("base64url")}`;
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 15 * 60_000).toISOString();
    const tokenHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(workerToken));
    this.database
      .prepare(
        `insert into web_discovery_sessions
          (id, tenant_id, workspace_id, subject, origin, worker_token_hash, created_at, expires_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.principal.tenantId,
        this.principal.workspaceId,
        this.principal.subject,
        origin,
        Buffer.from(tokenHash).toString("hex"),
        createdAt.toISOString(),
        expiresAt,
      );
    return { id, workerToken, expiresAt };
  }

  async observe(sessionId: string, workerToken: string, observation: WebObservation): Promise<WebCandidate> {
    const session = this.session(sessionId, workerToken);
    const url = new URL(observation.url);
    if (url.origin !== session.origin) {
      throw new WebDiscoveryError("cross_origin", "Observed request is outside the approved origin.");
    }
    if (observation.redirectUrl && new URL(observation.redirectUrl, url).origin !== session.origin) {
      throw new WebDiscoveryError("cross_origin", "Cross-origin redirects are not allowed during discovery.");
    }
    if (
      Object.keys(observation.requestHeaders).some(isSensitiveHeader) ||
      hasSensitiveKeys(observation.requestSample) ||
      hasSensitiveKeys(observation.requestQuerySample) ||
      hasSensitiveKeys(observation.responseSample)
    ) {
      throw new WebDiscoveryError("sensitive_observation", "Worker observations must not contain credentials.");
    }
    if (!observation.responseContentType.toLowerCase().includes("json")) {
      throw new WebDiscoveryError("not_api", "Only JSON API traffic can become a discovery candidate.");
    }
    const method = observation.method.toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw new WebDiscoveryError("not_api", "Observed request method is not supported.");
    }
    const candidate: WebCandidate = {
      id: randomUUID(),
      origin: session.origin,
      method,
      path: inferPath(url.pathname),
      readOnly: method === "GET",
      requestSchema: inferSchema(observation.requestSample),
      querySchema: inferSchema(observation.requestQuerySample),
      responseSchema: inferSchema(observation.responseSample),
    };
    this.database
      .prepare(
        `insert into web_discovery_candidates
          (id, session_id, tenant_id, workspace_id, candidate_ciphertext, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.id,
        sessionId,
        this.principal.tenantId,
        this.principal.workspaceId,
        await this.secretCodec.encode(JSON.stringify(candidate)),
        new Date().toISOString(),
      );
    this.audit(sessionId, candidate.id, "candidate", {
      origin: candidate.origin,
      method: candidate.method,
      path: candidate.path,
      readOnly: candidate.readOnly,
    });
    return candidate;
  }

  async listCandidates(sessionId: string): Promise<WebCandidate[]> {
    this.session(sessionId);
    const rows = this.database
      .prepare(
        `select candidate_ciphertext from web_discovery_candidates
          where session_id=? and tenant_id=? and workspace_id=? order by created_at`,
      )
      .all(sessionId, this.principal.tenantId, this.principal.workspaceId) as Record<string, unknown>[];
    return Promise.all(
      rows.map(
        async (row) => JSON.parse(await this.secretCodec.decode(String(row.candidate_ciphertext))) as WebCandidate,
      ),
    );
  }

  async saveCredential(sessionId: string, workerToken: string, credential: ResolvedCredential): Promise<void> {
    this.session(sessionId, workerToken);
    await this.secretCodec.encode(JSON.stringify(credential)).then((ciphertext) => {
      this.database
        .prepare(
          `insert into web_discovery_credentials
            (session_id, tenant_id, workspace_id, subject, credential_ciphertext, created_at)
           values (?, ?, ?, ?, ?, ?)
           on conflict(session_id) do update set credential_ciphertext=excluded.credential_ciphertext, created_at=excluded.created_at`,
        )
        .run(
          sessionId,
          this.principal.tenantId,
          this.principal.workspaceId,
          this.principal.subject,
          ciphertext,
          new Date().toISOString(),
        );
    });
    this.audit(sessionId, undefined, "credential_captured", { authentication: credential.authType });
  }

  async getCredential(sessionId: string): Promise<ResolvedCredential | undefined> {
    this.session(sessionId);
    const row = this.database
      .prepare(
        `select credential_ciphertext from web_discovery_credentials
         where session_id=? and tenant_id=? and workspace_id=? and subject=?`,
      )
      .get(sessionId, this.principal.tenantId, this.principal.workspaceId, this.principal.subject) as
      | { credential_ciphertext?: unknown }
      | undefined;
    return row?.credential_ciphertext
      ? (JSON.parse(await this.secretCodec.decode(String(row.credential_ciphertext))) as ResolvedCredential)
      : undefined;
  }

  async getCandidate(sessionId: string, candidateId: string): Promise<WebCandidate | undefined> {
    const candidate = (await this.listCandidates(sessionId)).find((item) => item.id === candidateId);
    return candidate;
  }

  async confirm(
    sessionId: string,
    input: { candidateId: string; origin: string; operationId: string; readOnly: boolean },
  ): Promise<RestDefinition> {
    const candidates = await this.listCandidates(sessionId);
    const candidate = candidates.find((item) => item.id === input.candidateId);
    if (
      !candidate ||
      normalizeOrigin(input.origin, this.webEgress) !== candidate.origin ||
      input.readOnly !== candidate.readOnly ||
      !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(input.operationId)
    ) {
      throw new WebDiscoveryError(
        "confirmation_mismatch",
        "Confirmed domain, operation, and read/write classification must match the candidate.",
      );
    }
    const operation: RestOperation = {
      operationId: input.operationId,
      method: candidate.method,
      path: candidate.path,
      requestSchema: candidate.requestSchema,
      responseSchema: candidate.responseSchema,
      readOnly: candidate.readOnly,
    };
    this.database
      .prepare(
        `update web_discovery_candidates set confirmed_at=?
          where id=? and session_id=? and tenant_id=? and workspace_id=?`,
      )
      .run(new Date().toISOString(), candidate.id, sessionId, this.principal.tenantId, this.principal.workspaceId);
    this.audit(sessionId, candidate.id, "confirm", {
      origin: candidate.origin,
      method: candidate.method,
      path: candidate.path,
      operationId: input.operationId,
      readOnly: candidate.readOnly,
    });
    return { baseUrl: candidate.origin, operations: [operation], auth: { type: "none" }, definitionVersion: "web-1" };
  }

  private audit(
    sessionId: string,
    candidateId: string | undefined,
    event: string,
    detail: Record<string, unknown>,
  ): void {
    this.database
      .prepare(
        `insert into web_discovery_audit
          (id, tenant_id, workspace_id, subject, session_id, candidate_id, event, detail_json, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        this.principal.tenantId,
        this.principal.workspaceId,
        this.principal.subject,
        sessionId,
        candidateId ?? null,
        event,
        JSON.stringify(redactDiscoveryDetail(detail)),
        new Date().toISOString(),
      );
  }

  private session(id: string, workerToken?: string): { origin: string } {
    const row = this.database
      .prepare(
        `select origin, worker_token_hash, expires_at from web_discovery_sessions
          where id=? and tenant_id=? and workspace_id=? and subject=?`,
      )
      .get(id, this.principal.tenantId, this.principal.workspaceId, this.principal.subject) as
      | Record<string, unknown>
      | undefined;
    if (!row || new Date(String(row.expires_at)).getTime() <= Date.now()) {
      throw new WebDiscoveryError("session_not_found", "Web discovery session was not found or expired.");
    }
    if (workerToken !== undefined) {
      const actual = Buffer.from(createHash("sha256").update(workerToken).digest("hex"));
      const expected = Buffer.from(String(row.worker_token_hash));
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new WebDiscoveryError("session_not_found", "Web discovery session was not found or expired.");
      }
    }
    return { origin: String(row.origin) };
  }
}

function normalizeOrigin(value: string, webEgress?: WebEgressPolicy): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error();
    }
    assertPublicHttpUrl(url.origin, {
      fieldName: "Web discovery origin",
      createError: (message) => new Error(message),
      allowLocalhostDev: webEgress?.allowLocalhostDev === true,
      allowedLocalhostPorts: webEgress?.allowedLocalhostPorts,
    });
    return url.origin;
  } catch {
    throw new WebDiscoveryError("invalid_origin", "Web discovery requires an HTTPS origin.");
  }
}

function isSensitiveHeader(name: string): boolean {
  return /^(authorization|cookie|set-cookie|proxy-authorization|x-csrf-token|x-xsrf-token)$/i.test(name);
}

function hasSensitiveKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSensitiveKeys);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) =>
      /password|secret|token|cookie|authorization|csrf|xsrf|email|phone|ssn|social.?security|date.?of.?birth/i.test(
        key,
      ) || hasSensitiveKeys(child),
  );
}

function inferPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => (/^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(segment) ? "{id}" : segment))
    .join("/");
}

function inferSchema(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return { type: "array", items: value.length ? inferSchema(value[0]) : {} };
  }
  if (value && typeof value === "object") {
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, inferSchema(child) ?? { type: "null" }]),
      ),
    };
  }
  if (value === null) return { type: "null" };
  return { type: typeof value === "number" ? "number" : typeof value };
}

function redactDiscoveryDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDiscoveryDetail);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      /password|secret|token|cookie|authorization|csrf|credential/i.test(key)
        ? "[REDACTED]"
        : redactDiscoveryDetail(child),
    ]),
  );
}
