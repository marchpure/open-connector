import type { CredentialProfile, ResolvedCredential } from "../core/types.ts";

export type ConnectionVisibility = "personal" | "team";
export type ConnectionStatus = "draft" | "validating" | "ready" | "degraded" | "error" | "revoked";
export type CatalogTier = "catalog" | "beta" | "verified";

/**
 * Provider-neutral identity for a resource discovered through an office
 * connection. Provider actions may add native fields, but reads must retain
 * this stable reference and re-check upstream authorization.
 */
export interface ResourceRef {
  sourceType: "feishu" | "dingtalk" | "wecom";
  tenantId: string;
  workspaceId: string;
  connectionId: string;
  resourceId: string;
  resourceToken?: string;
  version?: string;
  etag?: string;
  title?: string;
  mimeType?: string;
  schema?: Record<string, unknown>;
  owner?: { id: string; displayName?: string };
  aclSummary?: { visibility: "private" | "shared" | "team"; subjectCount?: number };
  url?: string;
}

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
