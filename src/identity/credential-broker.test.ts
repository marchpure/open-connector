import { describe, expect, it, vi } from "vitest";
import { HttpCredentialBroker } from "./credential-broker.ts";

const principal = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  subject: "subject-a",
  ownerId: "user-a",
  audience: "asi",
};

describe("HttpCredentialBroker", () => {
  it("sends only identity and references to the broker", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        status: "ready",
        credential: {
          authType: "custom_credential",
          values: { username: "reader", password: "secret" },
          profile: { accountId: "reader", displayName: "reader", grantedScopes: ["read"] },
          metadata: {},
        },
      }),
    );
    const broker = new HttpCredentialBroker(new URL("https://identity.example/resolve"), "broker-token", fetcher);
    await expect(
      broker.resolve({
        credentialRef: "identity://oracle/1",
        principal,
        resourceId: "resource-1",
        service: "oracle_database",
      }),
    ).resolves.toMatchObject({ status: "ready", credential: { authType: "custom_credential" } });
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://identity.example/resolve"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer broker-token" }),
        body: JSON.stringify({
          credentialRef: "identity://oracle/1",
          resourceId: "resource-1",
          service: "oracle_database",
          subject: "subject-a",
          userId: "user-a",
          tenantId: "tenant-a",
        }),
      }),
    );
  });

  it("accepts only HTTPS endpoints and authorization redirects", async () => {
    expect(() => new HttpCredentialBroker(new URL("http://identity.example/resolve"), "token")).toThrow(/HTTPS/);
    const broker = new HttpCredentialBroker(new URL("https://identity.example/resolve"), "token", async () =>
      Response.json({ status: "authorization_required", authorizationUrl: "javascript:alert(1)" }),
    );
    await expect(
      broker.resolve({ credentialRef: "ref", principal, resourceId: "resource", service: "oracle_database" }),
    ).rejects.toThrow(/must use HTTPS/);
  });
});
