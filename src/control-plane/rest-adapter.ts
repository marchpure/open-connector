import { createGuardedFetch } from "../core/guarded-fetch.ts";

export type RestAuth =
  | { type: "none" }
  | { type: "api_key"; header: string; value: string }
  | { type: "bearer"; token: string };

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
}

export class RestAdapterError extends Error {
  readonly code: "invalid_spec" | "operation_not_allowed" | "confirmation_required" | "idempotency_required" | "request_failed";

  constructor(code: RestAdapterError["code"], message: string) {
    super(message);
    this.name = "RestAdapterError";
    this.code = code;
  }
}

export class RestOpenApiAdapter {
  private readonly fetcher: typeof fetch;
  private readonly idempotency = new Map<string, unknown>();
  private readonly definition: RestDefinition;

  constructor(definition: RestDefinition, fetcher: typeof fetch = createGuardedFetch()) {
    this.definition = definition;
    assertDefinition(definition);
    this.fetcher = fetcher;
  }

  static async fromSpecUrl(
    baseUrl: string,
    specUrl: string,
    auth: RestAuth,
    fetcher: typeof fetch = createGuardedFetch(),
  ): Promise<RestOpenApiAdapter> {
    const response = await fetcher(specUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      throw new RestAdapterError("invalid_spec", `OpenAPI spec request returned ${response.status}.`);
    }
    const spec = await response.json() as Record<string, unknown>;
    return new RestOpenApiAdapter({ baseUrl, operations: parseOperations(spec), auth, definitionVersion: String(spec.info && typeof spec.info === "object" ? (spec.info as Record<string, unknown>).version ?? "unknown" : "unknown") }, fetcher);
  }

  static fromSpec(
    baseUrl: string,
    spec: Record<string, unknown> | undefined,
    auth: RestAuth,
    confirmed: boolean,
    fetcher: typeof fetch = createGuardedFetch(),
  ): RestOpenApiAdapter {
    if (!spec && !confirmed) {
      throw new RestAdapterError("confirmation_required", "Endpoint, method, and schema require explicit user confirmation when no spec is provided.");
    }
    return new RestOpenApiAdapter({
      baseUrl,
      operations: spec ? parseOperations(spec) : [],
      auth,
      definitionVersion: spec ? String(spec.info && typeof spec.info === "object" ? (spec.info as Record<string, unknown>).version ?? "manual" : "manual") : "manual",
    }, fetcher);
  }

  async invoke(input: RestInvokeInput): Promise<{ status: number; data: unknown; headers: Record<string, string> }> {
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
    if (input.idempotencyKey && this.idempotency.has(input.idempotencyKey)) {
      return this.idempotency.get(input.idempotencyKey) as { status: number; data: unknown; headers: Record<string, string> };
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
    const response = await this.fetcher(url, {
      method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Preserve non-JSON response bodies as text.
    }
    if (!response.ok) {
      throw new RestAdapterError("request_failed", `REST operation returned ${response.status}.`);
    }
    const result = {
      status: response.status,
      data,
      headers: Object.fromEntries([...response.headers].filter(([key]) => !/authorization|cookie|token|secret/i.test(key))),
    };
    if (input.idempotencyKey) {
      this.idempotency.set(input.idempotencyKey, result);
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
  } else if (auth.type === "bearer") {
    headers.set("authorization", `Bearer ${auth.token}`);
  }
}
