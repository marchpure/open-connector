import type { Context, Hono } from "hono";

import { createHmac, timingSafeEqual } from "node:crypto";

export interface OAuthCompatOptions {
  origin: string;
  upstreamIssuer: string;
  clientId: string;
  clientSecret?: string;
  stateSecret: string;
  scopes?: string;
}

const defaultScopes = "openid profile email offline_access";

export function registerOAuthCompatRoutes(app: Hono, options: OAuthCompatOptions): void {
  const upstreamIssuer = normalizeIssuer(options.upstreamIssuer);
  const redirectEndpoint = `${options.origin}/oauth/callback`;
  const scopes = options.scopes?.trim() || defaultScopes;

  const metadata = {
    issuer: options.origin,
    authorization_endpoint: `${options.origin}/oauth/authorize`,
    token_endpoint: `${options.origin}/oauth/token`,
    registration_endpoint: `${options.origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: scopes.split(/\s+/u),
  };
  const resourceMetadata = {
    resource: options.origin,
    authorization_servers: [options.origin],
    scopes_supported: scopes.split(/\s+/u),
  };

  const writeJson = (context: Context, body: unknown, status: 200 | 400 | 405 = 200): Response =>
    context.json(body, status, { "Cache-Control": "no-store" });

  const registration = (context: Context): Response =>
    writeJson(context, {
      client_id: options.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });

  app.get("/.well-known/oauth-protected-resource", (context) => writeJson(context, resourceMetadata));
  app.get("/.well-known/oauth-protected-resource/mcp", (context) => writeJson(context, resourceMetadata));
  app.get("/.well-known/oauth-authorization-server", (context) => writeJson(context, metadata));
  app.get("/.well-known/oauth-authorization-server/mcp", (context) => writeJson(context, metadata));
  app.get("/.well-known/openid-configuration", (context) => writeJson(context, metadata));
  app.get("/.well-known/openid-configuration/mcp", (context) => writeJson(context, metadata));
  app.post("/oauth/register", registration);
  app.post("/oauth/register/", registration);

  app.get("/oauth/authorize", async (context) => {
    const query = context.req.query();
    if (query.client_id !== options.clientId || query.response_type !== "code") {
      return writeJson(context, { error: "invalid_request", error_description: "Unsupported OAuth client." }, 400);
    }
    const redirectUri = query.redirect_uri;
    if (!redirectUri || !isAllowedWorkBuddyRedirect(redirectUri)) {
      return writeJson(context, { error: "invalid_request", error_description: "Invalid redirect_uri." }, 400);
    }
    const state = query.state ?? "";
    const signedState = signState(
      {
        redirectUri,
        state,
        clientId: query.client_id,
      },
      options.stateSecret,
    );
    const upstream = new URL(`${upstreamIssuer}/authorize`);
    upstream.searchParams.set("response_type", "code");
    upstream.searchParams.set("client_id", options.clientId);
    upstream.searchParams.set("redirect_uri", redirectEndpoint);
    upstream.searchParams.set("scope", query.scope || scopes);
    upstream.searchParams.set("state", signedState);
    if (query.code_challenge) upstream.searchParams.set("code_challenge", query.code_challenge);
    if (query.code_challenge_method) upstream.searchParams.set("code_challenge_method", query.code_challenge_method);
    if (query.resource) upstream.searchParams.set("resource", query.resource);
    return context.redirect(upstream.toString(), 302);
  });

  app.get("/oauth/token", (context) => writeJson(context, { error: "invalid_request" }, 405));
  app.post("/oauth/token", async (context) => {
    const form = await readForm(context);
    if (form.get("client_id") !== options.clientId || form.get("grant_type") !== "authorization_code") {
      return writeJson(context, { error: "invalid_request", error_description: "Unsupported OAuth request." }, 400);
    }
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    if (!code || !verifier) {
      return writeJson(
        context,
        { error: "invalid_request", error_description: "code and code_verifier are required." },
        400,
      );
    }
    const upstreamForm = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectEndpoint,
      client_id: options.clientId,
    });
    if (options.clientSecret) upstreamForm.set("client_secret", options.clientSecret);
    const response = await fetch(`${upstreamIssuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: upstreamForm,
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
      },
    });
  });

  app.get("/oauth/callback", (context) => {
    const code = context.req.query("code");
    const signedState = context.req.query("state");
    if (!code || !signedState) return context.text("OAuth authorization failed.", 400);
    const state = verifyState(signedState, options.stateSecret);
    if (!state || state.clientId !== options.clientId || !isAllowedWorkBuddyRedirect(state.redirectUri)) {
      return context.text("OAuth authorization state is invalid.", 400);
    }
    const redirect = new URL(state.redirectUri);
    redirect.searchParams.set("code", code);
    if (state.state) redirect.searchParams.set("state", state.state);
    return context.redirect(redirect.toString(), 302);
  });
}

function normalizeIssuer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("OAuth compatibility upstream issuer must use HTTPS.");
  return url.toString().replace(/\/$/u, "");
}

function isAllowedWorkBuddyRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "workbuddy:" || (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

function signState(value: Record<string, string>, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyState(value: string, secret: string): Record<string, string> | undefined {
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return undefined;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(decoded).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return undefined;
  }
}

async function readForm(context: Context): Promise<URLSearchParams> {
  const body = await context.req.text();
  return new URLSearchParams(body);
}
