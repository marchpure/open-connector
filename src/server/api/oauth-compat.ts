import type { IOAuthStateStore, OAuthAuthorizationState } from "../../oauth/oauth-flow-service.ts";
import type { Context, Hono } from "hono";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface OAuthCompatOptions {
  origin: string;
  upstreamIssuer: string;
  clientId: string;
  clientSecret: string;
  stateSecret: string;
  allowedRedirectUris: string[];
  states: IOAuthStateStore;
  scopes?: string;
  upstreamPrompt?: "login";
  stateTtlSeconds?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri?: string;
}

const defaultScopes = "openid profile email offline_access";
const defaultStateTtlSeconds = 600;
const bridgeStateService = "__openconnector_oauth_compat__";

export function registerOAuthCompatRoutes(app: Hono, options: OAuthCompatOptions): void {
  const origin = normalizeHttpsOrigin(options.origin);
  const upstreamIssuer = normalizeHttpsOrigin(options.upstreamIssuer);
  const redirectEndpoint = `${origin}/oauth/callback`;
  const scopes = normalizeScopes(options.scopes);
  const upstreamPrompt = normalizeUpstreamPrompt(options.upstreamPrompt);
  const allowedRedirectUris = options.allowedRedirectUris.map(normalizeAllowedRedirectUri);
  if (allowedRedirectUris.length === 0) {
    throw new Error("OPENCONNECTOR_OAUTH_ALLOWED_REDIRECT_URIS must contain at least one exact redirect URI.");
  }
  const exactAllowedRedirectUris = new Set(allowedRedirectUris.filter((value) => !isLoopbackRedirectUri(value)));
  const loopbackAllowedRedirectUris = allowedRedirectUris.filter(isLoopbackRedirectUri).map(loopbackRedirectKey);
  const stateTtlMs = (options.stateTtlSeconds ?? defaultStateTtlSeconds) * 1000;
  if (!Number.isSafeInteger(stateTtlMs) || stateTtlMs < 30_000 || stateTtlMs > 900_000) {
    throw new Error("OAuth compatibility state TTL must be between 30 and 900 seconds.");
  }
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let metadataPromise: Promise<OidcMetadata> | undefined;
  const getMetadata = (): Promise<OidcMetadata> =>
    (metadataPromise ??= discoverOidcMetadata(upstreamIssuer, request).catch((error) => {
      metadataPromise = undefined;
      throw error;
    }));

  const authorizationMetadata = {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: scopes,
  };
  const resourceMetadata = {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: scopes,
  };

  const writeJson = (context: Context, body: unknown, status: 200 | 400 | 405 | 502 = 200): Response =>
    context.json(body, status, { "Cache-Control": "no-store" });

  app.get("/.well-known/oauth-protected-resource", (context) => writeJson(context, resourceMetadata));
  app.get("/.well-known/oauth-protected-resource/mcp", (context) => writeJson(context, resourceMetadata));
  app.get("/.well-known/oauth-authorization-server", (context) => writeJson(context, authorizationMetadata));
  app.get("/.well-known/openid-configuration", (context) => writeJson(context, authorizationMetadata));

  app.post("/oauth/register", async (context) => {
    const body = await readRegistration(context);
    if (!body) return writeJson(context, { error: "invalid_client_metadata" }, 400);
    const redirectUris = readStringArray(body.redirect_uris);
    if (
      redirectUris.length === 0 ||
      redirectUris.some((value) => !isRedirectUriAllowed(value, exactAllowedRedirectUris, loopbackAllowedRedirectUris))
    ) {
      return writeJson(
        context,
        { error: "invalid_redirect_uri", error_description: "Every redirect_uri must be explicitly allowlisted." },
        400,
      );
    }
    return writeJson(context, {
      client_id: options.clientId,
      client_id_issued_at: Math.floor(now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  app.get("/oauth/authorize", async (context) => {
    const query = context.req.query();
    const redirectUri = query.redirect_uri;
    if (
      query.client_id !== options.clientId ||
      query.response_type !== "code" ||
      !redirectUri ||
      !isRedirectUriAllowed(redirectUri, exactAllowedRedirectUris, loopbackAllowedRedirectUris)
    ) {
      return writeJson(context, { error: "invalid_request", error_description: "Unsupported OAuth client." }, 400);
    }
    if (!isValidPkceChallenge(query.code_challenge) || query.code_challenge_method !== "S256") {
      return writeJson(
        context,
        { error: "invalid_request", error_description: "PKCE code_challenge_method S256 is required." },
        400,
      );
    }

    const nonce = randomBytes(32).toString("base64url");
    const issuedAt = now();
    const signedState = signState(
      {
        nonce,
        issuedAt,
        clientId: options.clientId,
        redirectUri,
        codeChallenge: query.code_challenge,
      },
      options.stateSecret,
    );
    const pending: OAuthAuthorizationState = {
      service: bridgeStateService,
      state: signedState,
      createdAt: new Date(issuedAt).toISOString(),
      oauthCompat: {
        clientId: options.clientId,
        redirectUri,
        downstreamState: query.state ?? "",
        codeChallenge: query.code_challenge,
        codeChallengeMethod: "S256",
        nonce,
      },
    };
    await options.states.set(pending);

    try {
      const upstreamMetadata = await getMetadata();
      const upstream = new URL(upstreamMetadata.authorization_endpoint);
      upstream.searchParams.set("response_type", "code");
      upstream.searchParams.set("client_id", options.clientId);
      upstream.searchParams.set("redirect_uri", redirectEndpoint);
      upstream.searchParams.set("scope", query.scope || scopes.join(" "));
      upstream.searchParams.set("state", signedState);
      upstream.searchParams.set("code_challenge", query.code_challenge);
      upstream.searchParams.set("code_challenge_method", "S256");
      if (upstreamPrompt) upstream.searchParams.set("prompt", upstreamPrompt);
      if (query.resource) upstream.searchParams.set("resource", query.resource);
      return context.redirect(upstream.toString(), 302);
    } catch {
      await options.states.take(signedState);
      return writeJson(context, { error: "temporarily_unavailable" }, 502);
    }
  });

  app.get("/oauth/callback", async (context, next) => {
    const code = context.req.query("code");
    const signedState = context.req.query("state");
    if (!signedState?.includes(".")) {
      await next();
      return;
    }
    const verifiedState = signedState && verifyState(signedState, options.stateSecret, now(), stateTtlMs);
    if (!code || !signedState || !verifiedState) {
      return context.text("OAuth authorization state is invalid or expired.", 400);
    }
    const pending = await options.states.take(signedState);
    if (
      !isValidPendingState(
        pending,
        options.clientId,
        exactAllowedRedirectUris,
        loopbackAllowedRedirectUris,
        now(),
        stateTtlMs,
      ) ||
      !stateMatchesPending(verifiedState, pending.oauthCompat)
    ) {
      return context.text("OAuth authorization state is invalid or expired.", 400);
    }
    const bridgeCode = randomBytes(32).toString("base64url");
    await options.states.set({
      ...pending,
      state: bridgeCode,
      createdAt: new Date(now()).toISOString(),
      oauthCompat: { ...pending.oauthCompat, upstreamAuthorizationCode: code },
    });
    const redirect = new URL(pending.oauthCompat.redirectUri);
    redirect.searchParams.set("code", bridgeCode);
    if (pending.oauthCompat.downstreamState) {
      redirect.searchParams.set("state", pending.oauthCompat.downstreamState);
    }
    return context.redirect(redirect.toString(), 302);
  });

  app.get("/oauth/token", (context) => writeJson(context, { error: "invalid_request" }, 405));
  app.post("/oauth/token", async (context) => {
    const form = new URLSearchParams(await context.req.text());
    if (form.get("client_id") !== options.clientId) {
      return writeJson(context, { error: "invalid_client" }, 400);
    }
    const grantType = form.get("grant_type");
    const upstreamForm = new URLSearchParams({
      grant_type: grantType ?? "",
      client_id: options.clientId,
      client_secret: options.clientSecret,
    });
    if (grantType === "authorization_code") {
      const code = form.get("code");
      const verifier = form.get("code_verifier");
      const redirectUri = form.get("redirect_uri");
      if (!code || !isValidPkceVerifier(verifier) || !redirectUri) {
        return writeJson(
          context,
          {
            error: "invalid_request",
            error_description: "code, redirect_uri, and a valid code_verifier are required.",
          },
          400,
        );
      }
      const pending = await options.states.take(code);
      if (
        !isValidPendingState(
          pending,
          options.clientId,
          exactAllowedRedirectUris,
          loopbackAllowedRedirectUris,
          now(),
          stateTtlMs,
        ) ||
        !pending.oauthCompat.upstreamAuthorizationCode ||
        pending.oauthCompat.redirectUri !== redirectUri ||
        createPkceChallenge(verifier) !== pending.oauthCompat.codeChallenge
      ) {
        return writeJson(context, { error: "invalid_grant" }, 400);
      }
      upstreamForm.set("code", pending.oauthCompat.upstreamAuthorizationCode);
      upstreamForm.set("code_verifier", verifier);
      upstreamForm.set("redirect_uri", redirectEndpoint);
    } else if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token");
      if (!refreshToken) {
        return writeJson(context, { error: "invalid_request", error_description: "refresh_token is required." }, 400);
      }
      upstreamForm.set("refresh_token", refreshToken);
      const scope = form.get("scope");
      if (scope) upstreamForm.set("scope", scope);
    } else {
      return writeJson(context, { error: "unsupported_grant_type" }, 400);
    }

    try {
      const upstreamMetadata = await getMetadata();
      const response = await request(upstreamMetadata.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: upstreamForm,
      });
      return new Response(await response.text(), {
        status: response.status,
        headers: {
          "content-type": response.headers.get("content-type") || "application/json",
          "cache-control": "no-store",
        },
      });
    } catch {
      return writeJson(context, { error: "temporarily_unavailable" }, 502);
    }
  });
}

async function discoverOidcMetadata(issuer: string, request: typeof fetch): Promise<OidcMetadata> {
  const response = await request(`${issuer}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("Upstream OIDC discovery failed.");
  const value = (await response.json()) as Partial<OidcMetadata>;
  if (
    normalizeHttpsOrigin(value.issuer ?? "") !== issuer ||
    !isHttpsUrl(value.authorization_endpoint) ||
    !isHttpsUrl(value.token_endpoint)
  ) {
    throw new Error("Upstream OIDC discovery is invalid.");
  }
  return value as OidcMetadata;
}

function normalizeHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("OAuth origin and upstream issuer must be HTTPS URLs.");
  }
  return url.toString().replace(/\/$/u, "");
}

function normalizeAllowedRedirectUri(value: string): string {
  const normalized = value.trim();
  const url = new URL(normalized);
  if (url.toString() !== normalized || url.username || url.password || url.search || url.hash) {
    throw new Error(`OAuth redirect URI must be an exact canonical URI: ${normalized}`);
  }
  return normalized;
}

/**
 * Returns true only for the approved loopback callback shape. The port is
 * intentionally ignored during registration/authorization matching because
 * WorkBuddy binds its native callback listener to an ephemeral port.
 */
function isLoopbackRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) {
      return false;
    }
    return url.hostname === "127.0.0.1" && url.pathname === "/mcp/oauth/callback";
  } catch {
    return false;
  }
}

/**
 * Produces a port-independent key for a loopback redirect URI so that
 * http://127.0.0.1:1234/mcp/oauth/callback matches the allowlisted
 * http://127.0.0.1/mcp/oauth/callback.
 */
function loopbackRedirectKey(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname}${url.pathname}`;
}

function isRedirectUriAllowed(value: string, exact: Set<string>, loopbackKeys: string[]): boolean {
  if (exact.has(value)) return true;
  if (isLoopbackRedirectUri(value)) {
    const key = loopbackRedirectKey(value);
    return loopbackKeys.includes(key);
  }
  return false;
}

function normalizeScopes(value: string | undefined): string[] {
  return [...new Set((value?.trim() || defaultScopes).split(/\s+/u).filter(Boolean))];
}

function normalizeUpstreamPrompt(value: string | undefined): "login" | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (value === "login") return value;
  throw new Error("OPENCONNECTOR_OAUTH_UPSTREAM_PROMPT must be login when configured.");
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isValidPkceChallenge(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9_-]{43}$/u.test(value));
}

function isValidPkceVerifier(value: string | null): value is string {
  return Boolean(value && /^[A-Za-z0-9._~-]{43,128}$/u.test(value));
}

interface SignedState {
  nonce: string;
  issuedAt: number;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
}

function signState(value: SignedState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyState(value: string, secret: string, now: number, ttlMs: number): SignedState | undefined {
  const [payload, signature, ...extra] = value.split(".");
  if (!payload || !signature || extra.length > 0) return undefined;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return undefined;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof decoded.nonce === "string" &&
      decoded.nonce.length >= 32 &&
      typeof decoded.issuedAt === "number" &&
      decoded.issuedAt <= now &&
      now - decoded.issuedAt <= ttlMs &&
      typeof decoded.clientId === "string" &&
      typeof decoded.redirectUri === "string" &&
      typeof decoded.codeChallenge === "string"
    ) {
      return decoded as unknown as SignedState;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isValidPendingState(
  value: OAuthAuthorizationState | undefined,
  clientId: string,
  exactAllowedRedirectUris: Set<string>,
  loopbackAllowedRedirectUris: string[],
  now: number,
  ttlMs: number,
): value is OAuthAuthorizationState & { oauthCompat: NonNullable<OAuthAuthorizationState["oauthCompat"]> } {
  if (!value?.oauthCompat || value.service !== bridgeStateService) return false;
  const createdAt = Date.parse(value.createdAt);
  return (
    Number.isFinite(createdAt) &&
    createdAt <= now &&
    now - createdAt <= ttlMs &&
    value.oauthCompat.clientId === clientId &&
    value.oauthCompat.codeChallengeMethod === "S256" &&
    isValidPkceChallenge(value.oauthCompat.codeChallenge) &&
    isRedirectUriAllowed(value.oauthCompat.redirectUri, exactAllowedRedirectUris, loopbackAllowedRedirectUris)
  );
}

function stateMatchesPending(
  state: SignedState,
  pending: NonNullable<OAuthAuthorizationState["oauthCompat"]>,
): boolean {
  return (
    state.nonce === pending.nonce &&
    state.clientId === pending.clientId &&
    state.redirectUri === pending.redirectUri &&
    state.codeChallenge === pending.codeChallenge
  );
}

function createPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function readRegistration(context: Context): Promise<Record<string, unknown> | undefined> {
  try {
    const value = (await context.req.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}
