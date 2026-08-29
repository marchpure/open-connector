import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { AesGcmSecretCodec } from "../server/secrets/secret-codec.ts";
import { createPrincipalToken } from "./auth.ts";
import { createConnectionControlApp } from "./server.ts";

const principal = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  subject: "user-a",
  ownerId: "user-a",
  audience: "knowledge-runtime",
};

function app() {
  return createConnectionControlApp({
    catalog: createCatalogStore([]),
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
    oracleDriverFactory: () => ({
      query: async (sql: string) => {
        if (sql.includes("from dual")) return { rows: [{ OK: 1 }], bytes: 8 };
        if (sql.includes("from all_users")) {
          return { rows: [{ SCHEMA_NAME: "APP" }], bytes: 8 };
        }
        return { rows: [{ TABLE_NAME: "ORDERS" }], bytes: 8 };
      },
    }),
  });
}

function headers() {
  return {
    authorization: `Bearer ${createPrincipalToken(principal, "auth-secret")}`,
    "content-type": "application/json",
  };
}

describe("specialized adapter capability routes", () => {
  it("returns four beta capabilities and validates REST/OpenAPI", async () => {
    const response = await app().request("/v1/adapters/capabilities", {
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const capabilities = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(capabilities.items.map((item) => item.service)).toEqual(["oracle_database", "rest_openapi", "mcp", "files"]);
    expect(capabilities.items.every((item) => item.tier === "beta")).toBe(true);

    const rest = await app().request("/v1/adapters/rest/validate", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        baseUrl: "https://example.test",
        spec: {
          openapi: "3.0.0",
          info: { version: "1" },
          paths: {
            "/health": {
              get: {
                operationId: "health",
                responses: { "200": { description: "ok" } },
              },
            },
          },
        },
      }),
    });
    expect(rest.status).toBe(200);
    expect(await rest.json()).toMatchObject({
      result: { definitionVersion: "1", operations: [{ operationId: "health" }] },
    });
  });

  it("validates and discovers Oracle through the real adapter routes", async () => {
    const serviceBody = {
      config: { host: "oracle.test", port: 1521, serviceName: "FREEPDB1" },
      user: "reader",
      password: "secret",
    };
    const service = app();
    const validated = await service.request("/v1/adapters/oracle/validate", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(serviceBody),
    });
    const discovered = await service.request("/v1/adapters/oracle/discover", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(serviceBody),
    });
    expect(validated.status).toBe(200);
    expect(await validated.json()).toMatchObject({ result: { rows: [{ OK: 1 }] } });
    expect(discovered.status).toBe(200);
    expect(await discovered.json()).toMatchObject({
      result: { schemas: ["APP"] },
    });
  });

  it("registers an MCP definition without turning it into a provider", async () => {
    const response = await app().request("/v1/adapters/mcp/definitions", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        definition: {
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          allowedCommands: ["node"],
          allowedTools: ["echo"],
        },
      }),
    });
    expect(response.status).toBe(201);
    expect((await response.json()).definition.id).toEqual(expect.any(String));
  });
});
