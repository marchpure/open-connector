import type { JWTPayload } from "jose";

import { createRemoteJWKSet, jwtVerify } from "jose";

export interface VerifiedOAuthAccessToken {
  issuer: string;
  subject: string;
  audiences: string[];
  scopes: string[];
  clientId?: string;
  expiresAt: number;
  claims: JWTPayload;
}

export type OAuthAccessTokenVerifier = (
  token: string,
  signal?: AbortSignal,
) => Promise<VerifiedOAuthAccessToken | undefined>;

export function createOAuthJwtVerifier(input: {
  jwksUri: string;
  issuer: string;
  audience: string;
}): OAuthAccessTokenVerifier {
  const url = new URL(input.jwksUri);
  if (url.protocol !== "https:") throw new Error("ArkClaw OAuth JWKS URI must use HTTPS.");
  const issuer = input.issuer.trim();
  const audience = input.audience.trim();
  if (!issuer || !audience) throw new Error("ArkClaw OAuth issuer and audience are required.");
  const jwks = createRemoteJWKSet(url);
  return async (token) => {
    try {
      const verified = await jwtVerify(token, jwks, {
        issuer,
        audience,
        requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
      });
      const payload = verified.payload;
      return {
        issuer,
        subject: String(payload.sub),
        audiences: Array.isArray(payload.aud) ? payload.aud : [String(payload.aud)],
        scopes: readScopes(payload.scope ?? payload.scp),
        clientId: stringClaim(payload.client_id) ?? stringClaim(payload.azp),
        expiresAt: Number(payload.exp),
        claims: payload,
      };
    } catch {
      return undefined;
    }
  };
}

function readScopes(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/u).filter(Boolean);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
