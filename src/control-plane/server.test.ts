import type { ProviderDefinition } from "../core/types.ts";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { TransitFileService } from "../server/files/transit-files.ts";
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

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("connection control API", () => {
  it("persists the lease invocation id in the redacted audit feed", async () => {
    const database = new DatabaseSync(":memory:");
    const executableProvider: ProviderDefinition = {
      ...provider,
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
    const app = createConnectionControlApp({
      catalog: createCatalogStore([executableProvider], { executableActionIds: ["fixture.read"] }),
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
      catalog: createCatalogStore([provider]),
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

  it("enforces personal/team visibility and owner-only connection management", async () => {
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
      catalog: createCatalogStore([provider]),
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
      job: { kind: "discover", status: "succeeded", result: { service: "fixture", resources: [], actions: [] } },
    });
    database.close();
  });

  it("does not let a shared-connection teammate lease storage mutation or presign capabilities", async () => {
    const database = new DatabaseSync(":memory:");
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider]),
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
        code: "connection_forbidden",
        message: "Storage write, delete, and presign actions require the connection owner.",
      },
    });
    database.close();
  });

  it("persists failed validation and marks the connection error", async () => {
    const database = new DatabaseSync(":memory:");
    const validateCredential = vi
      .fn()
      .mockResolvedValueOnce({ profile: { accountId: "created" } })
      .mockRejectedValueOnce(new Error("upstream rejected credential"));
    const app = createConnectionControlApp({
      catalog: createCatalogStore([provider]),
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
