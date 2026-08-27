import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";
import { createPrincipalToken } from "./auth.ts";
import { createConnectionControlApp } from "./server.ts";
import { AesGcmSecretCodec } from "../server/secrets/secret-codec.ts";
import { createCatalogStore } from "../catalog-store.ts";
import type { ProviderDefinition } from "../core/types.ts";

const provider: ProviderDefinition = {
  service: "fixture",
  displayName: "Fixture",
  categories: ["test"],
  authTypes: ["custom_credential"],
  auth: [{
    type: "custom_credential",
    fields: [{ key: "secret", label: "Secret", inputType: "password", required: true, secret: true }],
  }],
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
    const payload = await created.json() as { connection: Record<string, unknown> };
    expect(JSON.stringify(payload)).not.toContain("do-not-leak");
    const encrypted = database.prepare("select credential_ciphertext from tenant_connections").get() as {
      credential_ciphertext: string;
    };
    expect(encrypted.credential_ciphertext).toMatch(/^enc:v1:/);
    const other = createPrincipalToken({ ...principal, tenantId: "tenant-b", workspaceId: "workspace-b" }, "auth-secret");
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
});
