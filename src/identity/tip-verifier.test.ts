import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createTipVerifier } from "./tip-verifier.ts";

describe("TIP verifier", () => {
  it("discovers an allowlisted issuer, verifies RS256, and extracts userpool identity", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "tip-key", alg: "RS256", use: "sig" };
    const issuer = "https://auth.id.cn-beijing.volces.com/workloadpool/pool-a";
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
      }
      if (url === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
      return new Response(null, { status: 404 });
    });
    const token = await new SignJWT({
      "external.claims": { user_id: "user-123", tenant_key: "tenant-a" },
      identity_userpool_groups: ["oracle-readers"],
      identity_userpool_group_uids: ["group-1"],
    })
      .setProtectedHeader({ alg: "RS256", kid: "tip-key" })
      .setIssuer(issuer)
      .setAudience("asi")
      .setSubject("identity-user-123")
      .setIssuedAt()
      .setNotBefore(Math.floor(Date.now() / 1000) - 1)
      .setExpirationTime("5m")
      .sign(privateKey);

    const verify = createTipVerifier({
      allowedIssuers: ["https://auth.id.cn-beijing.volces.com/workloadpool/*"],
      audience: "asi",
      fetcher,
    });
    await expect(verify(token)).resolves.toMatchObject({
      issuer,
      principal: {
        tenantId: "tenant-a",
        ownerId: "user-123",
        subject: "identity-user-123",
        groups: ["oracle-readers"],
        groupIds: ["group-1"],
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects token-controlled discovery before making a request", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ "external.claims": { user_id: "user", tenant_key: "tenant" } })
      .setProtectedHeader({ alg: "RS256", kid: "key" })
      .setIssuer("https://metadata.internal/latest")
      .setAudience("asi")
      .setSubject("subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const fetcher = vi.fn<typeof fetch>();
    const verify = createTipVerifier({
      allowedIssuers: ["https://auth.id.cn-beijing.volces.com/workloadpool/*"],
      audience: "asi",
      fetcher,
    });
    await expect(verify(token)).rejects.toThrow(/issuer is not allowlisted/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a wrong audience", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "tip-key", alg: "RS256", use: "sig" };
    const issuer = "https://auth.id.cn-beijing.volces.com/workloadpool/pool-a";
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("openid-configuration")
        ? Response.json({ issuer, jwks_uri: `${issuer}/jwks` })
        : Response.json({ keys: [jwk] }),
    );
    const token = await new SignJWT({ "external.claims": { user_id: "user", tenant_key: "tenant" } })
      .setProtectedHeader({ alg: "RS256", kid: "tip-key" })
      .setIssuer(issuer)
      .setAudience("wrong")
      .setSubject("subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const verify = createTipVerifier({ allowedIssuers: [issuer], audience: "asi", fetcher });
    await expect(verify(token)).rejects.toThrow(/TIP token is invalid/i);
  });
});
