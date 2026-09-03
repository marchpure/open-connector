import type { TenantPrincipal } from "../control-plane/types.ts";

export type TipClaims = Record<string, unknown> & {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  act?: { sub?: unknown };
  tenant_key?: string;
  identity_userpool_groups?: unknown;
  identity_userpool_group_uids?: unknown;
  "external.claims"?: Record<string, unknown>;
};

export interface VerifiedTip {
  principal: TenantPrincipal;
  issuer: string;
  claims: TipClaims;
}

export type TipVerifier = (token: string, signal?: AbortSignal) => Promise<VerifiedTip>;
