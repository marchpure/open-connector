import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";
import { AesGcmSecretCodec } from "../server/secrets/secret-codec.ts";
import { RestOpenApiAdapter } from "./rest-adapter.ts";
import { TenantConnectionStore } from "./tenant-store.ts";
import { TenantFileAdapter } from "./file-adapter.ts";
import { ConnectionLeaseService } from "./lease.ts";
import { TransitFileService } from "../server/files/transit-files.ts";

const principal = {
  tenantId: "tenant-security",
  workspaceId: "workspace-security",
  subject: "subject-security",
  ownerId: "owner-security",
  audience: "runtime",
};

describe("connection-service security evidence", () => {
  it("fails closed for SSRF targets before a transport call", async () => {
    const adapter = new RestOpenApiAdapter(
      {
        baseUrl: "http://127.0.0.1:9",
        operations: [{ operationId: "read", method: "GET", path: "/", readOnly: true }],
        auth: { type: "none" },
        definitionVersion: "security",
      },
    );

    await expect(adapter.invoke({ operationId: "read" })).rejects.toThrow(/private|local|reserved/i);
  });

  it("rejects archive traversal and malformed binary inputs", async () => {
    const transit = {
      maxBytes: 1024 * 1024,
      async create(file: File) {
        return { fileId: "security-file", downloadUrl: "", sizeBytes: file.size, name: file.name, mimeType: file.type };
      },
      async read() {
        return { file: new File([""], "security.txt"), sizeBytes: 0, name: "security.txt", mimeType: "text/plain" };
      },
      async delete() { return true; },
      async cleanupExpired() {},
    };
    const files = new TenantFileAdapter("tenant-security", "workspace-security", transit, new DatabaseSync(":memory:"));

    const maliciousZip = new Uint8Array(46 + 9);
    const zipView = new DataView(maliciousZip.buffer);
    zipView.setUint32(0, 0x02014b50, true);
    zipView.setUint16(28, 9, true);
    new TextEncoder().encodeInto("../evil.txt", maliciousZip.subarray(46));
    await expect(files.upload(new File([maliciousZip], "evil.xlsx")))
      .rejects.toMatchObject({ code: "malicious_input" });
    await expect(files.upload(new File(["not-a-pdf"], "evil.pdf")))
      .rejects.toMatchObject({ code: "malicious_input" });
    await expect(files.upload(new File(["NOPE"], "evil.parquet")))
      .rejects.toMatchObject({ code: "malicious_input" });
  });

  it("persists encrypted connections, file ownership, leases, and revocation across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "connection-service-security-"));
    const databasePath = join(root, "control.sqlite");
    const filesRoot = join(root, "files");
    const codec = new AesGcmSecretCodec("restart-security-key");
    const transit = new TransitFileService({
      rootDir: filesRoot,
      publicOrigin: "http://127.0.0.1",
      ttlSeconds: 3600,
      maxBytes: 1024 * 1024,
    });
    let connectionId = "";
    let leaseToken = "";
    let leaseJti = "";
    let fileId = "";

    try {
      const firstDatabase = new DatabaseSync(databasePath);
      const connections = new TenantConnectionStore(firstDatabase, principal, codec);
      const stored = await connections.set("fixture", "default", {
        authType: "custom_credential",
        values: { secret: "never-persist-plaintext" },
        profile: { accountId: "fixture", displayName: "Fixture", grantedScopes: [] },
        metadata: {},
      });
      connectionId = stored.id;
      const file = await new TenantFileAdapter("tenant-security", "workspace-security", transit, firstDatabase)
        .upload(new File(['{"ok":true}'], "state.json", { type: "application/json" }));
      fileId = file.fileId;
      const leases = new ConnectionLeaseService(firstDatabase);
      const issued = leases.issue(principal, {
        connectionIds: [connectionId],
        allowedActions: ["fixture.read"],
        invocationId: "restart-invocation",
        audience: "runtime",
      });
      leaseToken = issued.token;
      leaseJti = issued.claims.jti;

      expect(firstDatabase.prepare("select credential_ciphertext from tenant_connections").get()).toMatchObject({
        credential_ciphertext: expect.stringMatching(/^enc:v1:/),
      });
      expect(file.fileId).toBe(fileId);
      expect(leases.verify(leaseToken, principal, {
        connectionId,
        actionId: "fixture.read",
        invocationId: "restart-invocation",
        audience: "runtime",
      })).toMatchObject({ jti: leaseJti });
      firstDatabase.close();

      const secondDatabase = new DatabaseSync(databasePath);
      const restartedConnections = new TenantConnectionStore(secondDatabase, principal, codec);
      expect((await restartedConnections.listRecords()).map((record) => record.id)).toContain(connectionId);
      const restartedFiles = new TenantFileAdapter("tenant-security", "workspace-security", transit, secondDatabase);
      expect(restartedFiles.list().map((entry) => entry.fileId)).toContain(fileId);
      const restartedLeases = new ConnectionLeaseService(secondDatabase);
      expect(restartedLeases.verify(leaseToken, principal, {
        connectionId,
        actionId: "fixture.read",
        invocationId: "restart-invocation",
        audience: "runtime",
      })).toMatchObject({ jti: leaseJti });
      expect(restartedLeases.revoke(leaseJti, principal)).toBe(true);
      expect(() => restartedLeases.verify(leaseToken, principal, {
        connectionId,
        actionId: "fixture.read",
        invocationId: "restart-invocation",
        audience: "runtime",
      })).toThrow(/revoked/);
      secondDatabase.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps duplicate writes idempotent and does not persist the lease token", async () => {
    const calls: Request[] = [];
    const adapter = new RestOpenApiAdapter(
      {
        baseUrl: "https://example.com",
        operations: [{ operationId: "write", method: "POST", path: "/write", readOnly: false }],
        auth: { type: "none" },
        definitionVersion: "security",
      },
      (async (input) => {
        calls.push(new Request(input));
        return Response.json({ ok: true }, { status: 201 });
      }) as typeof fetch,
    );
    const first = await adapter.invoke({ operationId: "write", body: { ok: true }, confirmed: true, idempotencyKey: "same" });
    const second = await adapter.invoke({ operationId: "write", body: { ok: true }, confirmed: true, idempotencyKey: "same" });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);

    const database = new DatabaseSync(":memory:");
    const leases = new ConnectionLeaseService(database);
    const issued = leases.issue(principal, {
      connectionIds: ["connection"],
      allowedActions: ["fixture.read"],
      invocationId: "invocation",
      audience: "runtime",
    });
    expect(database.prepare("select token_hash from connection_leases").get()).not.toMatchObject({ token_hash: issued.token });
    database.close();
  });
});
