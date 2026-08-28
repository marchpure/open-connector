import type { ProviderDefinition } from "../core/types.ts";
import type { IOAuthClientConfigStore, OAuthClientConfig } from "./oauth-client-config-service.ts";

import { describe, expect, it } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { OAuthClientConfigService } from "./oauth-client-config-service.ts";

describe("OAuthClientConfigService", () => {
  it("lists configured OAuth clients before unconfigured OAuth providers", async () => {
    const store = new MemoryOAuthClientConfigStore();
    await store.set({
      service: "beta",
      clientId: "beta-client-id",
      clientSecret: "beta-client-secret",
      extra: {},
      secretExtra: {},
    });
    const service = new OAuthClientConfigService({
      catalog: createCatalogStore([oauthProvider("alpha"), oauthProvider("beta"), noAuthProvider]),
      origin: "http://localhost:3000",
      store,
    });

    await expect(service.listConfigs()).resolves.toMatchObject([
      { service: "beta", configured: true, clientId: "beta-client-id" },
      { service: "alpha", configured: false, clientId: null },
    ]);
  });

  it("normalizes a requested scope subset and rejects provider-undeclared scopes", () => {
    const service = new OAuthClientConfigService({
      catalog: createCatalogStore([oauthProvider("example")]),
      origin: "http://localhost:3000",
      store: new MemoryOAuthClientConfigStore(),
    });

    expect(
      service.normalizeConfig("example", {
        clientId: "client-id",
        clientSecret: "client-secret",
        requestedScopes: [" write ", "read", "write"],
      }),
    ).toMatchObject({ requestedScopes: ["write", "read"] });

    expect(() =>
      service.normalizeConfig("example", {
        clientId: "client-id",
        clientSecret: "client-secret",
        requestedScopes: ["admin"],
      }),
    ).toThrow("requestedScopes contains a scope not declared by example: admin.");
  });

  it("drops stored scopes the provider no longer declares instead of failing reads", async () => {
    const store = new MemoryOAuthClientConfigStore();
    await store.set({
      service: "example",
      clientId: "client-id",
      clientSecret: "client-secret",
      requestedScopes: ["read", "removed"],
      extra: {},
      secretExtra: {},
    });
    const service = new OAuthClientConfigService({
      catalog: createCatalogStore([oauthProvider("example")]),
      origin: "http://localhost:3000",
      store,
    });

    await expect(service.listConfigs()).resolves.toMatchObject([
      { service: "example", requestedScopes: ["read", "removed"], effectiveScopes: ["read"] },
    ]);
    expect(
      service.getEffectiveScopes("example", {
        service: "example",
        clientId: "client-id",
        clientSecret: "client-secret",
        requestedScopes: ["removed"],
        extra: {},
        secretExtra: {},
      }),
    ).toEqual(["read", "write"]);
  });

  it("rejects an empty requested scope subset", () => {
    const service = new OAuthClientConfigService({
      catalog: createCatalogStore([oauthProvider("example")]),
      origin: "http://localhost:3000",
      store: new MemoryOAuthClientConfigStore(),
    });

    expect(() =>
      service.normalizeConfig("example", {
        clientId: "client-id",
        clientSecret: "client-secret",
        requestedScopes: [],
      }),
    ).toThrow("requestedScopes must contain at least one scope.");
  });

  it("uses provider-native permissions for action-scoped OAuth authorization", () => {
    const provider = oauthProvider("example");
    provider.actions = [
      {
        id: "example.read",
        service: "example",
        name: "read",
        description: "Read provider data.",
        requiredScopes: ["example.internal.read"],
        providerPermissions: ["read"],
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      },
    ];
    const service = new OAuthClientConfigService({
      catalog: createCatalogStore([provider]),
      origin: "http://localhost:3000",
      store: new MemoryOAuthClientConfigStore(),
    });

    expect(
      service.getEffectiveScopes(
        "example",
        {
          service: "example",
          clientId: "client-id",
          clientSecret: "client-secret",
          extra: {},
          secretExtra: {},
        },
        ["example.read"],
      ),
    ).toEqual(["read"]);
  });

  it("uses provider least-privilege defaults when no actions or configured subset are supplied", async () => {
    const provider = oauthProvider("example");
    const auth = provider.auth[0];
    if (auth?.type !== "oauth2") throw new Error("Expected OAuth fixture.");
    auth.defaultScopes = ["read"];
    const service = new OAuthClientConfigService({
      catalog: createCatalogStore([provider]),
      origin: "http://localhost:3000",
      store: new MemoryOAuthClientConfigStore(),
    });
    const config = {
      service: "example",
      clientId: "client-id",
      clientSecret: "client-secret",
      extra: {},
      secretExtra: {},
    };

    expect(service.getEffectiveScopes("example", config)).toEqual(["read"]);
    await expect(service.listConfigs()).resolves.toMatchObject([{ service: "example", effectiveScopes: ["read"] }]);
  });

  it("rejects provider default scopes that are not declared as supported", () => {
    const provider = oauthProvider("example");
    const auth = provider.auth[0];
    if (auth?.type !== "oauth2") throw new Error("Expected OAuth fixture.");
    auth.defaultScopes = ["undeclared"];
    const service = new OAuthClientConfigService({
      catalog: createCatalogStore([provider]),
      origin: "http://localhost:3000",
      store: new MemoryOAuthClientConfigStore(),
    });

    expect(() =>
      service.getEffectiveScopes("example", {
        service: "example",
        clientId: "client-id",
        clientSecret: "client-secret",
        extra: {},
        secretExtra: {},
      }),
    ).toThrow("OAuth default scope is not declared by example: undeclared.");
  });

  it("rejects an empty provider default scope set", () => {
    const provider = oauthProvider("example");
    const auth = provider.auth[0];
    if (auth?.type !== "oauth2") throw new Error("Expected OAuth fixture.");
    auth.defaultScopes = [];
    const service = new OAuthClientConfigService({
      catalog: createCatalogStore([provider]),
      origin: "http://localhost:3000",
      store: new MemoryOAuthClientConfigStore(),
    });

    expect(() =>
      service.getEffectiveScopes("example", {
        service: "example",
        clientId: "client-id",
        clientSecret: "client-secret",
        extra: {},
        secretExtra: {},
      }),
    ).toThrow("OAuth default scopes must not be empty for example.");
  });
});

function oauthProvider(service: string): ProviderDefinition {
  return {
    service,
    displayName: service,
    categories: ["Developer Tools"],
    authTypes: ["oauth2"],
    auth: [
      {
        type: "oauth2",
        authorizationUrl: "https://example.com/oauth/authorize",
        tokenUrl: "https://example.com/oauth/token",
        scopes: ["read", "write"],
        tokenEndpointAuthMethod: "client_secret_post",
      },
    ],
    actions: [],
  };
}

const noAuthProvider: ProviderDefinition = {
  service: "public",
  displayName: "public",
  categories: ["Developer Tools"],
  authTypes: ["no_auth"],
  auth: [{ type: "no_auth" }],
  actions: [],
};

class MemoryOAuthClientConfigStore implements IOAuthClientConfigStore {
  private readonly configs = new Map<string, OAuthClientConfig>();

  async get(service: string): Promise<OAuthClientConfig | undefined> {
    return this.configs.get(service);
  }

  async set(config: OAuthClientConfig): Promise<void> {
    this.configs.set(config.service, config);
  }

  async delete(service: string): Promise<void> {
    this.configs.delete(service);
  }

  async list(): Promise<OAuthClientConfig[]> {
    return [...this.configs.values()];
  }
}
