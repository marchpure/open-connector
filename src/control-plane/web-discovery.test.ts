import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AesGcmSecretCodec } from "../server/secrets/secret-codec.ts";
import { TenantWebDiscoveryStore, WebDiscoveryError } from "./web-discovery.ts";

describe("TenantWebDiscoveryStore", () => {
  it("derives candidates from sanitized same-origin worker observations and requires confirmation", async () => {
    const database = new DatabaseSync(":memory:");
    const store = new TenantWebDiscoveryStore(
      database,
      { tenantId: "tenant-a", workspaceId: "workspace-a", subject: "user-a" },
      new AesGcmSecretCodec("web-discovery-key"),
    );
    const session = await store.start({ origin: "https://app.example.com" });
    const candidate = await store.observe(session.id, session.workerToken, {
      url: "https://app.example.com/api/orders/123?include=items",
      method: "GET",
      requestHeaders: { accept: "application/json" },
      responseStatus: 200,
      responseContentType: "application/json",
      responseSample: { id: "123", total: 42 },
    });

    expect(candidate).toMatchObject({
      origin: "https://app.example.com",
      method: "GET",
      path: "/api/orders/{id}",
      readOnly: true,
    });
    await expect(
      store.confirm(session.id, {
        candidateId: candidate.id,
        origin: candidate.origin,
        operationId: "getOrder",
        readOnly: true,
      }),
    ).resolves.toMatchObject({
      baseUrl: "https://app.example.com",
      operations: [{ operationId: "getOrder", method: "GET", path: "/api/orders/{id}", readOnly: true }],
    });
  });

  it("rejects cookies, CSRF tokens, cross-origin redirects, and mismatched confirmation", async () => {
    const store = new TenantWebDiscoveryStore(
      new DatabaseSync(":memory:"),
      { tenantId: "tenant-a", workspaceId: "workspace-a", subject: "user-a" },
      new AesGcmSecretCodec("web-discovery-key"),
    );
    const session = await store.start({ origin: "https://app.example.com" });

    await expect(
      store.observe(session.id, session.workerToken, {
        url: "https://app.example.com/api/orders",
        method: "GET",
        requestHeaders: { cookie: "session=secret" },
        responseStatus: 200,
        responseContentType: "application/json",
      }),
    ).rejects.toEqual(
      new WebDiscoveryError("sensitive_observation", "Worker observations must not contain credentials."),
    );
    await expect(
      store.observe(session.id, session.workerToken, {
        url: "https://app.example.com/api/orders",
        method: "GET",
        requestHeaders: { "x-csrf-token": "secret" },
        responseStatus: 302,
        redirectUrl: "https://evil.example/api",
        responseContentType: "application/json",
      }),
    ).rejects.toMatchObject({ code: "cross_origin" });

    const candidate = await store.observe(session.id, session.workerToken, {
      url: "https://app.example.com/api/orders",
      method: "POST",
      requestHeaders: { "content-type": "application/json" },
      requestSample: { amount: 42 },
      responseStatus: 201,
      responseContentType: "application/json",
    });
    await expect(
      store.confirm(session.id, {
        candidateId: candidate.id,
        origin: "https://other.example.com",
        operationId: "createOrder",
        readOnly: false,
      }),
    ).rejects.toMatchObject({ code: "confirmation_mismatch" });
  });

  it("isolates encrypted capture state by tenant", async () => {
    const database = new DatabaseSync(":memory:");
    const codec = new AesGcmSecretCodec("web-discovery-key");
    const tenantA = new TenantWebDiscoveryStore(
      database,
      { tenantId: "tenant-a", workspaceId: "workspace-a", subject: "user-a" },
      codec,
    );
    const session = await tenantA.start({ origin: "https://app.example.com" });
    await tenantA.observe(session.id, session.workerToken, {
      url: "https://app.example.com/api/private",
      method: "GET",
      requestHeaders: { accept: "application/json" },
      responseStatus: 200,
      responseContentType: "application/json",
      responseSample: { privateValue: "sample" },
    });
    const tenantB = new TenantWebDiscoveryStore(
      database,
      { tenantId: "tenant-b", workspaceId: "workspace-b", subject: "user-b" },
      codec,
    );

    await expect(tenantB.listCandidates(session.id)).rejects.toMatchObject({ code: "session_not_found" });
    const persisted = JSON.stringify(database.prepare("select * from web_discovery_candidates").all());
    expect(persisted).not.toContain("privateValue");
    expect(persisted).not.toContain("sample");
  });

  it("requires the short-lived worker token for observations", async () => {
    const store = new TenantWebDiscoveryStore(
      new DatabaseSync(":memory:"),
      { tenantId: "tenant-a", workspaceId: "workspace-a", subject: "user-a" },
      new AesGcmSecretCodec("web-discovery-key"),
    );
    const session = await store.start({ origin: "https://app.example.com" });
    await expect(
      store.observe(session.id, "wrong-token", {
        url: "https://app.example.com/api/orders",
        method: "GET",
        requestHeaders: {},
        responseStatus: 200,
        responseContentType: "application/json",
      }),
    ).rejects.toMatchObject({ code: "session_not_found" });
  });
});
