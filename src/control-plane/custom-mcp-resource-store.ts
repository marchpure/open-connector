import type { TenantPrincipal } from "./types.ts";
import type { DatabaseSync } from "node:sqlite";

export type CustomMcpProtocol = "http" | "sse" | "streamable_http";
export type CustomMcpVisibility = "personal" | "team" | "partial";
export type CustomMcpIngressAuth = "api_key" | "oauth2";

export interface CustomMcpResourceRecord {
  resourceId: string;
  tenantId: string;
  workspaceId: string;
  ownerId: string;
  displayName: string;
  upstreamUrl: string;
  protocol: CustomMcpProtocol;
  credentialProviderName?: string;
  credentialProviderType?: "api_key" | "oauth2";
  ingressAuth: CustomMcpIngressAuth;
  ingressApiKeyHashes: string[];
  requiredOAuthScopes: string[];
  allowedOAuthClientIds: string[];
  oauthIdentityClaims: string[];
  allowedSubjects: string[];
  allowedGroups: string[];
  allowedAgentIds: string[];
  visibility: CustomMcpVisibility;
  allowPrivateNetwork: boolean;
  forwardAuthorization: boolean;
  forwardTipToken: boolean;
  mseResourceId?: string;
  mseGatewayUrl?: string;
  mseGatewayUrlType?: string;
  mseStatus?: string;
  registrationStatus: "local" | "creating" | "ready" | "failed" | "revoked";
  status: "ready" | "revoked";
  createdAt: string;
  updatedAt: string;
}

export class CustomMcpResourceStore {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
    this.database.exec(`
      create table if not exists custom_mcp_resources (
        resource_id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        owner_id text not null,
        display_name text not null,
        upstream_url text not null,
        protocol text not null check (protocol in ('http', 'sse', 'streamable_http')),
        credential_provider_name text,
        credential_provider_type text check (credential_provider_type in ('api_key', 'oauth2')),
        ingress_auth text not null check (ingress_auth in ('api_key', 'oauth2')),
        ingress_api_key_hashes_json text not null default '[]',
        required_oauth_scopes_json text not null default '[]',
        allowed_oauth_client_ids_json text not null default '[]',
        oauth_identity_claims_json text not null default '["sub"]',
        allowed_subjects_json text not null default '[]',
        allowed_groups_json text not null default '[]',
        allowed_agent_ids_json text not null default '[]',
        visibility text not null check (visibility in ('personal', 'team', 'partial')),
        allow_private_network integer not null default 0,
        forward_authorization integer not null default 0,
        forward_tip_token integer not null default 1,
        mse_resource_id text,
        mse_gateway_url text,
        mse_gateway_url_type text,
        mse_status text,
        registration_status text not null default 'local',
        status text not null default 'ready' check (status in ('ready', 'revoked')),
        created_at text not null,
        updated_at text not null,
        unique (tenant_id, workspace_id, display_name)
      );
      create index if not exists idx_custom_mcp_resources_scope
        on custom_mcp_resources (tenant_id, workspace_id, status);
    `);
    const columns = this.database.prepare("pragma table_info(custom_mcp_resources)").all() as Array<{ name?: unknown }>;
    if (!columns.some((column) => column.name === "allow_private_network")) {
      this.database.exec(
        "alter table custom_mcp_resources add column allow_private_network integer not null default 0",
      );
    }
    if (!columns.some((column) => column.name === "forward_authorization")) {
      this.database.exec(
        "alter table custom_mcp_resources add column forward_authorization integer not null default 0",
      );
    }
  }

  save(input: {
    resourceId?: string;
    principal: TenantPrincipal;
    displayName: string;
    upstreamUrl: string;
    protocol: CustomMcpProtocol;
    credentialProviderName?: string;
    credentialProviderType?: "api_key" | "oauth2";
    ingressAuth: CustomMcpIngressAuth;
    ingressApiKeyHashes?: string[];
    requiredOAuthScopes?: string[];
    allowedOAuthClientIds?: string[];
    oauthIdentityClaims?: string[];
    allowedSubjects?: string[];
    allowedGroups?: string[];
    allowedAgentIds?: string[];
    visibility: CustomMcpVisibility;
    allowPrivateNetwork?: boolean;
    forwardAuthorization?: boolean;
    forwardTipToken?: boolean;
    mseResourceId?: string;
    mseGatewayUrl?: string;
    mseGatewayUrlType?: string;
    mseStatus?: string;
    registrationStatus?: CustomMcpResourceRecord["registrationStatus"];
  }): CustomMcpResourceRecord {
    const displayName = input.displayName.trim();
    const upstreamUrl = input.upstreamUrl.trim();
    if (!displayName || !upstreamUrl) throw new Error("displayName and upstreamUrl are required.");
    if (input.credentialProviderName && !input.credentialProviderType) {
      throw new Error("credentialProviderType is required with credentialProviderName.");
    }
    const resourceId = input.resourceId?.trim() || crypto.randomUUID();
    if (this.getAnyById(resourceId)) throw new Error("A custom MCP resource with this resourceId already exists.");
    const now = new Date().toISOString();
    this.database
      .prepare(`
      insert into custom_mcp_resources (
        resource_id, tenant_id, workspace_id, owner_id, display_name, upstream_url, protocol,
        credential_provider_name, credential_provider_type, ingress_auth,
        ingress_api_key_hashes_json, required_oauth_scopes_json, allowed_oauth_client_ids_json,
        oauth_identity_claims_json, allowed_subjects_json, allowed_groups_json, allowed_agent_ids_json,
        visibility, allow_private_network, forward_authorization, forward_tip_token, mse_resource_id, mse_gateway_url,
        mse_gateway_url_type, mse_status, registration_status, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        resourceId,
        input.principal.tenantId,
        input.principal.workspaceId,
        input.principal.ownerId,
        displayName,
        upstreamUrl,
        input.protocol,
        input.credentialProviderName?.trim() || null,
        input.credentialProviderType ?? null,
        input.ingressAuth,
        JSON.stringify(unique(input.ingressApiKeyHashes ?? [])),
        JSON.stringify(unique(input.requiredOAuthScopes ?? [])),
        JSON.stringify(unique(input.allowedOAuthClientIds ?? [])),
        JSON.stringify(unique(input.oauthIdentityClaims ?? ["sub"])),
        JSON.stringify(unique(input.allowedSubjects ?? [])),
        JSON.stringify(unique(input.allowedGroups ?? [])),
        JSON.stringify(unique(input.allowedAgentIds ?? [])),
        input.visibility,
        input.allowPrivateNetwork === true ? 1 : 0,
        input.forwardAuthorization === true ? 1 : 0,
        input.forwardTipToken === false ? 0 : 1,
        input.mseResourceId?.trim() || null,
        input.mseGatewayUrl?.trim() || null,
        input.mseGatewayUrlType?.trim() || null,
        input.mseStatus?.trim() || null,
        input.registrationStatus ?? "local",
        now,
        now,
      );
    return this.getById(resourceId)!;
  }

  getById(resourceId: string): CustomMcpResourceRecord | undefined {
    const row = this.database
      .prepare(
        "select * from custom_mcp_resources where resource_id=? and status='ready' and registration_status in ('local', 'ready')",
      )
      .get(resourceId.trim()) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getByMseResourceId(resourceId: string): CustomMcpResourceRecord | undefined {
    const row = this.database
      .prepare(
        "select * from custom_mcp_resources where mse_resource_id=? and status='ready' and registration_status in ('local', 'ready')",
      )
      .get(resourceId.trim()) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getForPrincipal(resourceId: string, principal: TenantPrincipal): CustomMcpResourceRecord | undefined {
    const resource = this.getAny(resourceId, principal.tenantId, principal.workspaceId);
    if (!resource || resource.status !== "ready" || !["local", "ready"].includes(resource.registrationStatus))
      return undefined;
    if (
      resource.allowedAgentIds.length > 0 &&
      (!principal.agentId || !resource.allowedAgentIds.includes(principal.agentId))
    )
      return undefined;
    if (resource.ownerId === principal.ownerId) return resource;
    const subjects = new Set([principal.subject, principal.ownerId]);
    const groups = new Set([...(principal.groups ?? []), ...(principal.groupIds ?? [])]);
    const hasExplicitAcl = resource.allowedSubjects.length > 0 || resource.allowedGroups.length > 0;
    return resource.allowedSubjects.some((subject) => subjects.has(subject)) ||
      resource.allowedGroups.some((group) => groups.has(group)) ||
      (!hasExplicitAcl && resource.visibility === "team")
      ? resource
      : undefined;
  }

  getByName(displayName: string, principal: TenantPrincipal): CustomMcpResourceRecord | undefined {
    const row = this.database
      .prepare(
        "select * from custom_mcp_resources where tenant_id=? and workspace_id=? and display_name=? and status='ready'",
      )
      .get(principal.tenantId, principal.workspaceId, displayName.trim()) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  listForPrincipal(principal: TenantPrincipal): CustomMcpResourceRecord[] {
    return this.database
      .prepare(
        "select * from custom_mcp_resources where tenant_id=? and workspace_id=? and status='ready' and registration_status in ('local', 'ready') order by created_at",
      )
      .all(principal.tenantId, principal.workspaceId)
      .map((row) => rowToRecord(row as Record<string, unknown>))
      .filter((resource) => this.getForPrincipal(resource.resourceId, principal));
  }

  revoke(resourceId: string, principal: TenantPrincipal): boolean {
    const result = this.database
      .prepare(
        "update custom_mcp_resources set status='revoked', registration_status='revoked', updated_at=? where resource_id=? and tenant_id=? and workspace_id=? and owner_id=? and status='ready'",
      )
      .run(new Date().toISOString(), resourceId, principal.tenantId, principal.workspaceId, principal.ownerId);
    return Number(result.changes) === 1;
  }

  private getAny(resourceId: string, tenantId: string, workspaceId: string): CustomMcpResourceRecord | undefined {
    const row = this.database
      .prepare("select * from custom_mcp_resources where resource_id=? and tenant_id=? and workspace_id=?")
      .get(resourceId.trim(), tenantId, workspaceId) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  private getAnyById(resourceId: string): CustomMcpResourceRecord | undefined {
    const row = this.database
      .prepare("select * from custom_mcp_resources where resource_id=?")
      .get(resourceId.trim()) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }
}

function rowToRecord(row: Record<string, unknown>): CustomMcpResourceRecord {
  return {
    resourceId: String(row.resource_id),
    tenantId: String(row.tenant_id),
    workspaceId: String(row.workspace_id),
    ownerId: String(row.owner_id),
    displayName: String(row.display_name),
    upstreamUrl: String(row.upstream_url),
    protocol: String(row.protocol) as CustomMcpProtocol,
    credentialProviderName: optional(row.credential_provider_name),
    credentialProviderType: optional(row.credential_provider_type) as CustomMcpResourceRecord["credentialProviderType"],
    ingressAuth: String(row.ingress_auth) as CustomMcpIngressAuth,
    ingressApiKeyHashes: jsonStrings(row.ingress_api_key_hashes_json),
    requiredOAuthScopes: jsonStrings(row.required_oauth_scopes_json),
    allowedOAuthClientIds: jsonStrings(row.allowed_oauth_client_ids_json),
    oauthIdentityClaims: jsonStrings(row.oauth_identity_claims_json),
    allowedSubjects: jsonStrings(row.allowed_subjects_json),
    allowedGroups: jsonStrings(row.allowed_groups_json),
    allowedAgentIds: jsonStrings(row.allowed_agent_ids_json),
    visibility: String(row.visibility) as CustomMcpVisibility,
    allowPrivateNetwork: Number(row.allow_private_network) === 1,
    forwardAuthorization: Number(row.forward_authorization) === 1,
    forwardTipToken: Number(row.forward_tip_token) === 1,
    mseResourceId: optional(row.mse_resource_id),
    mseGatewayUrl: optional(row.mse_gateway_url),
    mseGatewayUrlType: optional(row.mse_gateway_url_type),
    mseStatus: optional(row.mse_status),
    registrationStatus: String(row.registration_status) as CustomMcpResourceRecord["registrationStatus"],
    status: String(row.status) as CustomMcpResourceRecord["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
function jsonStrings(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
