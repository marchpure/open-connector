import type { ResolvedCredential } from "../core/types.ts";
import type { ActionRunResult } from "../server/actions/action-runner.ts";
import type { TenantRunLogStore } from "./tenant-store.ts";
import type { WebActionDefinition } from "./web-action-store.ts";

import { createGuardedFetch } from "../core/guarded-fetch.ts";
import { redactSecrets } from "./redaction.ts";
import { RestAdapterError, RestIdempotencyStore, RestOpenApiAdapter } from "./rest-adapter.ts";
import { TenantWebActionStore, WebActionError } from "./web-action-store.ts";
import type { WebEgressPolicy } from "./service.ts";

const maxOutputBytes = 64 * 1024;
const requestTimes = new Map<string, number[]>();

export async function executeWebAction(input: {
  action: WebActionDefinition;
  webActions: TenantWebActionStore;
  runs: TenantRunLogStore;
  database: import("node:sqlite").DatabaseSync;
  scope: { tenantId: string; workspaceId: string };
  secretCodec: import("../server/secrets/secret-codec-core.ts").ISecretCodec;
  invocationId: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  webEgress?: WebEgressPolicy;
  fetcher?: typeof fetch;
}): Promise<ActionRunResult> {
  const executionId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let result: { ok: true; output: unknown } | { ok: false; error: { code: string; message: string } };
  try {
    if (!input.action.enabled) throw new WebActionError("web_action_disabled", "This Web Action is disabled.");
    if (!input.action.readOnly && input.input.confirmed !== true) {
      throw new WebActionError("side_effect_confirmation_required", "Write Web Actions require explicit confirmation.");
    }
    if (!input.action.readOnly && typeof input.input.idempotencyKey !== "string") {
      throw new WebActionError("idempotency_required", "Write Web Actions require an idempotency key.");
    }
    input.signal.throwIfAborted();
    assertSafeActionInput(input.input);
    enforceRateLimit(input.action, input.scope);
    const credential = await input.webActions.credential(input.action);
    const adapter = new RestOpenApiAdapter(
      {
        baseUrl: input.action.origin,
        operations: [
          {
            operationId: input.action.name,
            method: input.action.method,
            path: input.action.path,
            requestSchema: input.action.inputSchema,
            responseSchema: input.action.outputSchema,
            readOnly: input.action.readOnly,
          },
        ],
        auth: toRestAuth(input.action, credential),
        definitionVersion: "web-1",
      },
      sameOriginFetch(input.action.origin, input.action.timeoutMs, input.fetcher, input.webEgress),
      new RestIdempotencyStore(input.database, input.scope, input.secretCodec),
    );
    const invocation = await adapter.invoke({
      operationId: input.action.name,
      pathParams: recordOf(input.input.pathParams) as Record<string, string>,
      query: recordOf(input.input.query) as Record<string, string>,
      body: input.input.body,
      confirmed: input.input.confirmed === true,
      idempotencyKey: stringValue(input.input.idempotencyKey),
      pagination:
        input.input.pagination && typeof input.input.pagination === "object"
          ? { maxPages: Number(recordOf(input.input.pagination).maxPages ?? input.action.pagination.maxPages) }
          : undefined,
      timeoutMs: input.action.timeoutMs,
      maxResponseBytes: 1024 * 1024,
    });
    const contentType = String((invocation.headers as Record<string, string>)["content-type"] ?? "");
    if (!contentType.toLowerCase().includes("json")) {
      throw new WebActionError("invalid_web_action", "Web Action response content type is not JSON.");
    }
    result = { ok: true, output: bound(redactSecrets(invocation)) };
  } catch (error) {
    result = {
      ok: false,
      error: {
        code: error instanceof WebActionError || error instanceof RestAdapterError ? error.code : "web_action_failed",
        message: error instanceof Error ? error.message : "Web Action failed.",
      },
    };
  }
  const completedAt = new Date().toISOString();
  const audit = {
    id: executionId,
    invocationId: input.invocationId,
    service: "web_api",
    actionId: input.action.id,
    caller: "mcp" as const,
    startedAt,
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt),
    ok: result.ok,
    connectionId: input.action.connectionId,
    inputSummary: redactSecrets(input.input),
    outputSummary: result.ok ? result.output : undefined,
    errorCode: result.ok ? undefined : result.error.code,
    errorMessage: result.ok ? undefined : result.error.message,
  };
  let auditPersisted = false;
  try {
    await input.runs.add(audit);
    auditPersisted = true;
  } catch {
    // Return the operation result while exposing that the audit write failed.
  }
  return {
    executionId,
    auditPersisted,
    result: result.ok ? { ok: true, output: result.output } : result,
  };
}

function toRestAuth(
  action: WebActionDefinition,
  credential: ResolvedCredential,
):
  | { type: "none" }
  | { type: "api_key"; header: string; value: string }
  | { type: "oauth2"; accessToken: string }
  | { type: "cookie"; value: string } {
  if (action.authentication.type === "none") return { type: "none" };
  if (credential.authType === "oauth2") return { type: "oauth2", accessToken: credential.accessToken };
  if (action.authentication.type === "cookie" && credential.authType === "custom_credential") {
    const cookie = credential.values.cookie;
    if (!cookie) throw new WebActionError("web_credential_invalid", "Web Action cookie credential is empty.");
    return { type: "cookie", value: cookie };
  }
  if (credential.authType === "api_key") {
    return {
      type: "api_key",
      header: action.authentication.type === "api_key" ? action.authentication.header : "authorization",
      value: credential.apiKey,
    };
  }
  if (credential.authType !== "custom_credential") {
    throw new WebActionError("web_credential_invalid", "Web Action credential type is unsupported.");
  }
  const values = Object.values(credential.values);
  if (values.length === 0) throw new WebActionError("web_credential_invalid", "Web Action credential is empty.");
  return {
    type: "api_key",
    header: action.authentication.type === "api_key" ? action.authentication.header : "authorization",
    value: String(values[0]),
  };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function bound(value: unknown): unknown {
  const safe = redactSecrets(value);
  return new TextEncoder().encode(JSON.stringify(safe)).byteLength <= maxOutputBytes
    ? safe
    : { ok: false, error: { code: "output_too_large", message: "Web Action output exceeded the response limit." } };
}

function enforceRateLimit(action: WebActionDefinition, scope: { tenantId: string; workspaceId: string }): void {
  const now = Date.now();
  const key = `${scope.tenantId}:${scope.workspaceId}:${action.id}`;
  const recent = (requestTimes.get(key) ?? []).filter((time) => now - time < 60_000);
  if (recent.length >= action.rateLimit.maxRequestsPerMinute) {
    throw new WebActionError("web_action_disabled", "Web Action rate limit exceeded.");
  }
  recent.push(now);
  requestTimes.set(key, recent);
}

function assertSafeActionInput(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertSafeActionInput);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/password|secret|token|cookie|authorization|csrf|credential/i.test(key) && key !== "idempotencyKey") {
      throw new WebActionError(
        "web_credential_invalid",
        "Sensitive values must remain in the encrypted credential store.",
      );
    }
    assertSafeActionInput(child);
  }
}

function sameOriginFetch(
  origin: string,
  timeoutMs: number,
  fetcher?: typeof fetch,
  webEgress?: WebEgressPolicy,
): typeof fetch {
  const guarded = createGuardedFetch({
    fetch: fetcher,
    maxRedirects: 0,
    allowLocalhostDev: webEgress?.allowLocalhostDev,
    allowedLocalhostPorts: webEgress?.allowedLocalhostPorts,
    ...(fetcher ? { lookup: null } : {}),
  });
  return async (input, init) => {
    let url = new URL(input instanceof Request ? input.url : String(input), origin);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (url.origin !== origin)
        throw new WebActionError("invalid_web_action", "Cross-origin Web Action request rejected.");
      const response = await guarded(url, {
        ...init,
        redirect: "manual",
        signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location || redirects === 3) {
        throw new WebActionError("invalid_web_action", "Web Action redirect limit exceeded.");
      }
      const next = new URL(location, url);
      if (next.origin !== origin) {
        throw new WebActionError("invalid_web_action", "Cross-origin Web Action redirect rejected.");
      }
      await response.body?.cancel().catch(() => undefined);
      url = next;
    }
    throw new WebActionError("invalid_web_action", "Web Action redirect limit exceeded.");
  };
}
