import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ConnectionLeaseService, LeaseError } from "./lease.ts";
import { redactSecrets } from "./redaction.ts";

const principal = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  subject: "user-a",
  ownerId: "user-a",
  audience: "knowledge-runtime",
};

describe("ConnectionLeaseService", () => {
  it("requires explicit non-empty connection and action scopes", () => {
    const leases = new ConnectionLeaseService(new DatabaseSync(":memory:"));
    expect(() =>
      leases.issue(principal, {
        connectionIds: [],
        allowedActions: [],
        invocationId: "invocation-1",
        audience: principal.audience,
      }),
    ).toThrowError(new LeaseError("invalid_lease", "connection_ids and allowed_actions must both be non-empty."));
  });

  it("binds a short-lived lease to tenant, subject, invocation, audience, and scopes", () => {
    let current = new Date("2026-08-27T00:00:00.000Z");
    const leases = new ConnectionLeaseService(new DatabaseSync(":memory:"), () => current);
    const issued = leases.issue(principal, {
      connectionIds: ["connection-1"],
      allowedActions: ["feishu.get_document"],
      invocationId: "invocation-1",
      audience: principal.audience,
      ttlSeconds: 60,
    });

    expect(issued.token).toMatch(/^cl_/);
    expect(issued.claims.connectionIds).toEqual(["connection-1"]);
    expect(() =>
      leases.verify(
        issued.token,
        { ...principal, tenantId: "tenant-b" },
        {
          connectionId: "connection-1",
          actionId: "feishu.get_document",
          invocationId: "invocation-1",
          audience: principal.audience,
        },
      ),
    ).toThrowError(/does not grant/);
    expect(
      leases.verify(issued.token, principal, {
        connectionId: "connection-1",
        actionId: "feishu.get_document",
        invocationId: "invocation-1",
        audience: principal.audience,
      }),
    ).toMatchObject({ tenantId: "tenant-a", jti: issued.claims.jti });

    current = new Date("2026-08-27T00:01:01.000Z");
    expect(() =>
      leases.verify(issued.token, principal, {
        connectionId: "connection-1",
        actionId: "feishu.get_document",
        invocationId: "invocation-1",
        audience: principal.audience,
      }),
    ).toThrowError(/expired/);
  });

  it("revokes a lease and stores only the token hash", () => {
    const database = new DatabaseSync(":memory:");
    const leases = new ConnectionLeaseService(database);
    const issued = leases.issue(principal, {
      connectionIds: ["connection-1"],
      allowedActions: ["feishu.get_document"],
      invocationId: "invocation-1",
      audience: principal.audience,
    });
    expect(database.prepare("select token_hash from connection_leases").get()).not.toMatchObject({
      token_hash: issued.token,
    });
    expect(leases.revoke(issued.claims.jti, principal)).toBe(true);
    expect(() =>
      leases.verify(issued.token, principal, {
        connectionId: "connection-1",
        actionId: "feishu.get_document",
        invocationId: "invocation-1",
        audience: principal.audience,
      }),
    ).toThrowError(/revoked/);
  });

  it("rejects a lease after the bound connection revision changes", () => {
    const leases = new ConnectionLeaseService(new DatabaseSync(":memory:"));
    const issued = leases.issue(principal, {
      connectionIds: ["connection-1"],
      connectionRevisions: { "connection-1": 1 },
      allowedActions: ["feishu.get_document"],
      invocationId: "invocation-1",
      audience: principal.audience,
    });

    expect(
      leases.verify(issued.token, principal, {
        connectionId: "connection-1",
        connectionRevision: 1,
        actionId: "feishu.get_document",
        invocationId: "invocation-1",
        audience: principal.audience,
      }),
    ).toMatchObject({ connectionRevisions: { "connection-1": 1 } });
    expect(() =>
      leases.verify(issued.token, principal, {
        connectionId: "connection-1",
        connectionRevision: 2,
        actionId: "feishu.get_document",
        invocationId: "invocation-1",
        audience: principal.audience,
      }),
    ).toThrowError(/does not grant/);
  });
});

describe("redaction", () => {
  it("removes credentials from profiles and nested logs", () => {
    expect(
      redactSecrets({
        displayName: "Ops",
        apiKey: "secret-key",
        nested: { refresh_token: "secret-refresh" },
      }),
    ).toEqual({
      displayName: "Ops",
      apiKey: "[REDACTED]",
      nested: { refresh_token: "[REDACTED]" },
    });
  });
});
