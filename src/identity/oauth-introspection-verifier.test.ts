import { describe, expect, it, vi } from "vitest";
import { createOAuthIntrospectionVerifier } from "./oauth-introspection-verifier.ts";

describe("OAuth opaque-token introspection", () => {
  it("validates active issuer/audience-bound tokens and preserves identity claims", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        active: true,
        iss: "https://idp.example",
        aud: ["oracle-mcp"],
        sub: "user-1",
        user_id: "user-1",
        client_id: "arkclaw-app",
        scope: "oracle.read profile",
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    );
    const verify = createOAuthIntrospectionVerifier({
      endpoint: "https://idp.example/introspect",
      clientId: "mcp-server",
      clientSecret: "secret",
      issuer: "https://idp.example",
      audience: "oracle-mcp",
      fetcher,
    });
    await expect(verify("opaque-token")).resolves.toMatchObject({
      subject: "user-1",
      scopes: ["oracle.read", "profile"],
      clientId: "arkclaw-app",
      claims: { user_id: "user-1" },
    });
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://idp.example/introspect"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: expect.stringMatching(/^Basic /u) }),
      }),
    );
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain("secret");
  });

  it("rejects inactive, expired, and incorrectly addressed tokens", async () => {
    const cases = [
      { active: false },
      { active: true, iss: "https://idp.example", aud: "oracle-mcp", sub: "u", exp: 1 },
      { active: true, iss: "https://wrong.example", aud: "oracle-mcp", sub: "u", exp: 4_000_000_000 },
      { active: true, iss: "https://idp.example", aud: "wrong", sub: "u", exp: 4_000_000_000 },
    ];
    for (const body of cases) {
      const verify = createOAuthIntrospectionVerifier({
        endpoint: "https://idp.example/introspect",
        clientId: "mcp-server",
        clientSecret: "secret",
        issuer: "https://idp.example",
        audience: "oracle-mcp",
        fetcher: async () => Response.json(body),
      });
      await expect(verify("token")).resolves.toBeUndefined();
    }
  });
});
