import type { IOAuthStateStore, OAuthAuthorizationState } from "../../oauth/oauth-flow-service.ts";

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerOAuthCompatRoutes } from "./oauth-compat.ts";

const origin = "https://connector.example.com";
const issuer = "https://identity.example.com";
const redirectUri = "workbuddy://workbuddy/mcp/custom-mcp%3Atest/oauth/callback";
const loopbackRedirectUri = "http://127.0.0.1/mcp/oauth/callback";
const verifier = "v".repeat(43);
const challenge = "7w_YNF9DSfIdPf_pRjSq646_kPr-2-o9NAl16JGghdM";

describe("OAuth compatibility bridge", () => {
  it("publishes protected-resource and authorization-server metadata", async () => {
    const { app } = createApp();

    await expect((await app.request("/.well-known/oauth-protected-resource/mcp")).json()).resolves.toMatchObject({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    });
    await expect((await app.request("/.well-known/oauth-authorization-server")).json()).resolves.toMatchObject({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
    });
    await expect((await app.request("/.well-known/openid-configuration")).json()).resolves.toMatchObject({
      issuer: origin,
    });
  });

  it("registers only an exact allowlisted redirect URI", async () => {
    const { app } = createApp();
    const accepted = await app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri] }),
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      client_id: "bridge-client",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    });

    for (const candidate of [
      "workbuddy://workbuddy/other/oauth/callback",
      `${redirectUri}/suffix`,
      "workbuddy://evil/mcp/custom-mcp%3Atest/oauth/callback",
    ]) {
      const rejected = await app.request("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [candidate] }),
      });
      expect(rejected.status).toBe(400);
    }
  });

  it("allows only the approved 127.0.0.1 callback path on any temporary port", async () => {
    const { app } = createApp({ allowedRedirectUris: [redirectUri, loopbackRedirectUri] });
    const accepted = await app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:58071/mcp/oauth/callback"] }),
    });
    expect(accepted.status).toBe(200);

    for (const candidate of [
      "http://localhost:58071/mcp/oauth/callback",
      "http://127.0.0.2:58071/mcp/oauth/callback",
      "http://127.0.0.1:58071/oauth/callback",
      "http://127.0.0.1:58071/mcp/oauth/callback?x=1",
      "http://127.0.0.1:58071/mcp/oauth/callback#fragment",
      "http://user@127.0.0.1:58071/mcp/oauth/callback",
    ]) {
      const rejected = await app.request("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [candidate] }),
      });
      expect(rejected.status).toBe(400);
    }
  });

  it("requires S256 and forwards a persisted, signed state to discovery endpoints", async () => {
    const { app, states, request } = createApp();
    const missingPkce = await app.request(
      `/oauth/authorize?client_id=bridge-client&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}`,
    );
    expect(missingPkce.status).toBe(400);

    const response = await authorize(app);
    expect(response.status).toBe(302);
    const upstream = new URL(response.headers.get("location")!);
    expect(upstream.origin + upstream.pathname).toBe(`${issuer}/authorize`);
    expect(upstream.searchParams.get("code_challenge")).toBe(challenge);
    expect(upstream.searchParams.get("code_challenge_method")).toBe("S256");
    expect(upstream.searchParams.get("redirect_uri")).toBe(`${origin}/oauth/callback`);
    const state = upstream.searchParams.get("state")!;
    expect(state).toContain(".");
    expect(states.values.get(state)?.oauthCompat).toMatchObject({
      clientId: "bridge-client",
      redirectUri,
      downstreamState: "workbuddy-state",
      codeChallenge: challenge,
    });
    expect(request).toHaveBeenCalledWith(`${issuer}/.well-known/openid-configuration`, expect.anything());
  });

  it("forwards the server-controlled login prompt to the upstream authorize endpoint", async () => {
    const { app } = createApp({ upstreamPrompt: "login" });
    const response = await authorize(app);
    const upstream = new URL(response.headers.get("location")!);
    expect(upstream.searchParams.get("prompt")).toBe("login");
  });

  it("does not add an upstream prompt by default or allow the client to override it", async () => {
    const { app } = createApp();
    const response = await app.request(
      `/oauth/authorize?${new URLSearchParams({
        client_id: "bridge-client",
        response_type: "code",
        redirect_uri: redirectUri,
        state: "workbuddy-state",
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "consent",
      })}`,
    );
    const upstream = new URL(response.headers.get("location")!);
    expect(upstream.searchParams.has("prompt")).toBe(false);
  });

  it("rejects an unsupported upstream prompt configuration", () => {
    expect(() => createApp({ upstreamPrompt: "consent" as never })).toThrow(
      "OPENCONNECTOR_OAUTH_UPSTREAM_PROMPT must be login when configured.",
    );
  });

  it("atomically consumes callback state and rejects replay", async () => {
    const { app } = createApp();
    const authorization = await authorize(app);
    const state = new URL(authorization.headers.get("location")!).searchParams.get("state")!;

    const completed = await app.request(`/oauth/callback?code=upstream-code&state=${encodeURIComponent(state)}`);
    expect(completed.status).toBe(302);
    const downstream = new URL(completed.headers.get("location")!);
    expect(downstream.searchParams.get("code")).not.toBe("upstream-code");
    expect(downstream.searchParams.get("state")).toBe("workbuddy-state");

    expect((await app.request(`/oauth/callback?code=replay&state=${encodeURIComponent(state)}`)).status).toBe(400);
  });

  it("delegates non-bridge callback state to the existing connector OAuth route", async () => {
    const { app } = createApp();
    app.get("/oauth/callback", (context) => context.text("connector-oauth"));

    const response = await app.request("/oauth/callback?code=provider-code&state=provider-state");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("connector-oauth");
  });

  it("rejects expired signed state", async () => {
    let clock = 1_000_000;
    const { app } = createApp({ now: () => clock, stateTtlSeconds: 30 });
    const authorization = await authorize(app);
    const state = new URL(authorization.headers.get("location")!).searchParams.get("state")!;
    clock += 31_000;

    expect((await app.request(`/oauth/callback?code=late&state=${encodeURIComponent(state)}`)).status).toBe(400);
  });

  it("forwards authorization-code PKCE and injects the confidential client secret", async () => {
    const { app, tokenForms } = createApp();
    const authorization = await authorize(app);
    const state = new URL(authorization.headers.get("location")!).searchParams.get("state")!;
    const callback = await app.request(`/oauth/callback?code=upstream-code&state=${encodeURIComponent(state)}`);
    const bridgeCode = new URL(callback.headers.get("location")!).searchParams.get("code")!;
    const response = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "bridge-client",
        code: bridgeCode,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });
    expect(response.status).toBe(200);
    expect(tokenForms[0]).toMatchObject({
      grant_type: "authorization_code",
      client_id: "bridge-client",
      client_secret: "server-only-secret",
      code: "upstream-code",
      code_verifier: verifier,
      redirect_uri: `${origin}/oauth/callback`,
    });
    expect(
      (
        await app.request("/oauth/token", {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: "bridge-client",
            code: bridgeCode,
            code_verifier: verifier,
            redirect_uri: redirectUri,
          }),
        })
      ).status,
    ).toBe(400);
  });

  it("requires the complete original loopback URI, including its port, at token exchange", async () => {
    const loopback = "http://127.0.0.1:58071/mcp/oauth/callback";
    const { app } = createApp({ allowedRedirectUris: [redirectUri, loopbackRedirectUri] });
    const authorization = await authorizeWithRedirect(app, loopback);
    const state = new URL(authorization.headers.get("location")!).searchParams.get("state")!;
    const callback = await app.request(`/oauth/callback?code=upstream-code&state=${encodeURIComponent(state)}`);
    const bridgeCode = new URL(callback.headers.get("location")!).searchParams.get("code")!;
    const wrongPort = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "bridge-client",
        code: bridgeCode,
        code_verifier: verifier,
        redirect_uri: "http://127.0.0.1:58072/mcp/oauth/callback",
      }),
    });
    expect(wrongPort.status).toBe(400);
  });

  it("forwards refresh grants and rejects unsupported grants", async () => {
    const { app, tokenForms } = createApp();
    const refreshed = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "bridge-client",
        refresh_token: "opaque-refresh-value",
      }),
    });
    expect(refreshed.status).toBe(200);
    expect(tokenForms[0]).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "opaque-refresh-value",
      client_secret: "server-only-secret",
    });
    expect(
      (
        await app.request("/oauth/token", {
          method: "POST",
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: "bridge-client" }),
        })
      ).status,
    ).toBe(400);
  });
});

function createApp(
  overrides: {
    now?: () => number;
    stateTtlSeconds?: number;
    allowedRedirectUris?: string[];
    upstreamPrompt?: "login";
  } = {},
): {
  app: Hono;
  states: MemoryStateStore;
  request: ReturnType<typeof vi.fn>;
  tokenForms: Array<Record<string, string>>;
} {
  const app = new Hono();
  const states = new MemoryStateStore();
  const tokenForms: Array<Record<string, string>> = [];
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    }
    if (url.endsWith("/oauth/token")) {
      tokenForms.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
      return Response.json({ access_token: "redacted-test-value", token_type: "Bearer", expires_in: 300 });
    }
    return new Response(null, { status: 404 });
  });
  registerOAuthCompatRoutes(app, {
    origin,
    upstreamIssuer: issuer,
    clientId: "bridge-client",
    clientSecret: "server-only-secret",
    stateSecret: "state-secret-at-least-32-bytes-long",
    allowedRedirectUris: overrides.allowedRedirectUris ?? [redirectUri],
    states,
    fetch: request as unknown as typeof fetch,
    upstreamPrompt: overrides.upstreamPrompt,
    ...overrides,
  });
  return { app, states, request, tokenForms };
}

async function authorize(app: Hono): Promise<Response> {
  return authorizeWithRedirect(app, redirectUri);
}

async function authorizeWithRedirect(app: Hono, callback: string): Promise<Response> {
  const query = new URLSearchParams({
    client_id: "bridge-client",
    response_type: "code",
    redirect_uri: callback,
    state: "workbuddy-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return await app.request(`/oauth/authorize?${query.toString()}`);
}

class MemoryStateStore implements IOAuthStateStore {
  readonly values = new Map<string, OAuthAuthorizationState>();

  async set(state: OAuthAuthorizationState): Promise<void> {
    this.values.set(state.state, structuredClone(state));
  }

  async take(state: string): Promise<OAuthAuthorizationState | undefined> {
    const value = this.values.get(state);
    this.values.delete(state);
    return value;
  }
}
