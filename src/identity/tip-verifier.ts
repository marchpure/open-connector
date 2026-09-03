import type { TipClaims, TipVerifier, VerifiedTip } from "./tip-types.ts";

import { createRemoteJWKSet, customFetch, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { createHash } from "node:crypto";

export interface TipVerifierOptions {
  /** Exact issuer URLs or URL prefixes approved for discovery. */
  allowedIssuers: string[];
  /** Expected audience of the ArkClaw TIP token. This must be configured. */
  audience: string | string[];
  fetcher?: typeof fetch;
  clockToleranceSeconds?: number;
}

export class TipVerificationError extends Error {
  readonly code = "tip_invalid";

  constructor(message = "TIP token is invalid.") {
    super(message);
    this.name = "TipVerificationError";
  }
}

/**
 * Verify ArkClaw TIPs with issuer discovery while preventing token-controlled
 * SSRF. The unverified iss is used only after it matches the configured issuer
 * allowlist; all identity fields come from the verified JWT.
 */
export function createTipVerifier(options: TipVerifierOptions): TipVerifier {
  const allowedIssuers = options.allowedIssuers.map(parseAllowedIssuer);
  const audience = Array.isArray(options.audience) ? options.audience : [options.audience];
  if (allowedIssuers.length === 0 || audience.some((value) => !value.trim())) {
    throw new Error("TIP verifier requires allowed issuers and an expected audience.");
  }
  const fetcher = options.fetcher ?? fetch;
  const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  return async (token, signal) => {
    const raw = token.trim();
    if (!raw) throw new TipVerificationError();
    let issuer: string;
    try {
      const header = decodeProtectedHeader(raw);
      if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
        throw new TipVerificationError("TIP token uses an unsupported signing algorithm.");
      }
      issuer = normalizeIssuer(String(decodeJwt(raw).iss ?? ""));
    } catch (error) {
      if (error instanceof TipVerificationError) throw error;
      throw new TipVerificationError();
    }
    if (!issuerAllowed(issuer, allowedIssuers)) {
      throw new TipVerificationError("TIP issuer is not allowlisted.");
    }

    const discovery = await discover(issuer, fetcher, signal);
    let jwks = jwksByIssuer.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(discovery.jwks_uri), {
        [customFetch]: (url, init) => fetcher(url, init),
      });
      jwksByIssuer.set(issuer, jwks);
    }
    try {
      const verified = await jwtVerify(raw, jwks, {
        issuer,
        audience,
        algorithms: ["RS256"],
        requiredClaims: ["iss", "sub", "exp", "iat"],
        clockTolerance: options.clockToleranceSeconds ?? 5,
      });
      return toVerifiedTip(issuer, verified.payload as TipClaims);
    } catch {
      throw new TipVerificationError();
    }
  };
}

async function discover(issuer: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<{ jwks_uri: string }> {
  const url = new URL(`${issuer}/.well-known/openid-configuration`);
  if (url.protocol !== "https:") throw new TipVerificationError("TIP discovery must use HTTPS.");
  const response = await fetcher(url, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new TipVerificationError("TIP issuer discovery failed.");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TipVerificationError("TIP issuer discovery returned invalid JSON.");
  }
  const jwksUri = body && typeof body === "object" ? (body as Record<string, unknown>).jwks_uri : undefined;
  if (typeof jwksUri !== "string") throw new TipVerificationError("TIP discovery did not provide jwks_uri.");
  const jwks = new URL(jwksUri);
  if (jwks.protocol !== "https:") throw new TipVerificationError("TIP JWKS must use HTTPS.");
  if (jwks.origin !== url.origin) throw new TipVerificationError("TIP JWKS must use the issuer origin.");
  return { jwks_uri: jwks.toString() };
}

function toVerifiedTip(issuer: string, claims: TipClaims): VerifiedTip {
  const external = claims["external.claims"] ?? {};
  const nested = external && typeof external === "object" ? (external as Record<string, unknown>) : {};
  const subject = stringClaim(nested.user_id) ?? stringClaim(claims.sub);
  const tenant = stringClaim(nested.tenant_key) ?? stringClaim(claims.tenant_key);
  if (!subject || !tenant) throw new TipVerificationError("TIP does not contain a stable user and tenant identity.");
  const groups = stringArrayClaim(claims.identity_userpool_groups);
  const groupIds = stringArrayClaim(claims.identity_userpool_group_uids);
  return {
    issuer,
    claims,
    principal: {
      tenantId: tenant,
      workspaceId: tenant,
      subject: stringClaim(claims.sub) ?? subject,
      audience: audienceClaim(claims.aud),
      ownerId: subject,
      ...(stringClaim(claims.sub) ? { userPoolUserUid: stringClaim(claims.sub) } : {}),
      ...(stringClaim(claims.act?.sub) ? { agentId: stringClaim(claims.act?.sub) } : {}),
      ...(groups.length ? { groups } : {}),
      ...(groupIds.length ? { groupIds } : {}),
    },
  };
}

function issuerAllowed(issuer: string, allowlist: Array<{ value: string; prefix: boolean }>): boolean {
  return allowlist.some((entry) => issuer === entry.value || (entry.prefix && issuer.startsWith(`${entry.value}/`)));
}

function parseAllowedIssuer(value: string): { value: string; prefix: boolean } {
  const trimmed = value.trim();
  const prefix = trimmed.endsWith("/*");
  return { value: normalizeIssuer(prefix ? trimmed.slice(0, -2) : trimmed), prefix };
}

function normalizeIssuer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password) {
    throw new TipVerificationError("TIP issuer must be an HTTPS URL without credentials or query parameters.");
  }
  return url.toString().replace(/\/$/u, "");
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayClaim(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function audienceClaim(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

/** Hash helper used by the API-key adapter and tests; the raw key is never logged. */
export function sha256Token(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
