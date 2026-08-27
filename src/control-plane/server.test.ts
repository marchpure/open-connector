import type { ProviderDefinition } from "../core/types.ts";

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { AesGcmSecretCodec } from "../server/secrets/secret-codec.ts";
import { createPrincipalToken } from "./auth.ts";
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
  actions: [],
};

const principal = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  subject: "user-a",
  ownerId: "user-a",
  audience: "knowledge-runtime",
};

describe("connection control API", () => {
  it("isolates tenants and never returns credentials", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider]),
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

  it("exposes authenticated Oracle catalog discovery with schema allowlists", async () => {
    const database = new DatabaseSync(":memory:");
    const query = vi.fn().mockResolvedValue({
      rows: [{ TABLE_NAME: "ORDERS" }],
      bytes: 25,
    });
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider]),
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
      oracleDriverFactory: () => ({ query }),
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

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { schema: "APP", tables: ["ORDERS"] } });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("from all_tables where owner = :schema"),
      { schema: "APP" },
      { maxRows: 1000, timeoutMs: 30_000 },
    );
    database.close();
  });
});
