import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { hashApiKey } from "../identity/api-key.ts";
import { AesGcmSecretCodec } from "../server/secrets/secret-codec.ts";
import { createPrincipalToken } from "./auth.ts";
import { createConnectionControlApp } from "./server.ts";

const owner = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  subject: "user-a",
  ownerId: "user-a",
  audience: "arkclaw",
};

function createTestApp(
  upstream: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  registry?: Record<string, unknown>,
  verifyTip: () => Promise<{
    issuer: string;
    claims: Record<string, unknown>;
    principal: typeof owner;
  }> = async () => ({
    issuer: "https://issuer.example",
    claims: {},
    principal: owner,
  }),
) {
  const database = new DatabaseSync(":memory:");
  const auth = createPrincipalToken(owner, "control-secret");
  const app = createConnectionControlApp({
    catalog: createCatalogStore([]),
    providerLoader: {
      loadActionExecutor: async () => undefined,
      loadProxyExecutor: async () => undefined,
      loadCredentialValidators: async () => ({}),
    },
    controlDatabase: database,
    secretCodec: new AesGcmSecretCodec("test-key"),
    authSecret: "control-secret",
    publicOrigin: "https://connector.example",
    enablement: [],
    arkclaw: {
      apiKeyHashes: [hashApiKey("ingress-key")],
      verifyTip: vi.fn(verifyTip),
    },
    applicationCenter: registry ? { spaceId: "space-a", registry: registry as never } : undefined,
    customMcp: { fetcher: async (input, init) => upstream(input, init), skipDnsValidation: true },
  });
  return { app, auth, database };
}

describe("custom enterprise MCP resources", () => {
  it("registers a shared MSE MCP with provider reference and maps gateway resource id", async () => {
    const createResource = vi.fn(async (input: Record<string, unknown>) => {
      expect(input).toMatchObject({
        mcpUrl: "https://connector.example/mcp/custom/knowledge-center",
        authConfig: { Type: "KEY_AUTH", ApikeyConfig: [{ CredentialProviderName: "kc-provider" }] },
        visibility: "PartiallyVisible",
        authorizedSubjects: [{ SubjectId: "group-a", SubjectType: "GROUP" }],
      });
      return { Id: "mse-knowledge-1", Status: "Ready", NetworkConfig: { GatewayUrl: "https://gateway.example/mcp" } };
    });
    const { app, auth, database } = createTestApp(async () => new Response("ok"), {
      createResource,
      deleteResource: vi.fn(),
    });
    const response = await app.request("/v1/custom-mcp-resources", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        resourceId: "knowledge-center",
        displayName: "Knowledge Center",
        upstreamUrl: "https://customer.example/mcp",
        protocol: "streamable_http",
        proxyCredential: { mode: "reference", type: "api_key", credentialProviderName: "kc-provider" },
        visibility: "partial",
        allowedGroups: ["group-a"],
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      resource: {
        resourceId: "knowledge-center",
        mseResourceId: "mse-knowledge-1",
        gateway: { headers: { "X-App-ResourceId": "mse-knowledge-1" } },
      },
    });
    expect(JSON.stringify(database.prepare("select * from custom_mcp_resources").all())).not.toContain("ingress-key");
    database.close();
  });

  it("verifies TIP, tenant and group ACL before forwarding MCP without exposing client secrets", async () => {
    let forwarded: Request | undefined;
    const { app, auth, database } = createTestApp(async (input, init) => {
      forwarded = new Request(input, init);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
        headers: { "content-type": "application/json" },
      });
    });
    const create = await app.request("/v1/custom-mcp-resources", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        resourceId: "proxy-resource",
        displayName: "Proxy Resource",
        upstreamUrl: "https://customer.example/mcp",
        proxyCredential: { mode: "reference", type: "api_key", credentialProviderName: "customer-provider" },
        ingressApiKeyHashes: [hashApiKey("ingress-key")],
        visibility: "team",
      }),
    });
    expect(create.status, await create.clone().text()).toBe(201);
    const response = await app.request("/mcp/custom/proxy-resource", {
      method: "POST",
      headers: {
        authorization: "Bearer ingress-key",
        "x-ve-tip-token": "verified-tip",
        "x-app-resourceid": "proxy-resource",
        "mcp-protocol-version": "2025-11-25",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(response.status).toBe(200);
    expect(forwarded?.headers.get("x-ve-tip-token")).toBe("verified-tip");
    expect(forwarded?.headers.get("authorization")).toBe("Bearer ingress-key");
    expect(await response.json()).toMatchObject({ result: { ok: true } });
    database.close();
  });

  it("allows a provider-only enterprise gateway request without copying the provider secret locally", async () => {
    let forwarded: Request | undefined;
    const createResource = vi.fn(async () => ({
      Id: "mse-provider-only",
      Status: "Ready",
      NetworkConfig: { GatewayUrl: "https://gateway.example/mcp" },
    }));
    const { app, auth, database } = createTestApp(
      async (input, init) => {
        forwarded = new Request(input, init);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
          headers: { "content-type": "application/json" },
        });
      },
      { createResource, deleteResource: vi.fn() },
    );
    const create = await app.request("/v1/custom-mcp-resources", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        resourceId: "provider-only",
        displayName: "Provider Only",
        upstreamUrl: "https://customer.example/mcp",
        proxyCredential: { mode: "reference", type: "api_key", credentialProviderName: "provider-only-key" },
        visibility: "team",
      }),
    });
    expect(create.status).toBe(201);
    const response = await app.request("/mcp/custom/provider-only", {
      method: "POST",
      headers: {
        "x-app-resourceid": "mse-provider-only",
        "x-ve-tip-token": "verified-tip",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(response.status).toBe(200);
    expect(forwarded?.headers.get("authorization")).toBeNull();
    expect(forwarded?.headers.get("x-ve-tip-token")).toBe("verified-tip");
    database.close();
  });

  it("does not authorize a different tenant even when the resource id is known", async () => {
    const { app, auth, database } = createTestApp(async () => new Response("should not call"));
    await app.request("/v1/custom-mcp-resources", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({
        resourceId: "tenant-bound",
        displayName: "Tenant Bound",
        upstreamUrl: "https://customer.example/mcp",
        ingressApiKeyHashes: [hashApiKey("ingress-key")],
        visibility: "team",
      }),
    });
    const otherTenant = { ...owner, tenantId: "tenant-b" };
    const { app: otherApp } = createTestApp(
      async () => new Response("should not call"),
      undefined,
      async () => ({
        issuer: "https://issuer.example",
        claims: {},
        principal: otherTenant,
      }),
    );
    expect(
      (
        await otherApp.request("/mcp/custom/tenant-bound", {
          method: "POST",
          headers: {
            authorization: "Bearer ingress-key",
            "x-ve-tip-token": "verified-tip",
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
        })
      ).status,
    ).toBe(403);
    database.close();
  });
});
