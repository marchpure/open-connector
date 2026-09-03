import type { ProviderDefinition } from "../core/types.ts";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { createDatabaseActions } from "../core/database/actions.ts";
import { hashApiKey } from "../identity/api-key.ts";
import { AesGcmSecretCodec } from "../server/secrets/secret-codec.ts";
import { createPrincipalToken } from "./auth.ts";
import { createConnectionControlApp } from "./server.ts";

const oracleProvider: ProviderDefinition = {
  service: "oracle_database",
  displayName: "Oracle Database",
  categories: ["Data"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        { key: "username", label: "Username", inputType: "text", required: true, secret: false },
        { key: "password", label: "Password", inputType: "password", required: true, secret: true },
      ],
    },
  ],
  actions: createDatabaseActions("oracle_database", "Oracle Database"),
};

const owner = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  subject: "owner-subject",
  ownerId: "owner",
  audience: "asi",
};

describe("ArkClaw resource-scoped MCP", () => {
  it("registers an existing Application Center provider and accepts the MSE resource id at the gateway boundary", async () => {
    const database = new DatabaseSync(":memory:");
    const actionId = "oracle_database.list_tables";
    const createResource = vi.fn(async () => ({
      Id: "mse-oracle-1",
      Status: "Ready",
      NetworkConfig: { GatewayUrl: "https://gateway.example/mcp/resources" },
    }));
    const registry = {
      createResource,
      getResource: vi.fn(),
      listResources: vi.fn(),
      deleteResource: vi.fn(),
    };
    const app = createConnectionControlApp({
      catalog: createCatalogStore([oracleProvider], { executableActionIds: [actionId] }),
      providerLoader: {
        loadActionExecutor: async () => async (_input, context) => {
          await context.getCredential("oracle_database");
          return { ok: true, output: { listed: true } };
        },
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          customCredential: async () => ({ profile: { displayName: "oracle", accountId: "oracle" } }),
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "https://connect.test",
      enablement: [
        {
          service: "oracle_database",
          tier: "beta",
          connectorDefinitionVersion: "1",
          owner: "team",
          evidenceRef: "test",
        },
      ],
      arkclaw: {
        apiKeyHashes: [hashApiKey("business-key")],
        verifyTip: async () => ({
          issuer: "https://issuer.example",
          claims: {},
          principal: { ...owner, userPoolUserUid: "pool-user", groups: ["oracle-readers"] },
        }),
      },
      applicationCenter: {
        registry,
        spaceId: "space-1",
        clawId: "claw-1",
        userPoolUserUid: "pool-user",
      },
    });
    const auth = createPrincipalToken(owner, "auth-secret");
    const connection = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        service: "oracle_database",
        authType: "custom_credential",
        connectionName: "anta-managed",
        credentialRef: "identity://oracle/anta",
        values: { host: "oracle.example", serviceName: "ANTA" },
      }),
    });
    const connectionId = String(((await connection.json()) as { connection: { id: string } }).connection.id);
    const registered = await app.request("/v1/app-resources", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        resourceId: "anta-oracle",
        displayName: "Anta Oracle",
        connectionId,
        allowedActions: [actionId],
        allowedGroups: ["oracle-readers"],
        proxyCredential: {
          mode: "reference",
          type: "api_key",
          credentialProviderName: "business-api-key-provider",
        },
        ingressApiKeyHashes: [hashApiKey("business-key")],
      }),
    });
    expect(registered.status).toBe(201);
    const responseBody = (await registered.json()) as {
      resource: { mseResourceId: string; gateway: { url: string; headers: Record<string, string> } };
    };
    expect(responseBody.resource).toMatchObject({
      mseResourceId: "mse-oracle-1",
      gateway: {
        url: "https://gateway.example/mcp/resources",
        headers: { "X-App-ResourceId": "mse-oracle-1", "X-Ve-TIP-Token": "${VE_TIP_TOKEN}" },
      },
    });
    expect(createResource).toHaveBeenCalledWith(
      expect.objectContaining({
        authConfig: { Type: "KEY_AUTH", ApikeyConfig: [{ CredentialProviderName: "business-api-key-provider" }] },
      }),
      expect.any(AbortSignal),
    );

    const mcpResponse = await app.request("/mcp/apps/anta-oracle", {
      method: "POST",
      headers: {
        authorization: "Bearer business-key",
        "x-ve-tip-token": "tip",
        "x-app-resourceid": "mse-oracle-1",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }),
    });
    expect(mcpResponse.status).toBe(200);

    const duplicate = await app.request("/v1/app-resources", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        resourceId: "anta-oracle",
        displayName: "Anta Oracle Copy",
        connectionId,
        allowedActions: [actionId],
        proxyCredential: {
          mode: "reference",
          type: "api_key",
          credentialProviderName: "business-api-key-provider",
        },
        ingressApiKeyHashes: [hashApiKey("business-key")],
      }),
    });
    expect(duplicate.status).toBe(409);
    expect(createResource).toHaveBeenCalledTimes(1);

    const rawProvisioning = await app.request("/v1/app-resources", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        resourceId: "raw-provisioning",
        displayName: "Raw Provisioning",
        connectionId,
        allowedActions: [actionId],
        credentialAuthConfig: {
          Type: "api_key",
          ApikeyConfig: [{ Name: "raw-provider", ApiKey: "must-not-be-accepted" }],
        },
      }),
    });
    expect(rawProvisioning.status).toBe(403);
    expect(JSON.stringify(await rawProvisioning.json())).not.toContain("must-not-be-accepted");
    expect(createResource).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("requires API key, TIP, resource ACL, and executes only the bound Oracle connection", async () => {
    const database = new DatabaseSync(":memory:");
    const listTables = "oracle_database.list_tables";
    const executeQuery = "oracle_database.execute_read_query";
    const usedCredentials: string[] = [];
    const usedActors: unknown[] = [];
    const catalog = createCatalogStore([oracleProvider], { executableActionIds: [listTables, executeQuery] });
    const verifyTip = vi.fn(async (token: string) => {
      if (token === "invalid") throw new Error("invalid");
      return {
        issuer: "https://auth.id.cn-beijing.volces.com/workloadpool/test",
        claims: {},
        principal: {
          tenantId: token === "other-tenant" ? "tenant-b" : "tenant-a",
          workspaceId: "untrusted-workspace",
          subject: "tip-subject",
          ownerId: "tip-user",
          audience: "asi",
          groups: token === "wrong-group" ? ["other"] : ["oracle-readers"],
          agentId: token === "wrong-agent" ? "other-agent" : "claw-1",
        },
      };
    });
    const app = createConnectionControlApp({
      catalog,
      providerLoader: {
        loadActionExecutor: async (_service, actionId) => async (_input, context) => {
          const credential = await context.getCredential("oracle_database");
          if (credential?.authType === "custom_credential") usedCredentials.push(credential.values.password);
          usedActors.push(context.actor);
          return { ok: true, output: { actionId } };
        },
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          customCredential: async () => ({ profile: { displayName: "oracle", accountId: "oracle" } }),
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "https://connect.test",
      enablement: [
        {
          service: "oracle_database",
          tier: "beta",
          connectorDefinitionVersion: "1.0.0",
          owner: "team",
          evidenceRef: "test",
        },
      ],
      arkclaw: { apiKeyHashes: [hashApiKey("enterprise-key")], verifyTip },
    });
    const auth = createPrincipalToken(owner, "auth-secret");
    const connectionResponse = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        service: "oracle_database",
        authType: "custom_credential",
        connectionName: "anta",
        values: { username: "reader", password: "oracle-secret" },
      }),
    });
    expect(connectionResponse.status).toBe(201);
    const connectionId = String(((await connectionResponse.json()) as { connection: { id: string } }).connection.id);
    const resourceResponse = await app.request("/v1/app-resources", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        resourceId: "oracle-app",
        displayName: "Anta Oracle",
        connectionId,
        allowedActions: [listTables, executeQuery],
        allowedResources: { schemas: ["APP"], tables: ["APP.ORDERS"] },
        allowedGroups: ["oracle-readers"],
        allowedAgentIds: ["claw-1"],
        ingressApiKeyHashes: [hashApiKey("resource-key")],
      }),
    });
    expect(resourceResponse.status).toBe(201);

    const request = (headers: Record<string, string>) =>
      app.request("/mcp/arkclaw", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
        }),
      });
    await expect(request({})).resolves.toMatchObject({ status: 400 });
    await expect(request({ authorization: "Bearer wrong", "x-app-resourceid": "oracle-app" })).resolves.toMatchObject({
      status: 401,
    });
    await expect(
      request({ authorization: "Bearer enterprise-key", "x-app-resourceid": "oracle-app" }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      request({
        authorization: "Bearer resource-key",
        "x-ve-tip-token": "invalid",
        "x-app-resourceid": "oracle-app",
      }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      request({
        authorization: "Bearer resource-key",
        "x-ve-tip-token": "other-tenant",
        "x-app-resourceid": "oracle-app",
      }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      request({
        authorization: "Bearer resource-key",
        "x-ve-tip-token": "wrong-group",
        "x-app-resourceid": "oracle-app",
      }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      request({
        authorization: "Bearer resource-key",
        "x-ve-tip-token": "wrong-agent",
        "x-app-resourceid": "oracle-app",
      }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      request({
        authorization: "Bearer enterprise-key",
        "x-ve-tip-token": "valid-tip",
        "x-app-resourceid": "oracle-app",
      }),
    ).resolves.toMatchObject({ status: 401 });

    const transport = new StreamableHTTPClientTransport(new URL("https://connect.test/mcp/apps/oracle-app"), {
      fetch: async (input, init) => app.fetch(new Request(input, init)),
      requestInit: {
        headers: {
          authorization: "Bearer resource-key",
          "x-ve-tip-token": "valid-tip",
        },
      },
    });
    const client = new Client({ name: "arkclaw-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "list_allowed_actions",
        "get_action_guide",
        "execute_action",
        "list_tables",
        "execute_read_query",
      ]);
      const allowed = await client.callTool({ name: "list_allowed_actions", arguments: {} });
      expect(allowed.structuredContent).toMatchObject({
        ok: true,
        data: { resourceId: "oracle-app", actions: [{ id: listTables }, { id: executeQuery }] },
      });
      const outside = await client.callTool({
        name: "execute_action",
        arguments: { actionId: executeQuery, input: { query: "select * from OTHER.SECRETS" } },
      });
      expect(outside.isError).toBe(true);
      expect(JSON.stringify(outside)).toContain("outside the app resource scope");
      const executed = await client.callTool({
        name: "execute_read_query",
        arguments: { query: "select * from APP.ORDERS" },
      });
      expect(executed.structuredContent).toMatchObject({ ok: true, data: { actionId: executeQuery } });
      expect(JSON.stringify(executed)).not.toContain("oracle-secret");
      expect(usedCredentials).toEqual(["oracle-secret"]);
      expect(usedActors).toEqual([
        expect.objectContaining({ tenantId: "tenant-a", userId: "tip-user", agentId: "claw-1" }),
      ]);
    } finally {
      await client.close();
      database.close();
    }
  });

  it("resolves broker credentials per TIP user and returns an authorization URL on first use", async () => {
    const database = new DatabaseSync(":memory:");
    const actionId = "oracle_database.list_tables";
    const catalog = createCatalogStore([oracleProvider], { executableActionIds: [actionId] });
    let authorized = false;
    const broker = {
      resolve: vi.fn(async () =>
        authorized
          ? {
              status: "ready" as const,
              credential: {
                authType: "custom_credential" as const,
                values: {
                  username: "identity-reader",
                  password: "identity-secret",
                  host: "attacker.example",
                  serviceName: "ATTACKER",
                  allowedSchemas: "PUBLIC",
                },
                profile: { accountId: "identity-reader", displayName: "identity-reader", grantedScopes: ["read"] },
                metadata: {},
              },
            }
          : { status: "authorization_required" as const, authorizationUrl: "https://auth.example/authorize/state" },
      ),
    };
    const observedValues: Record<string, string>[] = [];
    const validatedValues: Record<string, string>[] = [];
    const app = createConnectionControlApp({
      catalog,
      providerLoader: {
        loadActionExecutor: async () => async (_input, context) => {
          const credential = await context.getCredential("oracle_database");
          if (credential?.authType === "custom_credential") observedValues.push(credential.values);
          return { ok: true, output: { rows: [] } };
        },
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          customCredential: async ({ values }) => {
            validatedValues.push(values);
            return { profile: { accountId: values.username, displayName: values.username } };
          },
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "https://connect.test",
      enablement: [
        {
          service: "oracle_database",
          tier: "beta",
          connectorDefinitionVersion: "1.0.0",
          owner: "team",
          evidenceRef: "test",
        },
      ],
      arkclaw: {
        apiKeyHashes: [hashApiKey("enterprise-key")],
        verifyTip: async () => ({
          issuer: "https://auth.id.example/pool",
          claims: {},
          principal: { ...owner, subject: "tip-subject", ownerId: "tip-user", groups: ["oracle-readers"] },
        }),
        credentialBroker: broker,
      },
    });
    const auth = createPrincipalToken(owner, "auth-secret");
    const rejected = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        service: "oracle_database",
        authType: "custom_credential",
        credentialRef: "identity://oracle/anta",
        values: { host: "db.example", serviceName: "ANTA", username: "must-not-store", password: "must-not-store" },
      }),
    });
    expect(rejected.status).toBe(400);
    const connectionResponse = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        service: "oracle_database",
        authType: "custom_credential",
        connectionName: "managed",
        credentialRef: "identity://oracle/anta",
        values: { host: "db.example", port: 1521, serviceName: "ANTA", allowedSchemas: "APP" },
      }),
    });
    expect(connectionResponse.status).toBe(201);
    const connectionId = String(((await connectionResponse.json()) as { connection: { id: string } }).connection.id);
    const stored = database
      .prepare("select credential_ciphertext from tenant_connections where id=?")
      .get(connectionId) as { credential_ciphertext: string };
    expect(stored.credential_ciphertext).not.toContain("identity-secret");
    const authorizationRequired = await app.request(`/v1/connections/${connectionId}/validate`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}` },
    });
    expect(await authorizationRequired.json()).toMatchObject({
      job: {
        status: "failed",
        error: {
          code: "authorization_required",
          authorizationUrl: "https://auth.example/authorize/state",
        },
      },
    });
    authorized = true;
    const validated = await app.request(`/v1/connections/${connectionId}/validate`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}` },
    });
    expect(await validated.json()).toMatchObject({ job: { status: "succeeded", result: { validated: true } } });
    expect(validatedValues).toEqual([
      expect.objectContaining({
        host: "db.example",
        serviceName: "ANTA",
        username: "identity-reader",
        password: "identity-secret",
      }),
    ]);
    authorized = false;
    const resourceResponse = await app.request("/v1/app-resources", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        resourceId: "managed-oracle",
        displayName: "Managed Oracle",
        connectionId,
        credentialRef: "identity://oracle/anta",
        allowedActions: [actionId],
        allowedGroups: ["oracle-readers"],
      }),
    });
    expect(resourceResponse.status).toBe(201);
    const transport = new StreamableHTTPClientTransport(new URL("https://connect.test/mcp/arkclaw"), {
      fetch: async (input, init) => app.fetch(new Request(input, init)),
      requestInit: {
        headers: {
          authorization: "Bearer enterprise-key",
          "x-ve-tip-token": "tip",
          "x-app-resourceid": "managed-oracle",
        },
      },
    });
    const client = new Client({ name: "broker-test", version: "1" });
    try {
      await client.connect(transport);
      const first = await client.callTool({
        name: "execute_action",
        arguments: { actionId, input: { schema: "APP" } },
      });
      expect(first.isError).toBe(true);
      expect(first.structuredContent).toMatchObject({
        error: { code: "authorization_required", authorizationUrl: "https://auth.example/authorize/state" },
      });
      authorized = true;
      const second = await client.callTool({
        name: "list_tables",
        arguments: { schema: "APP" },
      });
      expect(second.structuredContent).toMatchObject({ ok: true, data: { rows: [] } });
      expect(JSON.stringify(second)).not.toContain("identity-secret");
      expect(observedValues).toEqual([
        expect.objectContaining({
          host: "db.example",
          serviceName: "ANTA",
          allowedSchemas: "APP",
          username: "identity-reader",
          password: "identity-secret",
        }),
      ]);
      expect(observedValues[0]).not.toMatchObject({
        host: "attacker.example",
        serviceName: "ATTACKER",
        allowedSchemas: "PUBLIC",
      });
      expect(broker.resolve).toHaveBeenLastCalledWith(
        expect.objectContaining({
          resourceId: "managed-oracle",
          principal: expect.objectContaining({ ownerId: "tip-user" }),
        }),
      );
    } finally {
      await client.close();
      database.close();
    }
  });

  it("uses the ingress authentication mode declared by the app resource", async () => {
    const database = new DatabaseSync(":memory:");
    const actionId = "oracle_database.list_tables";
    const app = createConnectionControlApp({
      catalog: createCatalogStore([oracleProvider], { executableActionIds: [actionId] }),
      providerLoader: {
        loadActionExecutor: async () => async () => ({ ok: true, output: {} }),
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => ({
          customCredential: async () => ({ profile: { accountId: "x", displayName: "x" } }),
        }),
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "https://connect.test",
      enablement: [
        {
          service: "oracle_database",
          tier: "beta",
          connectorDefinitionVersion: "1",
          owner: "team",
          evidenceRef: "test",
        },
      ],
      arkclaw: {
        apiKeyHashes: [hashApiKey("enterprise-key")],
        verifyOAuthToken: async (token) =>
          token === "oauth-token"
            ? {
                issuer: "https://customer.example",
                subject: "owner",
                audiences: ["oracle-mcp"],
                scopes: ["oracle.read"],
                clientId: "arkclaw-app",
                expiresAt: Math.floor(Date.now() / 1000) + 300,
                claims: { sub: "owner", user_id: "owner" },
              }
            : undefined,
        verifyTip: async () => ({ issuer: "https://issuer", claims: {}, principal: { ...owner, groups: ["readers"] } }),
      },
    });
    const auth = createPrincipalToken(owner, "auth-secret");
    const connection = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        service: "oracle_database",
        authType: "custom_credential",
        values: { username: "u", password: "p" },
      }),
    });
    const connectionId = String(((await connection.json()) as { connection: { id: string } }).connection.id);
    const oauthResource = await app.request("/v1/app-resources", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        resourceId: "oauth-oracle",
        displayName: "OAuth Oracle",
        connectionId,
        allowedActions: [actionId],
        allowedGroups: ["readers"],
        ingressAuth: "oauth2",
        requiredOAuthScopes: ["oracle.read"],
        allowedOAuthClientIds: ["arkclaw-app"],
        oauthIdentityClaims: ["user_id"],
      }),
    });
    expect(oauthResource.status).toBe(201);
    const initialize = (token: string) =>
      app.request("/mcp/arkclaw", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-ve-tip-token": "tip",
          "x-app-resourceid": "oauth-oracle",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
        }),
      });
    expect((await initialize("enterprise-key")).status).toBe(401);
    expect((await initialize("oauth-token")).status).toBe(200);
    database.close();
  });

  it("inherits managed credentials, rejects mismatches, and revokes resources with the connection", async () => {
    const database = new DatabaseSync(":memory:");
    const actionId = "oracle_database.list_tables";
    const app = createConnectionControlApp({
      catalog: createCatalogStore([oracleProvider], { executableActionIds: [actionId] }),
      providerLoader: {
        loadActionExecutor: async () => async () => ({ ok: true, output: {} }),
        loadProxyExecutor: async () => undefined,
        loadCredentialValidators: async () => undefined,
      },
      controlDatabase: database,
      secretCodec: new AesGcmSecretCodec("test-key"),
      authSecret: "auth-secret",
      publicOrigin: "https://connect.test",
      enablement: [
        {
          service: "oracle_database",
          tier: "beta",
          connectorDefinitionVersion: "1",
          owner: "team",
          evidenceRef: "test",
        },
      ],
      arkclaw: {
        apiKeyHashes: [hashApiKey("key")],
        verifyTip: async () => ({ issuer: "x", claims: {}, principal: owner }),
      },
    });
    const auth = createPrincipalToken(owner, "auth-secret");
    const connection = await app.request("/v1/connections", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        service: "oracle_database",
        authType: "custom_credential",
        credentialRef: "identity://oracle/anta",
        values: { host: "db.example", serviceName: "ANTA" },
      }),
    });
    const connectionId = String(((await connection.json()) as { connection: { id: string } }).connection.id);
    const mismatched = await app.request("/v1/app-resources", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "bad",
        connectionId,
        credentialRef: "identity://oracle/other",
        allowedActions: [actionId],
      }),
    });
    expect(mismatched.status).toBe(400);
    const created = await app.request("/v1/app-resources", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ resourceId: "managed", displayName: "managed", connectionId, allowedActions: [actionId] }),
    });
    await expect(created.json()).resolves.toMatchObject({
      resource: {
        credentialRef: "identity://oracle/anta",
        mcpUrl: "https://connect.test/mcp/apps/managed",
      },
    });
    expect(
      (
        await app.request(`/v1/connections/${connectionId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${auth}` },
        })
      ).status,
    ).toBe(204);
    expect(database.prepare("select status from app_resources where resource_id='managed'").get()).toMatchObject({
      status: "revoked",
    });
    database.close();
  });
});
