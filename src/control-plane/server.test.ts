import type { ProviderDefinition } from "../core/types.ts";

import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { TransitFileService } from "../server/files/transit-files.ts";
import { AesGcmSecretCodec } from "../server/secrets/secret-codec.ts";
import { createPrincipalToken } from "./auth.ts";
import { ConnectionLeaseService } from "./lease.ts";
import { createConnectionControlApp } from "./server.ts";

const provider: ProviderDefinition = {
  service: "fixture",
  displayName: "Fixture",
  categories: ["test"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [{ key: "secret", label: "Secret", inputType: "password", required: true, secret: true }],
    },
  ],
  actions: [
    {
      id: "fixture.read",
      service: "fixture",
      name: "read",
      description: "Read fixture data.",
      requiredScopes: [],
      providerPermissions: [],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
  ],
};

const oauthProvider: ProviderDefinition = {
  service: "feishu",
  displayName: "Feishu",
  categories: ["Communication"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
      tokenUrl: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      scopes: ["offline_access", "auth:user.id:read"],
      minimumScopes: ["offline_access", "auth:user.id:read"],
      tokenEndpointAuthMethod: "client_secret_post",
      tokenRequestFormat: "json",
    },
  ],
  actions: [],
};

const postgresqlProvider: ProviderDefinition = {
  ...provider,
  service: "postgresql",
  displayName: "PostgreSQL",
  actions: [
    {
      ...provider.actions[0],
      id: "postgresql.execute_read_query",
      service: "postgresql",
      name: "execute_read_query",
    },
  ],
};

const principal = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  subject: "user-a",
  ownerId: "user-a",
  audience: "knowledge-runtime",
};

const tempRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("connection control API", () => {
  it("serves a lease-scoped MCP runtime with tenant recovery, replay protection, and audit", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider], { executableActionIds: ["fixture.read"] }),
      providerLoader: {
        loadActionExecutor: async () => async () => ({
          ok: true,
          output: {
            value: "safe",
            accessToken: "must-not-leak",
            internalUrl: "http://127.0.0.1:3400/private",
          },
        }),
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          customCredential: async () => ({ profile: { displayName: "fixture" } }),
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://127.0.0.1:3400",
      enablement: [{ service: "fixture", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const auth = createPrincipalToken(principal, "auth-secret");
    const otherAuth = createPrincipalToken(
      { ...principal, tenantId: "tenant-b", workspaceId: "workspace-b", subject: "user-b", ownerId: "user-b" },
      "auth-secret",
    );
    const created = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        service: "fixture",
        authType: "custom_credential",
        connectionName: "mcp",
        values: { secret: "connection-secret" },
      }),
    });
    const connectionId = ((await created.json()) as { connection: { id: string } }).connection.id;
    const otherConnection = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        service: "fixture",
        authType: "custom_credential",
        connectionName: "other",
        values: { secret: "other-connection-secret" },
      }),
    });
    const otherConnectionId = ((await otherConnection.json()) as { connection: { id: string } }).connection.id;
    const runtimeUrl = (
      selectedConnectionId = connectionId,
      invocationId = "mcp-invocation",
      audience = "knowledge-runtime",
    ) =>
      new URL(
        `https://connect.test/v1/runtime/mcp/sse?connectionId=${encodeURIComponent(selectedConnectionId)}&invocationId=${encodeURIComponent(invocationId)}&audience=${encodeURIComponent(audience)}`,
      );
    const leaseResponse = await app.request(`/v1/connections/${connectionId}/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        allowedActions: ["fixture.read"],
        invocationId: "mcp-invocation",
        audience: "knowledge-runtime",
      }),
    });
    const lease = (await leaseResponse.json()) as { token: string; claims: { jti: string } };
    const fetcher: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
    for (const query of [
      `invocationId=mcp-invocation&audience=knowledge-runtime`,
      `connectionId=${encodeURIComponent(connectionId)}&audience=knowledge-runtime`,
      `connectionId=${encodeURIComponent(connectionId)}&invocationId=mcp-invocation`,
    ]) {
      const missingQuery = await app.request(`/v1/runtime/mcp/sse?${query}`, {
        headers: { "x-connection-lease": lease.token },
      });
      expect(missingQuery.status).toBe(400);
      await expect(missingQuery.json()).resolves.toMatchObject({ error: { code: "invalid_lease" } });
    }
    const transport = new StreamableHTTPClientTransport(runtimeUrl(), {
      fetch: fetcher,
      requestInit: {
        headers: {
          authorization: `Bearer ${otherAuth}`,
          "x-connection-lease": lease.token,
        },
      },
    });
    const client = new Client({ name: "lease-runtime-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "list_allowed_actions",
        "get_action_guide",
        "execute_action",
      ]);
      await expect(client.callTool({ name: "list_allowed_actions", arguments: {} })).resolves.toMatchObject({
        structuredContent: {
          ok: true,
          data: { connectionId, actions: [{ id: "fixture.read" }] },
        },
      });
      const denied = await client.callTool({ name: "get_action_guide", arguments: { actionId: "other.read" } });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain("lease_scope_denied");
      const executed = await client.callTool({
        name: "execute_action",
        arguments: { actionId: "fixture.read", input: {} },
      });
      expect(executed).toMatchObject({
        structuredContent: {
          ok: true,
          data: { value: "safe", accessToken: "[redacted]" },
          auditPersisted: true,
        },
      });
      expect(JSON.stringify(executed)).not.toContain("must-not-leak");
      expect(JSON.stringify(executed)).not.toContain("127.0.0.1");
    } finally {
      await client.close();
    }

    const multiConnectionLease = new ConnectionLeaseService(database).issue(principal, {
      connectionIds: [connectionId, otherConnectionId],
      connectionRevisions: { [connectionId]: 1, [otherConnectionId]: 1 },
      allowedActions: ["fixture.read"],
      invocationId: "multi-connection-invocation",
      audience: "knowledge-runtime",
    });
    const multiConnectionTransport = new StreamableHTTPClientTransport(
      runtimeUrl(otherConnectionId, "multi-connection-invocation"),
      {
        fetch: fetcher,
        requestInit: { headers: { "x-connection-lease": multiConnectionLease.token } },
      },
    );
    const multiConnectionClient = new Client({ name: "multi-connection-runtime-test", version: "1.0.0" });
    try {
      await multiConnectionClient.connect(multiConnectionTransport);
      await expect(
        multiConnectionClient.callTool({ name: "list_allowed_actions", arguments: {} }),
      ).resolves.toMatchObject({
        structuredContent: { ok: true, data: { connectionId: otherConnectionId } },
      });
      await expect(
        multiConnectionClient.callTool({
          name: "execute_action",
          arguments: { actionId: "fixture.read", input: {} },
        }),
      ).resolves.toMatchObject({
        structuredContent: { ok: true, auditPersisted: true },
      });
    } finally {
      await multiConnectionClient.close();
    }

    const audit = await app.request("/v1/audit?invocationId=mcp-invocation", {
      headers: { authorization: `Bearer ${auth}` },
    });
    const auditBody = (await audit.json()) as { items: Array<Record<string, unknown>> };
    expect(auditBody.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invocationId: "mcp-invocation",
          connectionId,
          actionId: "fixture.read",
          caller: "mcp",
          ok: true,
        }),
      ]),
    );
    const otherAudit = await app.request("/v1/audit?invocationId=mcp-invocation", {
      headers: { authorization: `Bearer ${otherAuth}` },
    });
    await expect(otherAudit.json()).resolves.toEqual({ items: [] });

    for (const [selectedConnectionId, invocationId, audience, extraHeaders] of [
      [connectionId, "replayed-invocation", "knowledge-runtime", {}],
      [connectionId, "mcp-invocation", "wrong-audience", {}],
      [otherConnectionId, "mcp-invocation", "knowledge-runtime", {}],
      [connectionId, "mcp-invocation", "knowledge-runtime", { "x-connection-id": otherConnectionId }],
      [connectionId, "mcp-invocation", "knowledge-runtime", { "x-connection-invocation-id": "conflict" }],
      [connectionId, "mcp-invocation", "knowledge-runtime", { "x-connection-audience": "conflict" }],
    ] satisfies Array<[string, string, string, Record<string, string>]>) {
      const rejectedTransport = new StreamableHTTPClientTransport(
        runtimeUrl(selectedConnectionId, invocationId, audience),
        {
          fetch: fetcher,
          requestInit: {
            headers: {
              "x-connection-lease": lease.token,
              ...extraHeaders,
            },
          },
        },
      );
      const rejectedClient = new Client({ name: "rejected-runtime-test", version: "1.0.0" });
      await expect(rejectedClient.connect(rejectedTransport)).rejects.toThrow();
      await rejectedClient.close();
    }
    database
      .prepare("update connection_leases set expires_at='2020-01-01T00:00:00.000Z' where token_hash is not null")
      .run();
    const expiredTransport = new StreamableHTTPClientTransport(runtimeUrl(), {
      fetch: fetcher,
      requestInit: {
        headers: {
          "x-connection-lease": lease.token,
        },
      },
    });
    const expiredClient = new Client({ name: "expired-runtime-test", version: "1.0.0" });
    await expect(expiredClient.connect(expiredTransport)).rejects.toThrow();
    await expiredClient.close();
    database
      .prepare("update connection_leases set expires_at='2099-01-01T00:00:00.000Z' where token_hash is not null")
      .run();
    database.prepare("update tenant_connections set revision=revision+1 where id=?").run(connectionId);
    const staleRevisionTransport = new StreamableHTTPClientTransport(runtimeUrl(), {
      fetch: fetcher,
      requestInit: {
        headers: {
          "x-connection-lease": lease.token,
        },
      },
    });
    const staleRevisionClient = new Client({ name: "stale-revision-runtime-test", version: "1.0.0" });
    await expect(staleRevisionClient.connect(staleRevisionTransport)).rejects.toThrow();
    await staleRevisionClient.close();
    database.prepare("update tenant_connections set revision=revision-1 where id=?").run(connectionId);
    const revoked = await app.request(`/v1/leases/${lease.claims.jti}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}` },
    });
    expect(revoked.status).toBe(200);
    const revokedTransport = new StreamableHTTPClientTransport(runtimeUrl(), {
      fetch: fetcher,
      requestInit: {
        headers: {
          "x-connection-lease": lease.token,
        },
      },
    });
    const revokedClient = new Client({ name: "revoked-runtime-test", version: "1.0.0" });
    await expect(revokedClient.connect(revokedTransport)).rejects.toThrow();
    await revokedClient.close();
    database.close();
  });

  it("cancels an in-flight MCP action when its lease is revoked", async () => {
    const database = new DatabaseSync(":memory:");
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider], { executableActionIds: ["fixture.read"] }),
      providerLoader: {
        loadActionExecutor: async () => async (_input, context) => {
          executionStarted();
          await new Promise<void>((resolve) =>
            context.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          return { ok: true, output: { value: "must-not-complete" } };
        },
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          customCredential: async () => ({ profile: { displayName: "fixture" } }),
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://127.0.0.1:3400",
      enablement: [{ service: "fixture", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const auth = createPrincipalToken(principal, "auth-secret");
    const created = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        service: "fixture",
        authType: "custom_credential",
        connectionName: "cancellation",
        values: { secret: "connection-secret" },
      }),
    });
    const connectionId = ((await created.json()) as { connection: { id: string } }).connection.id;
    const leaseResponse = await app.request(`/v1/connections/${connectionId}/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        allowedActions: ["fixture.read"],
        invocationId: "cancel-invocation",
        audience: "knowledge-runtime",
      }),
    });
    const lease = (await leaseResponse.json()) as { token: string; claims: { jti: string } };
    const url = new URL("https://connect.test/v1/runtime/mcp/sse");
    url.searchParams.set("connectionId", connectionId);
    url.searchParams.set("invocationId", "cancel-invocation");
    url.searchParams.set("audience", "knowledge-runtime");
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: async (input, init) => app.fetch(new Request(input, init)),
      requestInit: { headers: { "x-connection-lease": lease.token } },
    });
    const client = new Client({ name: "lease-cancellation-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const call = client.callTool({
        name: "execute_action",
        arguments: { actionId: "fixture.read", input: {} },
      });
      await started;
      const revoked = await app.request(`/v1/leases/${lease.claims.jti}/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${auth}` },
      });
      expect(revoked.status).toBe(200);
      const result = await call;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("lease_revoked");
    } finally {
      await client.close();
    }
    const audit = await app.request("/v1/audit?invocationId=cancel-invocation", {
      headers: { authorization: `Bearer ${auth}` },
    });
    await expect(audit.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          caller: "mcp",
          connectionId,
          actionId: "fixture.read",
          ok: false,
          errorCode: "execution_cancelled",
        }),
      ],
    });
    database.close();
  });

  it("completes a bearer-free OAuth callback from encrypted, tenant-bound state", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([oauthProvider]),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          oauth2: async () => ({ profile: { accountId: "feishu-user", displayName: "Feishu User" } }),
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://127.0.0.1:3400",
      enablement: [{ service: "feishu", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const auth = createPrincipalToken(principal, "auth-secret");
    const configured = await app.request("/v1/oauth/configs", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "feishu", clientId: "cli_test", clientSecret: "secret-value" }),
    });
    expect(configured.status).toBe(200);
    const started = await app.request("/v1/oauth/authorizations", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "feishu", connectionName: "my-feishu" }),
    });
    const authorization = (await started.json()) as { authorizationUrl: string; state: string };
    const authorizationUrl = new URL(authorization.authorizationUrl);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3400/oauth/callback");
    expect(authorization.state).toHaveLength(43);
    const stateRow = database.prepare("select * from tenant_oauth_states where state=?").get(authorization.state) as {
      tenant_id: string;
      workspace_id: string;
      subject: string;
      owner_id: string;
      value_ciphertext: string;
    };
    expect(stateRow).toMatchObject({
      tenant_id: principal.tenantId,
      workspace_id: principal.workspaceId,
      subject: principal.subject,
      owner_id: principal.ownerId,
    });
    expect(stateRow.value_ciphertext).toMatch(/^enc:v1:/u);
    expect(stateRow.value_ciphertext).not.toContain("secret-value");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ access_token: "access-token", refresh_token: "refresh-token", token_type: "Bearer" }),
      ),
    );
    const callback = await app.request(
      `/oauth/callback?state=${encodeURIComponent(authorization.state)}&code=authorization-code`,
    );
    expect(callback.status).toBe(200);
    const callbackHtml = await callback.text();
    expect(callbackHtml).toContain("Connection complete");
    expect(callbackHtml).not.toContain(authorization.state);
    expect(callbackHtml).not.toContain("authorization-code");
    expect(callbackHtml).not.toContain("access-token");
    expect(callbackHtml).not.toContain("secret-value");

    const status = await app.request(`/oauth/status?state=${encodeURIComponent(authorization.state)}`, {
      headers: { authorization: `Bearer ${auth}` },
    });
    await expect(status.json()).resolves.toEqual({
      service: "feishu",
      connectionName: "my-feishu",
      status: "connected",
    });
    const connections = await app.request("/v1/connections", { headers: { authorization: `Bearer ${auth}` } });
    await expect(connections.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ service: "feishu", connectionName: "my-feishu", status: "ready" })],
    });
    const replay = await app.request(
      `/oauth/callback?state=${encodeURIComponent(authorization.state)}&code=second-code`,
    );
    expect(replay.status).toBe(400);
    const otherAuth = createPrincipalToken(
      { ...principal, tenantId: "tenant-b", workspaceId: "workspace-b" },
      "auth-secret",
    );
    const otherCompletion = await app.request("/v1/oauth/complete", {
      method: "POST",
      headers: { authorization: `Bearer ${otherAuth}`, "content-type": "application/json" },
      body: JSON.stringify({ state: authorization.state, code: "other-tenant-code" }),
    });
    expect(otherCompletion.status).toBe(400);
    expect(await otherCompletion.text()).not.toContain("other-tenant-code");
    const otherStatus = await app.request(`/oauth/status?state=${encodeURIComponent(authorization.state)}`, {
      headers: { authorization: `Bearer ${otherAuth}` },
    });
    expect(otherStatus.status).toBe(404);
    database.close();
  });

  it("rejects malformed and provider-error callbacks without exchanging a code", async () => {
    const database = new DatabaseSync(":memory:");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const app = createConnectionControlApp({
      catalog: createCatalogStore([oauthProvider]),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({ oauth2: async () => ({}) }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://127.0.0.1:3400",
      enablement: [{ service: "feishu", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    expect((await app.request("/oauth/callback")).status).toBe(400);
    expect((await app.request("/oauth/callback?state=missing-code")).status).toBe(400);
    const providerError = await app.request(
      "/oauth/callback?error=access_denied&error_description=User+cancelled&state=unknown-state",
    );
    expect(providerError.status).toBe(400);
    expect(await providerError.text()).not.toContain("User cancelled");
    expect(fetcher).not.toHaveBeenCalled();
    const descriptionOnly = await app.request("/oauth/callback?error_description=User+cancelled&state=unknown-state");
    expect(descriptionOnly.status).toBe(400);
    expect(await descriptionOnly.text()).toContain("Feishu authorization was not completed");
    database.close();
  });

  it("expires a state at the callback boundary without creating a connection", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([oauthProvider]),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({ oauth2: async () => ({}) }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://127.0.0.1:3400",
      enablement: [{ service: "feishu", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const auth = createPrincipalToken(principal, "auth-secret");
    await app.request("/v1/oauth/configs", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "feishu", clientId: "cli_test", clientSecret: "secret-value" }),
    });
    const started = await app.request("/v1/oauth/authorizations", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "feishu", connectionName: "expired" }),
    });
    const { state } = (await started.json()) as { state: string };
    const expiredAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    database.prepare("update tenant_oauth_states set created_at=? where state=?").run(expiredAt, state);
    database.prepare("update tenant_oauth_flow_status set created_at=? where state=?").run(expiredAt, state);

    const callback = await app.request(`/oauth/callback?state=${state}&code=code`);
    expect(callback.status).toBe(400);
    const status = await app.request(`/oauth/status?state=${state}`, {
      headers: { authorization: `Bearer ${auth}` },
    });
    await expect(status.json()).resolves.toEqual({
      service: "feishu",
      connectionName: "expired",
      status: "expired",
    });
    const connections = await app.request("/v1/connections", { headers: { authorization: `Bearer ${auth}` } });
    await expect(connections.json()).resolves.toEqual({ items: [] });
    database.close();
  });

  it("migrates an existing SQLite OAuth schema and completes a pending flow after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "connection-service-oauth-restart-"));
    tempRoots.push(root);
    const databasePath = join(root, "control.sqlite");
    const firstDatabase = new DatabaseSync(databasePath);
    firstDatabase.exec(`
      create table tenant_oauth_states (
        state text primary key,
        tenant_id text not null,
        workspace_id text not null,
        value_ciphertext text not null,
        created_at text not null
      );
    `);
    const firstApp = createConnectionControlApp({
      catalog: createCatalogStore([oauthProvider]),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          oauth2: async () => ({ profile: { accountId: "feishu-user" } }),
        }),
      },
      controlDatabase: firstDatabase,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://127.0.0.1:3400",
      enablement: [{ service: "feishu", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const auth = createPrincipalToken(principal, "auth-secret");
    await firstApp.request("/v1/oauth/configs", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "feishu", clientId: "cli_test", clientSecret: "secret-value" }),
    });
    const started = await firstApp.request("/v1/oauth/authorizations", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "feishu", connectionName: "restart-persisted" }),
    });
    const authorization = (await started.json()) as { state: string };
    expect(
      (firstDatabase.prepare("pragma table_info(tenant_oauth_states)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    ).toEqual(expect.arrayContaining(["subject", "owner_id"]));
    const pendingStatus = await firstApp.request(`/oauth/status?state=${authorization.state}`, {
      headers: { authorization: `Bearer ${auth}` },
    });
    await expect(pendingStatus.json()).resolves.toMatchObject({ status: "pending" });
    firstDatabase.close();

    const secondDatabase = new DatabaseSync(databasePath);
    const secondApp = createConnectionControlApp({
      catalog: createCatalogStore([oauthProvider]),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          oauth2: async () => ({ profile: { accountId: "feishu-user" } }),
        }),
      },
      controlDatabase: secondDatabase,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://127.0.0.1:3400",
      enablement: [{ service: "feishu", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ access_token: "access-token", token_type: "Bearer" })),
    );
    const callback = await secondApp.request(
      `/oauth/callback?state=${encodeURIComponent(authorization.state)}&code=authorization-code`,
    );
    expect(callback.status).toBe(200);
    const connectedStatus = await secondApp.request(`/oauth/status?state=${authorization.state}`, {
      headers: { authorization: `Bearer ${auth}` },
    });
    await expect(connectedStatus.json()).resolves.toMatchObject({ status: "connected" });
    secondDatabase.close();

    const thirdDatabase = new DatabaseSync(databasePath);
    const thirdApp = createConnectionControlApp({
      catalog: createCatalogStore([oauthProvider]),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          oauth2: async () => ({ profile: { accountId: "feishu-user" } }),
        }),
      },
      controlDatabase: thirdDatabase,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://127.0.0.1:3400",
      enablement: [{ service: "feishu", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const connections = await thirdApp.request("/v1/connections", { headers: { authorization: `Bearer ${auth}` } });
    await expect(connections.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ service: "feishu", connectionName: "restart-persisted", status: "ready" })],
    });
    thirdDatabase.close();
  });

  it("does not create a half-finished connection when the token endpoint fails", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([oauthProvider]),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          oauth2: async () => ({ profile: { accountId: "feishu-user" } }),
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://127.0.0.1:3400",
      enablement: [{ service: "feishu", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const auth = createPrincipalToken(principal, "auth-secret");
    await app.request("/v1/oauth/configs", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "feishu", clientId: "cli_test", clientSecret: "secret-value" }),
    });
    const started = await app.request("/v1/oauth/authorizations", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "feishu", connectionName: "failed" }),
    });
    const { state } = (await started.json()) as { state: string };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("provider failure", { status: 500 })),
    );
    const callback = await app.request(`/oauth/callback?state=${state}&code=code`);
    expect(callback.status).toBe(400);
    const listed = await app.request("/v1/connections", { headers: { authorization: `Bearer ${auth}` } });
    await expect(listed.json()).resolves.toEqual({ items: [] });
    database.close();
  });

  it("persists the lease invocation id in the redacted audit feed", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider], { executableActionIds: ["fixture.read"] }),
      providerLoader: {
        loadActionExecutor: async () => async () => ({ ok: true, output: { value: "safe" } }),
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          customCredential: async () => ({ profile: { displayName: "fixture" } }),
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://localhost:3417",
      enablement: [{ service: "fixture", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const auth = createPrincipalToken(principal, "auth-secret");
    const created = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        service: "fixture",
        authType: "custom_credential",
        connectionName: "audit",
        values: { secret: "do-not-leak" },
      }),
    });
    const connectionId = ((await created.json()) as { connection: { id: string } }).connection.id;
    const lease = await app.request(`/v1/connections/${connectionId}/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        allowedActions: ["fixture.read"],
        invocationId: "invocation-from-lease",
        audience: "knowledge-runtime",
      }),
    });
    const leaseToken = ((await lease.json()) as { token: string }).token;
    const invoked = await app.request("/v1/runtime/actions/fixture.read", {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth}`,
        "content-type": "application/json",
        "x-connection-lease": leaseToken,
      },
      body: JSON.stringify({
        connectionId,
        invocationId: "invocation-from-lease",
        audience: "knowledge-runtime",
        input: {},
      }),
    });
    expect(invoked.status).toBe(200);
    const audit = await app.request("/v1/audit", { headers: { authorization: `Bearer ${auth}` } });
    const auditBody = (await audit.json()) as { items: Array<Record<string, unknown>> };
    expect(auditBody.items[0]).toMatchObject({
      invocationId: "invocation-from-lease",
      actionId: "fixture.read",
      connectionId,
      ok: true,
    });
    expect(JSON.stringify(auditBody)).not.toContain("do-not-leak");
    const other = createPrincipalToken(
      { ...principal, tenantId: "tenant-b", workspaceId: "workspace-b" },
      "auth-secret",
    );
    const otherAudit = await app.request("/v1/audit", { headers: { authorization: `Bearer ${other}` } });
    expect(await otherAudit.json()).toEqual({ items: [] });
    database.close();
  });

  it("authorizes provider-observed resources only after a successful leased action", async () => {
    const database = new DatabaseSync(":memory:");
    const officeProvider: ProviderDefinition = {
      service: "tencent_docs",
      displayName: "Tencent Docs fixture",
      categories: ["test"],
      authTypes: ["custom_credential"],
      auth: [
        {
          type: "custom_credential",
          fields: [{ key: "secret", label: "Secret", inputType: "password", required: true, secret: true }],
        },
      ],
      actions: [
        {
          id: "tencent_docs.search_files",
          service: "tencent_docs",
          name: "search_files",
          description: "Search fixture files.",
          requiredScopes: [],
          providerPermissions: [],
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
        {
          id: "tencent_docs.get_doc_content",
          service: "tencent_docs",
          name: "get_doc_content",
          description: "Read a discovered fixture document.",
          requiredScopes: [],
          providerPermissions: [],
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          resourceBindings: { fileID: ["application/vnd.tencent-docs.doc"] },
        },
      ],
    };
    let searchSucceeds = false;
    const observeActionResources = vi.fn(async () => [
      {
        sourceType: "tencent_docs" as const,
        resourceId: "nested-doc",
        mimeType: "application/vnd.tencent-docs.doc",
      },
    ]);
    const app = createConnectionControlApp({
      catalog: createCatalogStore([officeProvider], {
        executableActionIds: ["tencent_docs.search_files", "tencent_docs.get_doc_content"],
      }),
      providerLoader: {
        loadActionExecutor: async (_service, actionId) =>
          actionId === "tencent_docs.search_files"
            ? async () =>
                searchSucceeds
                  ? { ok: true, output: { items: [{ ID: "nested-doc" }] } }
                  : { ok: false, error: { code: "provider_error", message: "search failed" } }
            : async () => ({ ok: true, output: { document: "safe" } }),
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          customCredential: async () => ({ profile: { accountId: "validated" } }),
        }),
        observeActionResources,
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://localhost:3417",
      enablement: [{ service: "tencent_docs", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const auth = createPrincipalToken(principal, "auth-secret");
    const created = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        service: "tencent_docs",
        authType: "custom_credential",
        values: { secret: "secret" },
      }),
    });
    const connectionId = ((await created.json()) as { connection: { id: string } }).connection.id;
    const leaseResponse = await app.request(`/v1/connections/${connectionId}/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        allowedActions: ["tencent_docs.search_files", "tencent_docs.get_doc_content"],
        invocationId: "observe-invocation",
        audience: "knowledge-runtime",
      }),
    });
    const lease = (await leaseResponse.json()) as { token: string };
    const invoke = (actionId: string, input: Record<string, unknown>) =>
      app.request(`/v1/runtime/actions/${actionId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth}`,
          "content-type": "application/json",
          "x-connection-lease": lease.token,
        },
        body: JSON.stringify({
          connectionId,
          invocationId: "observe-invocation",
          audience: "knowledge-runtime",
          input,
        }),
      });

    expect((await invoke("tencent_docs.get_doc_content", { fileID: "nested-doc" })).status).toBe(502);
    expect((await invoke("tencent_docs.search_files", {})).status).toBe(502);
    expect(observeActionResources).not.toHaveBeenCalled();
    expect((await invoke("tencent_docs.get_doc_content", { fileID: "nested-doc" })).status).toBe(502);

    searchSucceeds = true;
    expect((await invoke("tencent_docs.search_files", {})).status).toBe(200);
    expect(observeActionResources).toHaveBeenCalledOnce();
    expect((await invoke("tencent_docs.get_doc_content", { fileID: "nested-doc" })).status).toBe(200);
    expect((await invoke("tencent_docs.get_doc_content", { fileID: "guessed-doc" })).status).toBe(502);
    database.close();
  });

  it("streams an authenticated multipart upload through staged tenant file intake", async () => {
    const root = await mkdtemp(join(tmpdir(), "connection-control-upload-"));
    tempRoots.push(root);
    const stagedPath = join(root, "request.tmp");
    await writeFile(stagedPath, "name,amount\nAda,42\n");
    const fileStore = new TransitFileService({
      rootDir: join(root, "files"),
      publicOrigin: "http://localhost:3417",
      ttlSeconds: 60,
      maxBytes: 1024 * 1024,
    });
    const stageFileUpload = vi.fn(async (_request: Request, consume) =>
      consume({ path: stagedPath, sizeBytes: 19, name: "people.csv", mimeType: "text/csv" }),
    );
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider], { executableActionIds: ["fixture.read"] }),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => undefined,
      },
      controlDatabase: new DatabaseSync(":memory:"),
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://localhost:3417",
      enablement: [],
      fileStore,
      stageFileUpload,
    });
    const auth = createPrincipalToken(principal, "auth-secret");

    const response = await app.request("/v1/files", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "multipart/form-data; boundary=fixture" },
      body: "--fixture--",
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ file: { kind: "csv", scanStatus: "clean", sizeBytes: 19 } });
    expect(stageFileUpload).toHaveBeenCalledOnce();
    const listed = await app.request("/v1/files", { headers: { authorization: `Bearer ${auth}` } });
    expect(await listed.json()).toMatchObject({ items: [{ kind: "csv", tenantId: "tenant-a" }] });
  });

  it("isolates tenants and never returns credentials", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider], { executableActionIds: ["fixture.read"] }),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => undefined,
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://localhost:3417",
      enablement: [{ service: "fixture", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const auth = createPrincipalToken(principal, "auth-secret");
    const created = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "fixture", authType: "custom_credential", values: { secret: "do-not-leak" } }),
    });
    expect(created.status).toBe(201);
    const payload = (await created.json()) as { connection: Record<string, unknown> };
    expect(JSON.stringify(payload)).not.toContain("do-not-leak");
    const encrypted = database.prepare("select credential_ciphertext from tenant_connections").get() as {
      credential_ciphertext: string;
    };
    expect(encrypted.credential_ciphertext).toMatch(/^enc:v1:/);
    const other = createPrincipalToken(
      { ...principal, tenantId: "tenant-b", workspaceId: "workspace-b" },
      "auth-secret",
    );
    const listed = await app.request("/v1/connections", { headers: { authorization: `Bearer ${other}` } });
    expect(await listed.json()).toEqual({ items: [] });
    const lease = await app.request("/v1/connections/unknown/lease", {
      method: "POST",
      headers: { authorization: `Bearer ${other}`, "content-type": "application/json" },
      body: JSON.stringify({
        allowedActions: ["fixture.read"],
        invocationId: "inv-1",
        audience: "knowledge-runtime",
      }),
    });
    expect(lease.status).toBe(404);
    database.close();
  });

  it("requires a lease for Oracle compatibility discovery", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider], { executableActionIds: ["fixture.read"] }),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => undefined,
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://localhost:3417",
      enablement: [],
    });
    const auth = createPrincipalToken(principal, "auth-secret");
    const response = await app.request("/v1/adapters/oracle/discover", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        config: { host: "db", port: 1521, serviceName: "FREEPDB1" },
        user: "reader",
        password: "secret",
        allowedSchemas: ["APP"],
        schema: "APP",
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "lease_required" } });
    database.close();
  });

  it("enforces personal/team visibility and owner-only connection management", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider], { executableActionIds: ["fixture.read"] }),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => undefined,
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://localhost:3417",
      enablement: [{ service: "fixture", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const ownerToken = createPrincipalToken(principal, "auth-secret");
    const teammateToken = createPrincipalToken({ ...principal, subject: "user-b", ownerId: "user-b" }, "auth-secret");
    const created = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "fixture", authType: "custom_credential", values: { secret: "secret" } }),
    });
    const connectionId = String(((await created.json()) as { connection: { id: string } }).connection.id);

    const hidden = await app.request("/v1/connections", {
      headers: { authorization: `Bearer ${teammateToken}` },
    });
    expect(await hidden.json()).toEqual({ items: [] });

    const shared = await app.request(`/v1/connections/${connectionId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ visibility: "team" }),
    });
    expect(shared.status).toBe(200);
    expect(await shared.json()).toMatchObject({ connection: { id: connectionId, visibility: "team", revision: 2 } });

    const visible = await app.request("/v1/connections", {
      headers: { authorization: `Bearer ${teammateToken}` },
    });
    expect(await visible.json()).toMatchObject({ items: [{ id: connectionId }] });
    const teammateLease = await app.request(`/v1/connections/${connectionId}/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${teammateToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        allowedActions: ["fixture.read"],
        invocationId: "team-invocation",
        audience: "knowledge-runtime",
      }),
    });
    const { claims } = (await teammateLease.json()) as { claims: { jti: string } };
    const forbidden = await app.request(`/v1/connections/${connectionId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${teammateToken}`, "content-type": "application/json" },
      body: JSON.stringify({ connectionName: "stolen" }),
    });
    expect(forbidden.status).toBe(403);

    await app.request(`/v1/connections/${connectionId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ visibility: "personal" }),
    });
    expect(database.prepare("select revoked_at from connection_leases where jti=?").get(claims.jti)).toMatchObject({
      revoked_at: expect.any(String),
    });
    database.close();
  });

  it("revokes a connection and all of its active leases", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider], { executableActionIds: ["fixture.read"] }),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => undefined,
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://localhost:3417",
      enablement: [{ service: "fixture", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const auth = createPrincipalToken(principal, "auth-secret");
    const created = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "fixture", authType: "custom_credential", values: { secret: "secret" } }),
    });
    const connectionId = String(((await created.json()) as { connection: { id: string } }).connection.id);
    const leaseResponse = await app.request(`/v1/connections/${connectionId}/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        allowedActions: ["fixture.read"],
        invocationId: "inv-1",
        audience: "knowledge-runtime",
      }),
    });
    const lease = (await leaseResponse.json()) as { claims: { jti: string } };

    const revoked = await app.request(`/v1/connections/${connectionId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${auth}` },
    });
    expect(revoked.status).toBe(204);
    expect(database.prepare("select status from tenant_connections where id=?").get(connectionId)).toEqual({
      status: "revoked",
    });
    expect(
      database.prepare("select revoked_at from connection_leases where jti=?").get(lease.claims.jti),
    ).toMatchObject({
      revoked_at: expect.any(String),
    });
    database.close();
  });

  it("grants and removes explicit connection use ACLs with lease revocation", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider], { executableActionIds: ["fixture.read"] }),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => undefined,
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://localhost:3417",
      enablement: [{ service: "fixture", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const ownerToken = createPrincipalToken(principal, "auth-secret");
    const teammateToken = createPrincipalToken({ ...principal, subject: "user-b", ownerId: "user-b" }, "auth-secret");
    const created = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "fixture", authType: "custom_credential", values: { secret: "secret" } }),
    });
    const connectionId = String(((await created.json()) as { connection: { id: string } }).connection.id);

    const granted = await app.request(`/v1/connections/${connectionId}/acl`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ subjects: ["user-b"] }),
    });
    expect(await granted.json()).toEqual({ acl: [{ subject: "user-b", permission: "use" }] });
    const visible = await app.request("/v1/connections", {
      headers: { authorization: `Bearer ${teammateToken}` },
    });
    expect(await visible.json()).toMatchObject({ items: [{ id: connectionId }] });

    const leaseResponse = await app.request(`/v1/connections/${connectionId}/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${teammateToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        allowedActions: ["fixture.read"],
        invocationId: "inv-acl",
        audience: "knowledge-runtime",
      }),
    });
    const lease = (await leaseResponse.json()) as { claims: { jti: string } };
    await app.request(`/v1/connections/${connectionId}/acl`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ subjects: [] }),
    });

    const hidden = await app.request("/v1/connections", {
      headers: { authorization: `Bearer ${teammateToken}` },
    });
    expect(await hidden.json()).toEqual({ items: [] });
    expect(
      database.prepare("select revoked_at from connection_leases where jti=?").get(lease.claims.jti),
    ).toMatchObject({
      revoked_at: expect.any(String),
    });
    database.close();
  });

  it("runs durable tenant-scoped validation and discovery jobs", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider], { executableActionIds: ["fixture.read"] }),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          customCredential: async () => ({ profile: { accountId: "validated" } }),
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://localhost:3417",
      enablement: [{ service: "fixture", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const auth = createPrincipalToken(principal, "auth-secret");
    const created = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "fixture", authType: "custom_credential", values: { secret: "secret" } }),
    });
    const connectionId = String(((await created.json()) as { connection: { id: string } }).connection.id);

    const validation = await app.request(`/v1/connections/${connectionId}/validate`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}` },
    });
    expect(validation.status).toBe(202);
    const validationJob = (await validation.json()) as { job: { id: string } };
    const fetched = await app.request(`/v1/jobs/${validationJob.job.id}`, {
      headers: { authorization: `Bearer ${auth}` },
    });
    expect(await fetched.json()).toMatchObject({
      job: { id: validationJob.job.id, kind: "validate", status: "succeeded" },
    });

    const discovery = await app.request(`/v1/connections/${connectionId}/discover`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}` },
    });
    expect(discovery.status).toBe(401);
    expect(await discovery.json()).toMatchObject({
      error: { code: "lease_required" },
    });
    expect(
      database.prepare("select invocation_id, ok, error_code, detail_json from control_execution_audit").get(),
    ).toMatchObject({
      invocation_id: expect.any(String),
      ok: 0,
      error_code: "lease_required",
      detail_json: expect.not.stringContaining("secret"),
    });

    const discoveryLeaseResponse = await app.request(`/v1/connections/${connectionId}/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        allowedActions: ["fixture.discover_resources"],
        invocationId: "discover-invocation",
        audience: "knowledge-runtime",
      }),
    });
    expect(discoveryLeaseResponse.status).toBe(201);
    const discoveryLease = (await discoveryLeaseResponse.json()) as { token: string };

    const leasedDiscovery = await app.request(`/v1/connections/${connectionId}/discover`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth}`,
        "x-connection-lease": discoveryLease.token,
        "x-connection-invocation-id": "discover-invocation",
        "x-connection-audience": "knowledge-runtime",
      },
    });
    expect(leasedDiscovery.status).toBe(202);
    expect(await leasedDiscovery.json()).toMatchObject({
      job: {
        kind: "discover",
        status: "succeeded",
        result: { service: "fixture", resources: [], actions: [expect.objectContaining({ id: "fixture.read" })] },
      },
    });

    const updated = await app.request(`/v1/connections/${connectionId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ connectionName: "renamed" }),
    });
    expect(updated.status).toBe(200);
    const staleDiscovery = await app.request(`/v1/connections/${connectionId}/discover`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth}`,
        "x-connection-lease": discoveryLease.token,
        "x-connection-invocation-id": "discover-invocation",
        "x-connection-audience": "knowledge-runtime",
      },
    });
    expect(staleDiscovery.status).toBe(401);
    expect(await staleDiscovery.json()).toMatchObject({ error: { code: "lease_scope_denied" } });
    database.close();
  });

  it("issues a scoped SQL discovery lease when discovery is a synthetic control-plane action", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([postgresqlProvider], {
        executableActionIds: ["postgresql.execute_read_query"],
      }),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          customCredential: async () => ({ profile: { accountId: "postgresql" } }),
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://localhost:3417",
      enablement: [
        {
          service: "postgresql",
          tier: "verified",
          connectorDefinitionVersion: "1.0.0",
          owner: "team",
        },
      ],
    });
    const auth = createPrincipalToken(principal, "auth-secret");
    const created = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        service: "postgresql",
        authType: "custom_credential",
        values: { secret: "secret" },
      }),
    });
    const connectionId = String(((await created.json()) as { connection: { id: string } }).connection.id);

    const lease = await app.request(`/v1/connections/${connectionId}/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        allowedActions: ["postgresql.discover_resources"],
        invocationId: "postgresql-discovery",
        audience: "knowledge-runtime",
      }),
    });

    expect(lease.status).toBe(201);
    await expect(lease.json()).resolves.toMatchObject({
      claims: {
        allowedActions: ["postgresql.discover_resources"],
        invocationId: "postgresql-discovery",
      },
    });
    database.close();
  });

  it("does not let a shared-connection teammate lease storage mutation or presign capabilities", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider], { executableActionIds: ["fixture.read"] }),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          customCredential: async () => ({ profile: { accountId: "validated" } }),
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://localhost:3417",
      enablement: [{ service: "fixture", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const ownerToken = createPrincipalToken(principal, "auth-secret");
    const teammateToken = createPrincipalToken({ ...principal, subject: "user-b", ownerId: "user-b" }, "auth-secret");
    const created = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "fixture", authType: "custom_credential", values: { secret: "secret" } }),
    });
    const connectionId = String(((await created.json()) as { connection: { id: string } }).connection.id);
    await app.request(`/v1/connections/${connectionId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ visibility: "team" }),
    });

    const lease = await app.request(`/v1/connections/${connectionId}/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${teammateToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        allowedActions: ["aws_s3.put_object", "aws_s3.generate_presigned_url"],
        invocationId: "inv-owner-gate",
        audience: "knowledge-runtime",
      }),
    });

    expect(lease.status).toBe(403);
    expect(await lease.json()).toMatchObject({
      error: {
        code: "lease_action_forbidden",
        message: "A connection lease may include only actions owned by that connection.",
      },
    });
    database.close();
  });

  it("does not issue Agent leases for office mutations or generic MCP calls", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider], { executableActionIds: ["fixture.read"] }),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          customCredential: async () => ({ profile: { accountId: "validated" } }),
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://localhost:3417",
      enablement: [{ service: "fixture", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const token = createPrincipalToken(principal, "auth-secret");
    const created = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "fixture", authType: "custom_credential", values: { secret: "secret" } }),
    });
    const connectionId = String(((await created.json()) as { connection: { id: string } }).connection.id);
    const lease = await app.request(`/v1/connections/${connectionId}/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        allowedActions: [
          "tencent_docs.batch_update_doc",
          "tencent_docs.convert_file_id",
          "wps_mcp.list_tools",
          "wps_mcp.call_tool",
          "baidu_netdisk.create_share_link",
        ],
        invocationId: "inv-read-only",
        audience: "knowledge-runtime",
      }),
    });
    expect(lease.status).toBe(403);
    expect(await lease.json()).toMatchObject({ error: { code: "lease_action_forbidden" } });
    database.close();
  });

  it("denies unclassified actions by default instead of assuming they are read-only", async () => {
    const database = new DatabaseSync(":memory:");
    const ambiguousProvider: ProviderDefinition = {
      ...provider,
      actions: [
        {
          ...provider.actions[0],
          id: "fixture.process",
          name: "process",
          description: "An action whose side effects are not classified.",
        },
      ],
    };
    const app = createConnectionControlApp({
      catalog: createCatalogStore([ambiguousProvider], { executableActionIds: ["fixture.process"] }),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          customCredential: async () => ({ profile: { accountId: "validated" } }),
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://localhost:3417",
      enablement: [{ service: "fixture", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const token = createPrincipalToken(principal, "auth-secret");
    const created = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "fixture", authType: "custom_credential", values: { secret: "secret" } }),
    });
    const connectionId = String(((await created.json()) as { connection: { id: string } }).connection.id);
    const lease = await app.request(`/v1/connections/${connectionId}/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        allowedActions: ["fixture.process"],
        invocationId: "inv-default-deny",
        audience: "knowledge-runtime",
      }),
    });
    expect(lease.status).toBe(403);
    expect(await lease.json()).toMatchObject({ error: { code: "lease_action_forbidden" } });
    database.close();
  });

  it("does not issue a lease for actions owned by another provider", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider], { executableActionIds: ["fixture.read"] }),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          customCredential: async () => ({ profile: { accountId: "validated" } }),
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://localhost:3417",
      enablement: [{ service: "fixture", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const token = createPrincipalToken(principal, "auth-secret");
    const created = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "fixture", authType: "custom_credential", values: { secret: "secret" } }),
    });
    const connectionId = String(((await created.json()) as { connection: { id: string } }).connection.id);

    const lease = await app.request(`/v1/connections/${connectionId}/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        allowedActions: ["baidu_netdisk.download_file"],
        invocationId: "inv-cross-provider",
        audience: "knowledge-runtime",
      }),
    });

    expect(lease.status).toBe(403);
    expect(await lease.json()).toMatchObject({ error: { code: "lease_action_forbidden" } });
    database.close();
  });

  it("rejects cross-provider and ERP legacy actions at lease issuance", async () => {
    const database = new DatabaseSync(":memory:");
    const erpProvider: ProviderDefinition = {
      ...provider,
      service: "erpnext",
      actions: [
        {
          id: "erpnext.list_entities",
          service: "erpnext",
          name: "list_entities",
          description: "Bounded ERP read.",
          requiredScopes: [],
          providerPermissions: [],
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
        {
          id: "erpnext.create_document",
          service: "erpnext",
          name: "create_document",
          description: "Legacy ERP write.",
          requiredScopes: [],
          providerPermissions: [],
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      ],
    };
    const app = createConnectionControlApp({
      catalog: createCatalogStore([erpProvider], {
        executableActionIds: ["erpnext.list_entities", "erpnext.create_document"],
      }),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          customCredential: async () => ({ profile: { accountId: "validated" } }),
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://localhost:3417",
      enablement: [{ service: "erpnext", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const auth = createPrincipalToken(principal, "auth-secret");
    const created = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "erpnext", authType: "custom_credential", values: { secret: "secret" } }),
    });
    expect(created.status).toBe(201);
    const connectionId = String(((await created.json()) as { connection: { id: string } }).connection.id);

    for (const [action, status, code] of [
      ["netsuite.list_entities", 400, "invalid_action"],
      ["erpnext.create_document", 403, "action_not_allowed"],
    ] as const) {
      const lease = await app.request(`/v1/connections/${connectionId}/lease`, {
        method: "POST",
        headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: JSON.stringify({
          allowedActions: [action],
          invocationId: "inv-erp-policy",
          audience: "knowledge-runtime",
        }),
      });
      expect(lease.status).toBe(status);
      expect(await lease.json()).toMatchObject({ error: { code } });
    }

    const readLease = await app.request(`/v1/connections/${connectionId}/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        allowedActions: ["erpnext.list_entities"],
        invocationId: "inv-erp-read",
        audience: "knowledge-runtime",
      }),
    });
    expect(readLease.status).toBe(201);
    database.close();
  });

  it("persists failed validation and marks the connection error", async () => {
    const database = new DatabaseSync(":memory:");
    const validateCredential = vi
      .fn()
      .mockResolvedValueOnce({ profile: { accountId: "created" } })
      .mockRejectedValueOnce(new Error("upstream rejected credential"));
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider], { executableActionIds: ["fixture.read"] }),
      providerLoader: {
        loadActionExecutor: async () => undefined,
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          customCredential: validateCredential,
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "http://localhost:3417",
      enablement: [{ service: "fixture", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "team" }],
    });
    const auth = createPrincipalToken(principal, "auth-secret");
    const created = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ service: "fixture", authType: "custom_credential", values: { secret: "secret" } }),
    });
    const connectionId = String(((await created.json()) as { connection: { id: string } }).connection.id);
    const validation = await app.request(`/v1/connections/${connectionId}/validate`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}` },
    });

    expect(await validation.json()).toMatchObject({
      job: {
        kind: "validate",
        status: "failed",
        error: { code: "credential_verification_failed" },
      },
    });
    expect(database.prepare("select status from tenant_connections where id=?").get(connectionId)).toEqual({
      status: "error",
    });
    database.close();
  });
});
