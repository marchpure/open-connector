import type {
  ApplicationCenterResource,
  ApplicationCenterTop,
  CreateApplicationResourceInput,
} from "./application-center-client.ts";

import { describe, expect, it, vi } from "vitest";
import { VolcApplicationCenterRegistry } from "./application-center-client.ts";

const top: ApplicationCenterTop = {
  accountId: 123,
  region: "cn-beijing",
  sourceService: "open-connector",
  destService: "ai_registry",
  requestId: "request-1",
};

const input: CreateApplicationResourceInput = {
  spaceId: "space-1",
  name: "anta-oracle-read",
  description: "Oracle read MCP",
  mcpUrl: "https://connector.example/mcp/apps/anta-oracle-read",
  clawId: "claw-1",
  userPoolUserUid: "pool-user-1",
  credentialAuthConfig: {
    Type: "oauth2",
    OAuthConfig: [
      {
        Vendor: "OAUTH2_VENDOR_CUSTOM",
        Name: "anta-oracle-oauth",
        Oauth2ProviderConfig: {
          ClientId: "client-1",
          ClientSecret: "secret-1",
          Flow: "USER_FEDERATION",
          Scopes: ["oracle.read"],
          Oauth2Discovery: { DiscoveryUrl: "https://idp.example/.well-known/openid-configuration" },
        },
      },
    ],
  },
};

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("VolcApplicationCenterRegistry", () => {
  it("references an existing API key provider through AuthConfig without sending a secret", async () => {
    const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({
        action: new URL(String(url)).searchParams.get("Action") ?? "",
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return calls.at(-1)?.action === "CreateResource"
        ? response({ Result: { Id: "mse-reference-1" } })
        : response({ Result: { Resource: { Id: "mse-reference-1", Status: "Ready" } } });
    });
    const registry = new VolcApplicationCenterRegistry(
      {
        endpoint: new URL("https://ai-registry.example/"),
        region: "cn-beijing",
        accessKeyId: "ak-test",
        secretAccessKey: "sk-test",
        top,
        pollIntervalMs: 0,
      },
      fetcher,
    );
    await registry.createResource({
      ...input,
      credentialAuthConfig: undefined,
      authConfig: { Type: "KEY_AUTH", ApikeyConfig: [{ CredentialProviderName: "provider-1" }] },
    });
    expect(calls[0].body).toMatchObject({
      AuthConfig: { Type: "KEY_AUTH", ApikeyConfig: [{ CredentialProviderName: "provider-1" }] },
    });
    expect(calls[0].body).not.toHaveProperty("CredentialAuthConfig");
  });

  it("registers an enterprise MCP as a shared AiResource without personal Claw fields", async () => {
    const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const call = {
        action: new URL(String(url)).searchParams.get("Action") ?? "",
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      calls.push(call);
      return call.action === "CreateResource"
        ? response({ Result: { Id: "mse-enterprise-1" } })
        : response({ Result: { Resource: { Id: "mse-enterprise-1", Status: "Ready" } } });
    });
    const registry = new VolcApplicationCenterRegistry(
      {
        endpoint: new URL("https://ai-registry.example/"),
        region: "cn-beijing",
        accessKeyId: "ak-test",
        secretAccessKey: "sk-test",
        top,
        pollIntervalMs: 0,
      },
      fetcher,
    );
    await registry.createResource({
      spaceId: "space-1",
      name: "enterprise-oracle",
      mcpUrl: "https://connector.example/mcp/apps/enterprise-oracle",
      authConfig: { Type: "KEY_AUTH", ApikeyConfig: [{ CredentialProviderName: "oracle-provider" }] },
    });
    expect(calls[0].body).toMatchObject({
      Type: "Mcp",
      McpConfig: { Source: "Standard", Protocol: "http" },
      AuthConfig: { Type: "KEY_AUTH", ApikeyConfig: [{ CredentialProviderName: "oracle-provider" }] },
    });
    expect(calls[0].body).not.toHaveProperty("clawId");
    expect(calls[0].body).not.toHaveProperty("UserPoolUserUid");
  });

  it("references an existing OAuth provider with user federation", async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo, _init?: RequestInit) =>
      new URL(String(url)).searchParams.get("Action") === "CreateResource"
        ? response({ Result: { Id: "mse-reference-oauth" } })
        : response({ Result: { Resource: { Id: "mse-reference-oauth", Status: "Running" } } }),
    );
    const registry = new VolcApplicationCenterRegistry(
      {
        endpoint: new URL("https://ai-registry.example/"),
        region: "cn-beijing",
        accessKeyId: "ak-test",
        secretAccessKey: "sk-test",
        top,
        pollIntervalMs: 0,
      },
      fetcher,
    );
    await registry.createResource({
      ...input,
      credentialAuthConfig: undefined,
      authConfig: {
        Type: "OAUTH",
        OAuthConfig: [{ CredentialProviderName: "oauth-provider", Flow: "USER_FEDERATION" }],
      },
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      AuthConfig: {
        Type: "OAUTH",
        OAuthConfig: [{ CredentialProviderName: "oauth-provider", Flow: "USER_FEDERATION" }],
      },
    });
  });

  it("rejects sending provider references and raw credential provisioning together", async () => {
    const registry = new VolcApplicationCenterRegistry(
      {
        endpoint: new URL("https://ai-registry.example/"),
        region: "cn-beijing",
        accessKeyId: "ak-test",
        secretAccessKey: "sk-test",
        top,
      },
      vi.fn(),
    );
    await expect(
      registry.createResource({
        ...input,
        authConfig: { Type: "OAUTH", OAuthConfig: [{ CredentialProviderName: "provider" }] },
      }),
    ).rejects.toThrow("mutually exclusive");
  });

  it("registers a Standard MCP user resource and reads the gateway from Result.Resource", async () => {
    const calls: Array<{ action: string; body: Record<string, unknown>; headers: Headers }> = [];
    let getCount = 0;
    const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const requestUrl = new URL(String(url));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ action: requestUrl.searchParams.get("Action") ?? "", body, headers: new Headers(init?.headers) });
      if (requestUrl.searchParams.get("Action") === "CreateResource") return response({ Result: { Id: "mse-res-1" } });
      getCount += 1;
      return response({
        Result: {
          Resource: {
            Id: "mse-res-1",
            Status: "Running",
            NetworkConfig: { GatewayUrl: "https://gateway.example/mcp/resources", GatewayUrlType: "public" },
          } satisfies ApplicationCenterResource,
        },
      });
    });
    const registry = new VolcApplicationCenterRegistry(
      {
        endpoint: new URL("https://ai-registry.example/"),
        region: "cn-beijing",
        accessKeyId: "ak-test",
        secretAccessKey: "sk-test",
        top,
        pollIntervalMs: 0,
        pollTimeoutMs: 100,
      },
      fetcher,
    );

    await expect(registry.createResource(input)).resolves.toMatchObject({
      Id: "mse-res-1",
      NetworkConfig: { GatewayUrl: "https://gateway.example/mcp/resources" },
    });
    expect(getCount).toBe(1);
    expect(calls[0]).toMatchObject({ action: "CreateResource" });
    expect(calls[0].body).toMatchObject({
      Type: "Mcp",
      SpaceId: "space-1",
      Name: "anta-oracle-read",
      McpConfig: {
        Source: "Standard",
        McpUrl: input.mcpUrl,
        Protocol: "http",
      },
      clawId: "claw-1",
      UserPoolUserUid: "pool-user-1",
      CredentialAuthConfig: input.credentialAuthConfig,
    });
    expect(calls[0].headers.get("authorization")).toMatch(
      /^HMAC-SHA256 Credential=ak-test\/\d{8}\/cn-beijing\/ai_registry\/request, SignedHeaders=/,
    );
    expect(calls[0].headers.get("authorization")).not.toContain("sk-test");
    expect(calls[0].headers.get("x-top-account-id")).toBe("123");
    expect(calls[0].headers.get("x-top-service")).toBe("ai_registry");
    expect(calls[0].headers.get("x-top-source")).toBe("open-connector");
    expect(calls[0].headers.get("x-top-region")).toBe("cn-beijing");
  });

  it("waits for a creating resource and fails on terminal Failed status", async () => {
    let getCount = 0;
    const fetcher = vi.fn(async (url: URL | RequestInfo) => {
      const action = new URL(String(url)).searchParams.get("Action");
      if (action === "CreateResource") return response({ Result: { Id: "mse-res-2" } });
      getCount += 1;
      return response({
        Result: {
          Resource: {
            Id: "mse-res-2",
            Status: getCount === 1 ? "Creating" : "Failed",
            ErrorMessage: "upstream rejected",
          },
        },
      });
    });
    const registry = new VolcApplicationCenterRegistry(
      {
        endpoint: new URL("https://ai-registry.example/"),
        region: "cn-beijing",
        accessKeyId: "ak-test",
        secretAccessKey: "sk-test",
        top,
        pollIntervalMs: 0,
        pollTimeoutMs: 100,
      },
      fetcher,
    );
    await expect(registry.createResource(input)).rejects.toThrow("upstream rejected");
    expect(getCount).toBe(2);
  });

  it("deletes a resource with the same user-resource identity fields", async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(new URL(String(url)).searchParams.get("Action")).toBe("DeleteResource");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        Id: "mse-res-3",
        SpaceId: input.spaceId,
        ClawId: input.clawId,
        UserPoolUserUid: input.userPoolUserUid,
      });
      return response({ Result: {} });
    });
    const registry = new VolcApplicationCenterRegistry(
      {
        endpoint: new URL("https://ai-registry.example/"),
        region: "cn-beijing",
        accessKeyId: "ak-test",
        secretAccessKey: "sk-test",
        top,
      },
      fetcher,
    );
    await expect(registry.deleteResource("mse-res-3", input)).resolves.toBeUndefined();
  });
});
