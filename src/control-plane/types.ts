import type { CredentialProfile, ResolvedCredential } from "../core/types.ts";

export type ConnectionVisibility = "personal" | "team";
export type ConnectionStatus = "draft" | "validating" | "ready" | "degraded" | "error" | "revoked";
export type CatalogTier = "catalog" | "beta" | "verified";

export interface TenantPrincipal {
  tenantId: string;
  workspaceId: string;
  subject: string;
  audience: string;
  ownerId: string;
}

export interface ConnectionRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  ownerId: string;
  service: string;
  connectionName: string;
  connectorDefinitionVersion: string;
  credentialRef: string;
  status: ConnectionStatus;
  revision: number;
  visibility: ConnectionVisibility;
  profile: CredentialProfile;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionLeaseClaims {
  tenantId: string;
  workspaceId: string;
  subject: string;
  invocationId: string;
  audience: string;
  connectionIds: string[];
  connectionRevisions?: Record<string, number>;
  allowedActions: string[];
  issuedAt: string;
  expiresAt: string;
  jti: string;
}

export interface StoredTenantCredential {
  credential: ResolvedCredential;
  revision: number;
}

export interface ExecutionAudit {
  id: string;
  tenantId: string;
  workspaceId: string;
  subject: string;
  invocationId: string;
  connectionId: string;
  actionId: string;
  ok: boolean;
  errorCode?: string;
  startedAt: string;
  completedAt: string;
}
