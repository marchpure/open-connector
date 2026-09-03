import type { CredentialProfile, ResolvedCredential } from "../core/types.ts";

export type ConnectionVisibility = "personal" | "team";
export type ConnectionStatus = "draft" | "validating" | "ready" | "degraded" | "error" | "revoked";
export type CatalogTier = "catalog" | "beta" | "verified";
export type StructuredDatabaseCapability =
  | "validate_connection"
  | "list_databases"
  | "list_schemas"
  | "list_tables"
  | "describe_table"
  | "preview_table"
  | "execute_read_query";

export interface ProviderCapability {
  name: StructuredDatabaseCapability;
  status: CatalogTier;
  verified: boolean;
  evidenceRef?: string;
  reason?: string;
}

/**
 * Provider-neutral identity for a resource discovered through a managed
 * connection. Provider actions may add native fields, but reads must retain
 * this stable reference and re-check upstream authorization.
 */
export interface ResourceRef {
  sourceType:
    | "feishu"
    | "dingtalk"
    | "wecom"
    | "tencent_docs"
    | "wps_mcp"
    | "baidu_netdisk"
    | "aws_s3"
    | "aliyun_oss"
    | "volcengine_tos"
    | "tencent_cos"
    | "huawei_obs"
    | "minio"
    | "qiniu_kodo"
    | "erpnext"
    | "netsuite"
    | "sap_s4hana"
    | "oracle_fusion_erp"
    | "dynamics_365_finance"
    | "dynamics_365_business_central"
    | "odoo"
    | "kingdee_cloud"
    | "yonyou_bip";
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
  /** Stable Agent Identity user-pool UID, when the principal came from a TIP. */
  userPoolUserUid?: string;
  /** Workload/Agent identity from the verified TIP act.sub claim. */
  agentId?: string;
  /** Userpool memberships carried by a verified TIP. */
  groups?: string[];
  groupIds?: string[];
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
  credentialMode: "local" | "managed";
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
  ownerId: string;
  invocationId: string;
  audience: string;
  connectionIds: string[];
  connectionRevisions?: Record<string, number>;
  allowedActions: string[];
  allowedResources?: {
    schemas?: string[];
    tables?: string[];
  };
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
