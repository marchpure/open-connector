import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../core/guarded-fetch.ts";
import { AesGcmSecretCodec } from "../server/secrets/secret-codec.ts";
import { createPrincipalToken } from "./auth.ts";
import { createConnectionControlApp } from "./server.ts";
import { TenantRunLogStore } from "./tenant-store.ts";
import { executeWebAction } from "./web-action-runtime.ts";
import { TenantWebActionStore, WebActionError, publicWebAction, webCredentialFromInput } from "./web-action-store.ts";

const principal = {
  tenantId: "tenant-web",
  workspaceId: "workspace-web",
  subject: "subject-web",
  ownerId: "subject-web",
  audience: "runtime",
};

afterEach(() => {
  vi.unstubAllGlobals();
  setDefaultGuardedFetchDnsLookup(undefined);
});

describe("TenantWebActionStore", () => {
  it("persists canonical read actions with encrypted credentials and survives store recreation", async () => {
    const database = new DatabaseSync(":memory:");
    const codec = new AesGcmSecretCodec("web-action-test-key");
    const store = new TenantWebActionStore(database, principal, codec);
    const action = await store.confirm({
      candidate: {
        id: "candidate",
        origin: "https://fixture.example",
        method: "GET",
        path: "/api/items/{id}",
        readOnly: true,
        requestSchema: { type: "object", properties: { id: { type: "string" } } },
        responseSchema: { type: "object", properties: { id: { type: "string" } } },
      },
      operationId: "getItem",
      authentication: { type: "bearer" },
      credential: webCredentialFromInput({ type: "bearer" }, { secret: "fixture-secret" }),
    });
    expect(action).toMatchObject({
      id: expect.stringMatching(/^web_api\./),
      service: "web_api",
      method: "GET",
      path: "/api/items/{id}",
      readOnly: true,
      enabled: true,
      authentication: { type: "bearer" },
      idempotency: { required: false, header: "Idempotency-Key" },
    });
    expect(publicWebAction(action)).not.toHaveProperty("origin", "fixture-secret");
    expect(JSON.stringify(database.prepare("select * from web_actions").all())).not.toContain("fixture-secret");
    expect(await new TenantWebActionStore(database, principal, codec).get(action.id)).toMatchObject({
      id: action.id,
      credentialRef: action.credentialRef,
    });
  });

  it("requires write confirmation and keeps writes disabled by default", async () => {
    const store = new TenantWebActionStore(
      new DatabaseSync(":memory:"),
      principal,
      new AesGcmSecretCodec("web-action-write-key"),
    );
    const candidate = {
      id: "write-candidate",
      origin: "https://fixture.example",
      method: "POST",
      path: "/api/items",
      readOnly: false,
    } as const;
    await expect(
      store.confirm({
        candidate,
        operationId: "createItem",
        authentication: { type: "none" },
      }),
    ).rejects.toEqual(
      new WebActionError("side_effect_confirmation_required", "Write Web Actions require explicit confirmation."),
    );
    const action = await store.confirm({
      candidate,
      operationId: "createItem",
      authentication: { type: "none" },
      sideEffectConfirmed: true,
      enabled: false,
    });
    expect(action).toMatchObject({
      enabled: false,
      idempotency: { required: true, header: "Idempotency-Key" },
      sideEffect: { confirmed: true, defaultDisabled: true },
    });
  });
});

describe("executeWebAction", () => {
  it("completes authenticated discovery, confirmation, lease, MCP tools/list and tools/call", async () => {
    const database = new DatabaseSync(":memory:");
    const codec = new AesGcmSecretCodec("web-action-e2e-key");
    const app = createConnectionControlApp({
      catalog: {
        providers: [],
        providerSummaries: [],
        providerSummariesJson: "[]",
        providerSummariesEtag: 'W/"0"',
        actions: [],
        actionsById: new Map(),
        executableActionIds: new Set(),
      },
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => undefined,
      },
      controlDatabase: database,
      secretCodec: codec,
      authSecret: "web-action-e2e-auth",
      publicOrigin: "https://connect.example",
      enablement: [],
    });
    const auth = `Bearer ${createPrincipalToken(principal, "web-action-e2e-auth")}`;
    const started = await app.request("/v1/web-discovery/sessions", {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ origin: "https://fixture.example" }),
    });
    expect(started.status).toBe(201);
    const session = (await started.json()) as { session: { id: string; workerToken: string } };
    const observed = await app.request(`/v1/web-discovery/sessions/${session.session.id}/observations`, {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/json",
        "x-web-discovery-token": session.session.workerToken,
      },
      body: JSON.stringify({
        url: "https://fixture.example/api/items/42?page=1",
        method: "GET",
        requestHeaders: { accept: "application/json" },
        requestQuerySample: { page: "1" },
        responseStatus: 200,
        responseContentType: "application/json",
        responseSample: { id: "42", title: "fixture" },
      }),
    });
    expect(observed.status).toBe(201);
    const candidate = (await observed.json()) as { candidate: { id: string; origin: string } };
    const confirmed = await app.request(`/v1/web-discovery/sessions/${session.session.id}/confirm`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({
        candidateId: candidate.candidate.id,
        origin: candidate.candidate.origin,
        operationId: "getFixtureItem",
        readOnly: true,
        authentication: { type: "cookie" },
        credential: { secret: "session-cookie=fixture", displayName: "Fixture user" },
      }),
    });
    expect(confirmed.status).toBe(201);
    const confirmedBody = (await confirmed.json()) as {
      action: { id: string; connectionId: string };
    };
    expect(JSON.stringify(confirmedBody)).not.toContain("session-cookie=fixture");

    const leaseResponse = await app.request(`/v1/connections/${confirmedBody.action.connectionId}/lease`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({
        allowedActions: [confirmedBody.action.id],
        invocationId: "web-action-mcp-e2e",
        audience: principal.audience,
      }),
    });
    expect(leaseResponse.status).toBe(201);
    const lease = (await leaseResponse.json()) as { token: string };
    setDefaultGuardedFetchDnsLookup(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("cookie")).toBe("session-cookie=fixture");
        return new Response(JSON.stringify({ id: "42", title: "fixture" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const runtimeUrl = new URL(
      `https://connect.example/v1/runtime/mcp/sse?connectionId=${encodeURIComponent(confirmedBody.action.connectionId)}&invocationId=web-action-mcp-e2e&audience=${encodeURIComponent(principal.audience)}`,
    );
    const client = new Client({ name: "web-action-e2e", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(runtimeUrl, {
      fetch: async (input, init) => app.fetch(new Request(input, init)),
      requestInit: { headers: { "x-connection-lease": lease.token } },
    });
    try {
      await client.connect(transport);
      await expect(client.callTool({ name: "list_allowed_actions", arguments: {} })).resolves.toMatchObject({
        structuredContent: { ok: true, data: { actions: [{ id: confirmedBody.action.id }] } },
      });
      const executed = await client.callTool({
        name: "execute_action",
        arguments: {
          actionId: confirmedBody.action.id,
          input: { pathParams: { id: "42" }, query: { page: "1" } },
        },
      });
      expect(executed).toMatchObject({
        structuredContent: { ok: true, data: { data: { id: "42", title: "fixture" } }, auditPersisted: true },
      });
    } finally {
      await client.close();
    }
    const other = new TenantWebActionStore(
      database,
      { ...principal, tenantId: "other-tenant", workspaceId: "other-workspace", subject: "other", ownerId: "other" },
      codec,
    );
    await expect(other.get(confirmedBody.action.id)).resolves.toBeUndefined();
  });

  it("executes same-origin JSON and audits the tenant-scoped invocation", async () => {
    const origin = "https://fixture.example";
    const database = new DatabaseSync(":memory:");
    const codec = new AesGcmSecretCodec("web-action-runtime-key");
    const store = new TenantWebActionStore(database, principal, codec);
    const action = await store.confirm({
      candidate: {
        id: "runtime-candidate",
        origin,
        method: "GET",
        path: "/api/items/{id}",
        readOnly: true,
        responseSchema: { type: "object" },
      },
      operationId: "getFixture",
      authentication: { type: "none" },
    });
    const run = await executeWebAction({
      action,
      webActions: store,
      runs: new TenantRunLogStore(database, principal),
      database,
      scope: { tenantId: principal.tenantId, workspaceId: principal.workspaceId },
      secretCodec: codec,
      invocationId: "invocation-web-fixture",
      input: { pathParams: { id: "42" } },
      signal: new AbortController().signal,
      fetcher: async () =>
        new Response(JSON.stringify({ id: "42", title: "fixture" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(run.result).toMatchObject({ ok: true, output: { data: { id: "42", title: "fixture" } } });
    expect(run.auditPersisted).toBe(true);
    expect(
      await new TenantRunLogStore(database, principal).list({ invocationId: "invocation-web-fixture" }),
    ).toMatchObject({ items: [{ connectionId: action.connectionId, actionId: action.id, ok: true }] });
  });

  it("rejects missing write idempotency and non-JSON responses", async () => {
    const database = new DatabaseSync(":memory:");
    const codec = new AesGcmSecretCodec("web-action-negative-key");
    const store = new TenantWebActionStore(database, principal, codec);
    const action = await store.confirm({
      candidate: {
        id: "negative-candidate",
        origin: "https://fixture.example",
        method: "POST",
        path: "/api/items",
        readOnly: false,
      },
      operationId: "createFixture",
      authentication: { type: "none" },
      sideEffectConfirmed: true,
      enabled: true,
    });
    const run = await executeWebAction({
      action,
      webActions: store,
      runs: new TenantRunLogStore(database, principal),
      database,
      scope: { tenantId: principal.tenantId, workspaceId: principal.workspaceId },
      secretCodec: codec,
      invocationId: "invocation-negative",
      input: { confirmed: true, body: {} },
      signal: new AbortController().signal,
    });
    expect(run.result).toMatchObject({ ok: false, error: { code: "idempotency_required" } });
  });
});
