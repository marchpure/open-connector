import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { DatabaseSync } from "node:sqlite";

import { randomUUID } from "node:crypto";
import { createGuardedFetch } from "../core/guarded-fetch.ts";
import { readBoundedResponseBytes } from "../core/request.ts";
import {
  createIdempotencyExpiry,
  hashActionRequest,
  hashIdempotencyKey,
} from "../server/actions/action-idempotency.ts";

export type RestAuth =
  | { type: "none" }
  | { type: "api_key"; header: string; value: string }
  | { type: "cookie"; value: string }
  | { type: "bearer"; token: string }
  | { type: "oauth2"; accessToken: string };

export interface RestOperation {
  operationId: string;
  method: string;
  path: string;
  requestSchema?: Record<string, unknown>;
  responseSchema?: Record<string, unknown>;
  readOnly: boolean;
}

export interface RestDefinition {
  baseUrl: string;
  operations: RestOperation[];
  auth: RestAuth;
  definitionVersion: string;
}

export interface RestInvokeInput {
  operationId: string;
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  confirmed?: boolean;
  idempotencyKey?: string;
  pagination?: { maxPages: number };
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class RestAdapterError extends Error {
  readonly code:
    | "invalid_spec"
    | "operation_not_allowed"
    | "confirmation_required"
    | "idempotency_required"
    | "idempotency_conflict"
    | "idempotency_in_progress"
    | "request_failed";

  constructor(code: RestAdapterError["code"], message: string) {
    super(message);
    this.name = "RestAdapterError";
    this.code = code;
  }
}

type RestResult = { status: number; data: unknown; headers: Record<string, string>; pages?: number };

interface RestIdempotency {
  claim(
    key: string,
    requestHash: string,
  ): Promise<
    | { kind: "acquired"; claimId: string }
    | { kind: "completed"; result: RestResult }
    | { kind: "conflict" }
    | { kind: "in_progress" }
  >;
  complete(key: string, requestHash: string, claimId: string, result: RestResult): Promise<void>;
}

export class RestIdempotencyStore implements RestIdempotency {
  private readonly database: DatabaseSync;
  private readonly scope: { tenantId: string; workspaceId: string };
  private readonly secretCodec: ISecretCodec;

  constructor(database: DatabaseSync, scope: { tenantId: string; workspaceId: string }, secretCodec: ISecretCodec) {
    this.database = database;
    this.scope = scope;
    this.secretCodec = secretCodec;
    this.database.exec(`
      create table if not exists rest_idempotency (
        tenant_id text not null,
        workspace_id text not null,
        key_hash text not null,
        request_hash text not null,
        claim_id text not null,
        state text not null check (state in ('in_progress', 'completed')),
        response_ciphertext text,
        created_at text not null,
        expires_at text not null,
        primary key (tenant_id, workspace_id, key_hash)
      );
    `);
  }

  async claim(
    key: string,
    requestHash: string,
  ): Promise<
    | { kind: "acquired"; claimId: string }
    | { kind: "completed"; result: RestResult }
    | { kind: "conflict" }
    | { kind: "in_progress" }
  > {
    const now = new Date();
    const keyHash = hashIdempotencyKey(key);
    const claimId = randomUUID();
    this.database.exec("begin immediate");
    let row: Record<string, unknown> | undefined;
    try {
      this.database.prepare("delete from rest_idempotency where expires_at <= ?").run(now.toISOString());
      const inserted = this.database
        .prepare(
          `insert into rest_idempotency
            (tenant_id, workspace_id, key_hash, request_hash, claim_id, state,
             response_ciphertext, created_at, expires_at)
           values (?, ?, ?, ?, ?, 'in_progress', null, ?, ?)
           on conflict (tenant_id, workspace_id, key_hash) do nothing`,
        )
        .run(
          this.scope.tenantId,
          this.scope.workspaceId,
          keyHash,
          requestHash,
          claimId,
          now.toISOString(),
          createIdempotencyExpiry(now),
        );
      if (Number(inserted.changes) === 0) {
        row = this.database
          .prepare(
            `select request_hash, state, response_ciphertext
               from rest_idempotency
              where tenant_id=? and workspace_id=? and key_hash=?`,
          )
          .get(this.scope.tenantId, this.scope.workspaceId, keyHash) as Record<string, unknown>;
      }
      this.database.exec("commit");
      if (!row) return { kind: "acquired", claimId };
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }

    if (String(row.request_hash) !== requestHash) return { kind: "conflict" };
    if (String(row.state) === "in_progress") return { kind: "in_progress" };
    return {
      kind: "completed",
      result: JSON.parse(await this.secretCodec.decode(String(row.response_ciphertext))) as RestResult,
    };
  }

  async complete(key: string, requestHash: string, claimId: string, result: RestResult): Promise<void> {
    const ciphertext = await this.secretCodec.encode(JSON.stringify(result));
    this.database
      .prepare(
        `update rest_idempotency set state='completed', response_ciphertext=?
          where tenant_id=? and workspace_id=? and key_hash=? and request_hash=? and claim_id=? and state='in_progress'`,
      )
      .run(ciphertext, this.scope.tenantId, this.scope.workspaceId, hashIdempotencyKey(key), requestHash, claimId);
  }
}

export class RestOpenApiAdapter {
  private readonly fetcher: typeof fetch;
  private readonly idempotency = new Map<string, unknown>();
  private readonly idempotencyStore?: RestIdempotency;
  private readonly definition: RestDefinition;

  constructor(
    definition: RestDefinition,
    fetcher: typeof fetch = createGuardedFetch(),
    idempotencyStore?: RestIdempotency,
  ) {
    this.definition = definition;
    assertDefinition(definition);
    this.fetcher = fetcher;
    this.idempotencyStore = idempotencyStore;
  }

  static async fromSpecUrl(
    baseUrl: string,
    specUrl: string,
    auth: RestAuth,
    fetcher: typeof fetch = createGuardedFetch(),
    idempotencyStore?: RestIdempotency,
  ): Promise<RestOpenApiAdapter> {
    const response = await fetcher(specUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      throw new RestAdapterError("invalid_spec", `OpenAPI spec request returned ${response.status}.`);
    }
    const spec = (await response.json()) as Record<string, unknown>;
    return new RestOpenApiAdapter(
      {
        baseUrl,
        operations: parseOperations(spec),
        auth,
        definitionVersion: String(
          spec.info && typeof spec.info === "object"
            ? ((spec.info as Record<string, unknown>).version ?? "unknown")
            : "unknown",
        ),
      },
      fetcher,
      idempotencyStore,
    );
  }

  static fromSpec(
    baseUrl: string,
    spec: Record<string, unknown> | undefined,
    auth: RestAuth,
    confirmed: boolean,
    fetcher: typeof fetch = createGuardedFetch(),
    idempotencyStore?: RestIdempotency,
  ): RestOpenApiAdapter {
    if (!spec && !confirmed) {
      throw new RestAdapterError(
        "confirmation_required",
        "Endpoint, method, and schema require explicit user confirmation when no spec is provided.",
      );
    }
    return new RestOpenApiAdapter(
      {
        baseUrl,
        operations: spec ? parseOperations(spec) : [],
        auth,
        definitionVersion: spec
          ? String(
              spec.info && typeof spec.info === "object"
                ? ((spec.info as Record<string, unknown>).version ?? "manual")
                : "manual",
            )
          : "manual",
      },
      fetcher,
      idempotencyStore,
    );
  }

  describe(): { definitionVersion: string; operations: RestOperation[] } {
    return {
      definitionVersion: this.definition.definitionVersion,
      operations: this.definition.operations.map((operation) => ({ ...operation })),
    };
  }

  async invoke(input: RestInvokeInput): Promise<RestResult> {
    const operation = this.definition.operations.find((candidate) => candidate.operationId === input.operationId);
    if (!operation) {
      throw new RestAdapterError("operation_not_allowed", "Operation is not in the confirmed OpenAPI definition.");
    }
    const method = operation.method.toUpperCase();
    if (!operation.readOnly && !input.confirmed) {
      throw new RestAdapterError("confirmation_required", "Write operations require explicit confirmation.");
    }
    if (!operation.readOnly && !input.idempotencyKey) {
      throw new RestAdapterError("idempotency_required", "Write operations require an idempotency key.");
    }
    const requestHash = input.idempotencyKey
      ? hashActionRequest({
          actionId: input.operationId,
          connectionName: this.definition.baseUrl,
          input: { pathParams: input.pathParams, query: input.query, body: input.body },
        })
      : undefined;
    let claimId: string | undefined;
    if (input.idempotencyKey && requestHash && this.idempotencyStore) {
      const claim = await this.idempotencyStore.claim(input.idempotencyKey, requestHash);
      if (claim.kind === "completed") return claim.result;
      if (claim.kind === "conflict") {
        throw new RestAdapterError("idempotency_conflict", "Idempotency key was reused for a different request.");
      }
      if (claim.kind === "in_progress") {
        throw new RestAdapterError("idempotency_in_progress", "The idempotent request is still in progress.");
      }
      claimId = claim.claimId;
    } else if (input.idempotencyKey && this.idempotency.has(input.idempotencyKey)) {
      return this.idempotency.get(input.idempotencyKey) as {
        status: number;
        data: unknown;
        headers: Record<string, string>;
      };
    }
    const path = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
      const value = input.pathParams?.[name];
      if (value === undefined) {
        throw new RestAdapterError("request_failed", `Missing path parameter: ${name}.`);
      }
      return encodeURIComponent(value);
    });
    const url = new URL(path, this.definition.baseUrl);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers = new Headers({ accept: "application/json" });
    if (input.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (input.idempotencyKey) {
      headers.set("idempotency-key", input.idempotencyKey);
    }
    applyAuth(headers, this.definition.auth);
    const request: RequestInit = {
      method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
    };
    const maxPages = input.pagination?.maxPages ?? 1;
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
      throw new RestAdapterError("request_failed", "Pagination maxPages must be between 1 and 100.");
    }
    const pageResults: unknown[] = [];
    let response: Response | undefined;
    let nextUrl: URL | undefined = url;
    for (let page = 0; page < maxPages && nextUrl; page += 1) {
      response = await fetchWithRateLimit(this.fetcher, nextUrl, request);
      const maxResponseBytes = input.maxResponseBytes ?? 1024 * 1024;
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > maxResponseBytes) {
        throw new RestAdapterError("request_failed", "REST response exceeded the response size limit.");
      }
      const bytes = await readBoundedResponseBytes(response, {
        maxBytes: maxResponseBytes,
        fieldName: "REST response",
        createError: (message) => new RestAdapterError("request_failed", message),
      });
      const text = new TextDecoder().decode(bytes);
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // Preserve non-JSON response bodies as text.
      }
      if (!response.ok) {
        throw new RestAdapterError("request_failed", `REST operation returned ${response.status}.`);
      }
      pageResults.push(data);
      nextUrl = operation.readOnly ? nextLink(response.headers.get("link"), nextUrl) : undefined;
    }
    if (!response) throw new RestAdapterError("request_failed", "REST operation returned no response.");
    const result = {
      status: response.status,
      data: input.pagination ? pageResults : pageResults[0],
      headers: Object.fromEntries(
        [...response.headers].filter(([key]) => !/authorization|cookie|token|secret/i.test(key)),
      ),
      ...(input.pagination ? { pages: pageResults.length } : {}),
    };
    if (input.idempotencyKey) {
      this.idempotency.set(input.idempotencyKey, result);
      if (this.idempotencyStore && requestHash && claimId) {
        await this.idempotencyStore.complete(input.idempotencyKey, requestHash, claimId, result);
      }
    }
    return result;
  }
}

function assertDefinition(definition: RestDefinition): void {
  try {
    const url = new URL(definition.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error();
    }
  } catch {
    throw new RestAdapterError("invalid_spec", "REST baseUrl must be an HTTP(S) URL.");
  }
  if (!definition.operations.length) {
    throw new RestAdapterError("invalid_spec", "At least one confirmed REST operation is required.");
  }
}

function parseOperations(spec: Record<string, unknown>): RestOperation[] {
  const paths = spec.paths;
  if (!paths || typeof paths !== "object") {
    throw new RestAdapterError("invalid_spec", "OpenAPI spec must contain paths.");
  }
  const operations: RestOperation[] = [];
  for (const [path, item] of Object.entries(paths as Record<string, unknown>)) {
    if (!item || typeof item !== "object") continue;
    for (const [method, raw] of Object.entries(item as Record<string, unknown>)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method) || !raw || typeof raw !== "object") continue;
      const operation = raw as Record<string, unknown>;
      const operationId = operation.operationId;
      if (typeof operationId !== "string" || !operationId.trim()) continue;
      operations.push({
        operationId,
        method,
        path,
        requestSchema: operation.requestBody as Record<string, unknown> | undefined,
        responseSchema: operation.responses as Record<string, unknown> | undefined,
        readOnly: method === "get",
      });
    }
  }
  if (!operations.length) {
    throw new RestAdapterError("invalid_spec", "OpenAPI spec contains no operations with operationId.");
  }
  return operations;
}

function applyAuth(headers: Headers, auth: RestAuth): void {
  if (auth.type === "api_key") {
    headers.set(auth.header, auth.value);
  } else if (auth.type === "cookie") {
    headers.set("cookie", auth.value);
  } else if (auth.type === "bearer" || auth.type === "oauth2") {
    headers.set("authorization", `Bearer ${auth.type === "bearer" ? auth.token : auth.accessToken}`);
  }
}

async function fetchWithRateLimit(fetcher: typeof fetch, url: URL, init: RequestInit): Promise<Response> {
  let response = await fetcher(url, init);
  if (response.status !== 429) return response;
  const retryAfter = Number(response.headers.get("retry-after") ?? "0");
  if (!Number.isFinite(retryAfter) || retryAfter < 0 || retryAfter > 5) {
    throw new RestAdapterError("request_failed", "REST rate-limit retry exceeds the allowed delay.");
  }
  await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
  response = await fetcher(url, init);
  return response;
}

function nextLink(header: string | null, current: URL): URL | undefined {
  if (!header) return undefined;
  for (const item of header.split(",")) {
    const match = item.match(/^\s*<([^>]+)>\s*;\s*rel="?next"?/i);
    if (match) {
      const next = new URL(match[1], current);
      if (next.origin !== current.origin) {
        throw new RestAdapterError("request_failed", "Cross-origin REST pagination is not allowed.");
      }
      return next;
    }
  }
  return undefined;
}
