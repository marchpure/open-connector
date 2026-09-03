import type { OAuthAccessTokenVerifier, VerifiedOAuthAccessToken } from "./oauth-jwt-verifier.ts";

export interface OAuthIntrospectionVerifierOptions {
  endpoint: string;
  clientId: string;
  clientSecret: string;
  issuer: string;
  audience: string;
  fetcher?: typeof fetch;
}

/** Verify opaque OAuth access tokens using RFC 7662 token introspection. */
export function createOAuthIntrospectionVerifier(options: OAuthIntrospectionVerifierOptions): OAuthAccessTokenVerifier {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "https:") throw new Error("OAuth introspection endpoint must use HTTPS.");
  const clientId = options.clientId.trim();
  const clientSecret = options.clientSecret;
  const issuer = options.issuer.trim();
  const audience = options.audience.trim();
  if (!clientId || !clientSecret || !issuer || !audience) {
    throw new Error("OAuth introspection requires client credentials, issuer, and audience.");
  }
  const fetcher = options.fetcher ?? fetch;
  return async (token, signal) => {
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        signal,
        headers: {
          accept: "application/json",
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token, token_type_hint: "access_token" }),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as Record<string, unknown>;
      const expiresAt = numberClaim(body.exp);
      if (body.active !== true || !expiresAt || expiresAt <= Math.floor(Date.now() / 1000)) return undefined;
      if (stringClaim(body.iss) !== issuer) return undefined;
      const audiences = stringArrayClaim(body.aud);
      if (!audiences.includes(audience)) return undefined;
      const subject = stringClaim(body.sub);
      if (!subject) return undefined;
      return {
        issuer,
        subject,
        audiences,
        scopes: scopesClaim(body.scope ?? body.scp),
        clientId: stringClaim(body.client_id),
        expiresAt,
        claims: body,
      } satisfies VerifiedOAuthAccessToken;
    } catch {
      return undefined;
    }
  };
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberClaim(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stringArrayClaim(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function scopesClaim(value: unknown): string[] {
  return typeof value === "string"
    ? value.split(/\s+/u).filter(Boolean)
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
}
