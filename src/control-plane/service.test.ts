import type { ActionExecutor, CredentialValidators, ProviderDefinition } from "../core/types.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { setDefaultGuardedFetchDnsLookup } from "../core/guarded-fetch.ts";
import { AesGcmSecretCodec } from "../server/secrets/secret-codec.ts";
import { createTenantRuntime } from "./service.ts";

const provider: ProviderDefinition = {
  service: "fixture_oauth",
  displayName: "Fixture OAuth",
  categories: ["test"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://provider.example.com/oauth/authorize",
      tokenUrl: "https://provider.example.com/oauth/token",
      scopes: ["read"],
      tokenEndpointAuthMethod: "client_secret_post",
    },
  ],
  actions: [],
};

const principal = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  subject: "user-a",
  ownerId: "user-a",
  audience: "knowledge-runtime",
};

afterEach(() => {
  setDefaultGuardedFetchDnsLookup(undefined);
  vi.unstubAllGlobals();
});

describe("tenant Control Plane runtime", () => {
  it("refreshes and encrypts expired OAuth credentials while invalidating the old lease revision", async () => {
    const database = new DatabaseSync(":memory:");
    const secretCodec = new AesGcmSecretCodec("test-key");
    const runtime = createTenantRuntime(
      {
        catalog: createCatalogStore([provider]),
        providerLoader: new EmptyProviderLoader(),
        controlDatabase: database,
        secretCodec,
        publicOrigin: "http://localhost:3417",
      },
      principal,
    );
    await runtime.oauthClientConfigs.upsertConfig({
      service: "fixture_oauth",
      clientId: "client-id",
      clientSecret: "client-secret",
    });
    const stored = await runtime.connections.set("fixture_oauth", "default", {
      authType: "oauth2",
      accessToken: "expired-access-token",
      tokenType: "Bearer",
      refreshToken: "refresh-token",
      expiresAt: "2026-01-01T00:00:00.000Z",
      profile: {
        accountId: "provider-user",
        displayName: "Provider User",
        grantedScopes: ["read"],
      },
      metadata: { expires_in: 3600 },
    });
    const lease = runtime.leases.issue(principal, {
      connectionIds: [stored.id],
      connectionRevisions: { [stored.id]: Number(stored.revision) },
      allowedActions: ["fixture_oauth.read"],
      invocationId: "before-refresh",
      audience: "knowledge-runtime",
    });
    setDefaultGuardedFetchDnsLookup(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          access_token: "fresh-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      ),
    );

    await expect(runtime.connectionService.getCredential("fixture_oauth")).resolves.toMatchObject({
      authType: "oauth2",
      accessToken: "fresh-access-token",
      refreshToken: "refresh-token",
    });

    const record = runtime.connections.visibleRecord(stored.id);
    expect(record?.revision).toBe(Number(stored.revision) + 1);
    const row = database.prepare("select credential_ciphertext from tenant_connections where id=?").get(stored.id) as {
      credential_ciphertext: string;
    };
    expect(row.credential_ciphertext).not.toContain("fresh-access-token");
    await expect(secretCodec.decode(row.credential_ciphertext)).resolves.toContain("fresh-access-token");
    expect(() =>
      runtime.leases.verify(lease.token, principal, {
        connectionId: stored.id,
        connectionRevision: record!.revision,
        actionId: "fixture_oauth.read",
        invocationId: "before-refresh",
        audience: "knowledge-runtime",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "lease_scope_denied",
        message: "Connection lease does not grant this invocation.",
      }),
    );
    database.close();
  });
});

class EmptyProviderLoader implements IProviderLoader {
  async loadActionExecutor(): Promise<ActionExecutor | undefined> {
    return undefined;
  }

  async loadProxyExecutor(): Promise<undefined> {
    return undefined;
  }

  async loadCredentialValidators(): Promise<CredentialValidators | undefined> {
    return undefined;
  }
}
