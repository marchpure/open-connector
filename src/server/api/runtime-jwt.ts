import type { IdentityProviderConfig, RuntimeSubject } from "../access/access-grants.ts";
import type { JWTPayload } from "jose";

import { createRemoteJWKSet, jwtVerify } from "jose";

export interface RuntimeJwtConfig {
  jwksUri?: string;
  issuer?: string;
  audience?: string;
  userPoolRef?: string;
  subjectClaim?: string;
  groupsClaim?: string;
  tenantClaim?: string;
  tenant?: string;
  allowedClientIds?: string[];
  tokenTypeClaim?: string;
  tokenType?: string;
  requireGroupsClaim?: boolean;
  requireNbf?: boolean;
  requireUserPoolRefInIssuer?: boolean;
}

export type RuntimeJwtVerifier = (token: string) => Promise<RuntimeSubject | boolean | undefined>;

/**
 * Creates a JWT access-token verifier when all runtime JWT settings are configured.
 */
export function createRuntimeJwtVerifier(config: RuntimeJwtConfig): RuntimeJwtVerifier | undefined {
  const jwksUri = config.jwksUri?.trim();
  const issuer = config.issuer?.trim();
  const audience = config.audience?.trim();
  if (!jwksUri && !issuer && !audience) {
    return undefined;
  }

  if (!jwksUri || !issuer || !audience) {
    const missing = [
      ["OOMOL_CONNECT_JWKS_URI", jwksUri],
      ["OOMOL_CONNECT_JWT_ISSUER", issuer],
      ["OOMOL_CONNECT_JWT_AUDIENCE", audience],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    throw new Error(`Runtime JWT authentication settings must be configured together; missing: ${missing.join(", ")}.`);
  }

  let url: URL;
  try {
    url = new URL(jwksUri);
  } catch {
    throw new Error("OOMOL_CONNECT_JWKS_URI must be a valid HTTPS URL or HTTP loopback URL.");
  }
  if (url.protocol !== "https:" && !isLoopbackHttpUrl(url)) {
    throw new Error("OOMOL_CONNECT_JWKS_URI must be a valid HTTPS URL or HTTP loopback URL.");
  }

  const jwks = createRemoteJWKSet(url);
  return async (token) => {
    try {
      const requiredClaims = ["exp", "sub"];
      if (config.requireNbf) requiredClaims.push("nbf");
      if (config.tokenTypeClaim) requiredClaims.push(config.tokenTypeClaim);
      const verified = await jwtVerify(token, jwks, {
        algorithms: ["RS256"],
        issuer,
        audience,
        requiredClaims,
      });
      return resolveSubject(verified.payload, {
        issuer,
        audience,
        jwksUri,
        userPoolRef: config.userPoolRef?.trim() || issuer,
        subjectClaim: config.subjectClaim?.trim() || "sub",
        groupsClaim: config.groupsClaim?.trim() || "groups",
        tenantClaim: config.tenantClaim?.trim(),
        tenant: config.tenant?.trim(),
        allowedClientIds: normalizeStringList(config.allowedClientIds),
        tokenTypeClaim: config.tokenTypeClaim?.trim(),
        tokenType: config.tokenType?.trim(),
        requireGroupsClaim: config.requireGroupsClaim,
        requireNbf: config.requireNbf,
        requireUserPoolRefInIssuer: config.requireUserPoolRefInIssuer,
      });
    } catch {
      return undefined;
    }
  };
}

export function createRuntimeJwtVerifierFromIdentityConfig(
  getConfig: () => Promise<IdentityProviderConfig | undefined>,
): RuntimeJwtVerifier {
  let cache:
    | {
        key: string;
        verify: RuntimeJwtVerifier;
      }
    | undefined;
  return async (token) => {
    const config = await getConfig();
    if (!config) return undefined;
    const key = JSON.stringify(config);
    if (!cache || cache.key !== key) {
      cache = {
        key,
        verify: createRequiredRuntimeJwtVerifier({
          jwksUri: config.jwksUri,
          issuer: config.issuer,
          audience: config.audience,
          userPoolRef: config.userPoolRef,
          subjectClaim: config.subjectClaim,
          groupsClaim: config.groupsClaim,
          tenantClaim: config.tenantClaim,
          tenant: config.tenant,
          allowedClientIds: config.allowedClientIds,
          tokenTypeClaim: config.tokenTypeClaim,
          tokenType: config.tokenType,
          requireGroupsClaim: config.requireGroupsClaim,
          requireNbf: config.requireNbf,
          requireUserPoolRefInIssuer: config.requireUserPoolRefInIssuer,
        }),
      };
    }
    return cache.verify(token);
  };
}

function createRequiredRuntimeJwtVerifier(
  config: Required<Pick<RuntimeJwtConfig, "jwksUri" | "issuer" | "audience">> & RuntimeJwtConfig,
): RuntimeJwtVerifier {
  const verifier = createRuntimeJwtVerifier(config);
  if (!verifier) {
    throw new Error("Runtime JWT verifier requires issuer, audience, and JWKS URI.");
  }
  return verifier;
}

function resolveSubject(payload: JWTPayload, config: IdentityProviderConfig): RuntimeSubject | undefined {
  const sub = readStringClaim(payload, config.subjectClaim);
  if (!sub) return undefined;
  if (config.tokenTypeClaim && readStringClaim(payload, config.tokenTypeClaim) !== config.tokenType) return undefined;
  const clientId = readStringClaim(payload, "client_id") ?? readStringClaim(payload, "azp");
  if (config.allowedClientIds?.length && (!clientId || !config.allowedClientIds.includes(clientId))) return undefined;
  if (config.requireNbf && typeof payload.nbf !== "number") return undefined;
  if (config.requireGroupsClaim && !Array.isArray(payload[config.groupsClaim])) return undefined;
  if (config.requireUserPoolRefInIssuer && !issuerContainsUserPoolRef(config.issuer, config.userPoolRef)) {
    return undefined;
  }
  const tenant = config.tenantClaim ? readStringClaim(payload, config.tenantClaim) : config.tenant;
  if (config.tenant && tenant !== config.tenant) return undefined;
  return {
    issuer: config.issuer,
    audience: config.audience,
    userPoolRef: config.userPoolRef,
    tenant,
    sub,
    groups: readGroupsClaim(payload, config.groupsClaim),
  };
}

function normalizeStringList(values: string[] | undefined): string[] | undefined {
  const normalized = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
  return normalized.length ? normalized : undefined;
}

function issuerContainsUserPoolRef(issuer: string, userPoolRef: string): boolean {
  try {
    const hostname = new URL(issuer).hostname.toLowerCase();
    return hostname.startsWith(`userpool-${userPoolRef.toLowerCase()}.`);
  } catch {
    return false;
  }
}

function readStringClaim(payload: JWTPayload, claim: string): string | undefined {
  if (claim === "sub" && payload.sub) {
    return payload.sub;
  }
  const value = payload[claim];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readGroupsClaim(payload: JWTPayload, claim: string): string[] {
  const value = payload[claim];
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
          .map((item) => item.trim()),
      ),
    ];
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function isLoopbackHttpUrl(url: URL): boolean {
  if (url.protocol !== "http:") {
    return false;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
}
