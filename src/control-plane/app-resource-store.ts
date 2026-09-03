import type { TenantPrincipal } from "./types.ts";
import type { DatabaseSync } from "node:sqlite";

export interface AppResourceRecord {
  resourceId: string;
  tenantId: string;
  workspaceId: string;
  ownerId: string;
  displayName: string;
  connectionId: string;
  allowedActions: string[];
  allowedResources?: { schemas?: string[]; tables?: string[] };
  allowedSubjects: string[];
  allowedGroups: string[];
  allowedAgentIds: string[];
  credentialRef?: string;
  ingressApiKeyHashes: string[];
  requiredOAuthScopes: string[];
  allowedOAuthClientIds: string[];
  oauthIdentityClaims: string[];
  ingressAuth: "api_key" | "oauth2";
  visibility: "personal" | "team";
  status: "ready" | "revoked";
  mseResourceId?: string;
  mseGatewayUrl?: string;
  mseGatewayUrlType?: string;
  mseStatus?: string;
  registrationStatus: "local" | "ready" | "failed" | "revoked";
  credentialProviderNames: string[];
  createdAt: string;
  updatedAt: string;
}

export class AppResourceStore {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
    this.database.exec(`
      create table if not exists app_resources (
        resource_id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        owner_id text not null,
        display_name text not null,
        connection_id text not null,
        allowed_actions_json text not null,
        allowed_resources_json text,
        allowed_subjects_json text not null,
        allowed_groups_json text not null,
        allowed_agent_ids_json text not null default '[]',
        credential_ref text,
        ingress_api_key_hashes_json text not null default '[]',
        required_oauth_scopes_json text not null default '[]',
        allowed_oauth_client_ids_json text not null default '[]',
        oauth_identity_claims_json text not null default '["sub"]',
        ingress_auth text not null default 'api_key' check (ingress_auth in ('api_key', 'oauth2')),
        visibility text not null check (visibility in ('personal', 'team')),
        status text not null check (status in ('ready', 'revoked')),
        mse_resource_id text,
        mse_gateway_url text,
        mse_gateway_url_type text,
        mse_status text,
        registration_status text not null default 'local',
        credential_provider_names_json text not null default '[]',
        created_at text not null,
        updated_at text not null,
        unique (tenant_id, workspace_id, display_name)
      );
      create index if not exists idx_app_resources_scope
        on app_resources (tenant_id, workspace_id, status);
    `);
    const columns = this.database.prepare("pragma table_info(app_resources)").all() as Array<{ name?: unknown }>;
    if (!columns.some((column) => column.name === "credential_ref")) {
      this.database.exec("alter table app_resources add column credential_ref text");
    }
    if (!columns.some((column) => column.name === "ingress_auth")) {
      this.database.exec("alter table app_resources add column ingress_auth text not null default 'api_key'");
    }
    if (!columns.some((column) => column.name === "required_oauth_scopes_json")) {
      this.database.exec("alter table app_resources add column required_oauth_scopes_json text not null default '[]'");
    }
    if (!columns.some((column) => column.name === "allowed_agent_ids_json")) {
      this.database.exec("alter table app_resources add column allowed_agent_ids_json text not null default '[]'");
    }
    if (!columns.some((column) => column.name === "ingress_api_key_hashes_json")) {
      this.database.exec("alter table app_resources add column ingress_api_key_hashes_json text not null default '[]'");
    }
    if (!columns.some((column) => column.name === "allowed_oauth_client_ids_json")) {
      this.database.exec(
        "alter table app_resources add column allowed_oauth_client_ids_json text not null default '[]'",
      );
    }
    if (!columns.some((column) => column.name === "oauth_identity_claims_json")) {
      this.database.exec(
        `alter table app_resources add column oauth_identity_claims_json text not null default '["sub"]'`,
      );
    }
    for (const [name, definition] of [
      ["mse_resource_id", "text"],
      ["mse_gateway_url", "text"],
      ["mse_gateway_url_type", "text"],
      ["mse_status", "text"],
      ["registration_status", "text not null default 'local'"],
      ["credential_provider_names_json", "text not null default '[]'"],
    ] as const) {
      if (!columns.some((column) => column.name === name))
        this.database.exec(`alter table app_resources add column ${name} ${definition}`);
    }
  }

  save(input: {
    resourceId?: string;
    principal: TenantPrincipal;
    displayName: string;
    connectionId: string;
    allowedActions: string[];
    allowedResources?: { schemas?: string[]; tables?: string[] };
    allowedSubjects?: string[];
    allowedGroups?: string[];
    allowedAgentIds?: string[];
    visibility?: "personal" | "team";
    credentialRef?: string;
    ingressApiKeyHashes?: string[];
    requiredOAuthScopes?: string[];
    allowedOAuthClientIds?: string[];
    oauthIdentityClaims?: string[];
    ingressAuth?: "api_key" | "oauth2";
    mseResourceId?: string;
    mseGatewayUrl?: string;
    mseGatewayUrlType?: string;
    mseStatus?: string;
    registrationStatus?: AppResourceRecord["registrationStatus"];
    credentialProviderNames?: string[];
  }): AppResourceRecord {
    const displayName = input.displayName.trim();
    if (!displayName || !input.connectionId.trim() || input.allowedActions.length === 0) {
      throw new Error("displayName, connectionId, and allowedActions are required.");
    }
    const resourceId = input.resourceId?.trim() || crypto.randomUUID();
    const now = new Date().toISOString();
    if (this.getAnyByResourceId(resourceId)) throw new Error("An app resource with this resourceId already exists.");
    this.database
      .prepare(
        `insert into app_resources
          (resource_id, tenant_id, workspace_id, owner_id, display_name, connection_id,
           allowed_actions_json, allowed_resources_json, allowed_subjects_json, allowed_groups_json,
           allowed_agent_ids_json, credential_ref, ingress_api_key_hashes_json, required_oauth_scopes_json,
           allowed_oauth_client_ids_json, oauth_identity_claims_json, ingress_auth,
           visibility, status, mse_resource_id, mse_gateway_url, mse_gateway_url_type, mse_status,
           registration_status, credential_provider_names_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        resourceId,
        input.principal.tenantId,
        input.principal.workspaceId,
        input.principal.ownerId,
        displayName,
        input.connectionId.trim(),
        JSON.stringify(unique(input.allowedActions)),
        input.allowedResources ? JSON.stringify(input.allowedResources) : null,
        JSON.stringify(unique(input.allowedSubjects ?? [])),
        JSON.stringify(unique(input.allowedGroups ?? [])),
        JSON.stringify(unique(input.allowedAgentIds ?? [])),
        input.credentialRef?.trim() || null,
        JSON.stringify(validHashes(input.ingressApiKeyHashes ?? [])),
        JSON.stringify(unique(input.requiredOAuthScopes ?? [])),
        JSON.stringify(unique(input.allowedOAuthClientIds ?? [])),
        JSON.stringify(unique(input.oauthIdentityClaims ?? ["sub"])),
        input.ingressAuth ?? "api_key",
        input.visibility ?? "personal",
        input.mseResourceId?.trim() || null,
        input.mseGatewayUrl?.trim() || null,
        input.mseGatewayUrlType?.trim() || null,
        input.mseStatus?.trim() || null,
        input.registrationStatus ?? "local",
        JSON.stringify(unique(input.credentialProviderNames ?? [])),
        now,
        now,
      );
    return this.getAny(resourceId, input.principal.tenantId, input.principal.workspaceId)!;
  }

  getForPrincipal(resourceId: string, principal: TenantPrincipal): AppResourceRecord | undefined {
    const resource = this.getAny(resourceId, principal.tenantId, principal.workspaceId);
    if (!resource || resource.status !== "ready" || !["local", "ready"].includes(resource.registrationStatus))
      return undefined;
    if (
      resource.allowedAgentIds.length > 0 &&
      (!principal.agentId || !resource.allowedAgentIds.includes(principal.agentId))
    ) {
      return undefined;
    }
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

  getById(resourceId: string): AppResourceRecord | undefined {
    const row = this.database
      .prepare(
        "select * from app_resources where resource_id=? and status='ready' and registration_status in ('local', 'ready')",
      )
      .get(resourceId) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getByMseResourceId(resourceId: string): AppResourceRecord | undefined {
    const row = this.database
      .prepare(
        "select * from app_resources where mse_resource_id=? and status='ready' and registration_status in ('local', 'ready')",
      )
      .get(resourceId.trim()) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getAnyForTenant(resourceId: string, principal: TenantPrincipal): AppResourceRecord | undefined {
    return this.getAny(resourceId, principal.tenantId, principal.workspaceId);
  }

  hasResourceId(resourceId: string): boolean {
    return this.getAnyByResourceId(resourceId) !== undefined;
  }

  getByName(displayName: string, principal: TenantPrincipal): AppResourceRecord | undefined {
    const row = this.database
      .prepare("select * from app_resources where tenant_id=? and workspace_id=? and display_name=?")
      .get(principal.tenantId, principal.workspaceId, displayName.trim()) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  listForPrincipal(principal: TenantPrincipal): AppResourceRecord[] {
    return this.database
      .prepare(
        `select * from app_resources
          where tenant_id=? and workspace_id=? and status='ready' and registration_status in ('local', 'ready')
          order by created_at`,
      )
      .all(principal.tenantId, principal.workspaceId)
      .map((row) => rowToRecord(row as Record<string, unknown>))
      .filter((resource) => this.getForPrincipal(resource.resourceId, principal) !== undefined);
  }

  revoke(resourceId: string, principal: TenantPrincipal): boolean {
    const result = this.database
      .prepare(
        `update app_resources set status='revoked', updated_at=?
          where resource_id=? and tenant_id=? and workspace_id=? and owner_id=? and status='ready'`,
      )
      .run(new Date().toISOString(), resourceId, principal.tenantId, principal.workspaceId, principal.ownerId);
    return Number(result.changes) === 1;
  }

  revokeByConnection(connectionId: string, principal: TenantPrincipal): number {
    const result = this.database
      .prepare(
        `update app_resources set status='revoked', updated_at=?
          where connection_id=? and tenant_id=? and workspace_id=? and owner_id=? and status='ready'`,
      )
      .run(new Date().toISOString(), connectionId, principal.tenantId, principal.workspaceId, principal.ownerId);
    return Number(result.changes);
  }

  private getAny(resourceId: string, tenantId: string, workspaceId: string): AppResourceRecord | undefined {
    const row = this.database
      .prepare("select * from app_resources where resource_id=? and tenant_id=? and workspace_id=?")
      .get(resourceId, tenantId, workspaceId) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  private getAnyByResourceId(resourceId: string): AppResourceRecord | undefined {
    const row = this.database.prepare("select * from app_resources where resource_id=?").get(resourceId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRecord(row) : undefined;
  }
}

function rowToRecord(row: Record<string, unknown>): AppResourceRecord {
  return {
    resourceId: String(row.resource_id),
    tenantId: String(row.tenant_id),
    workspaceId: String(row.workspace_id),
    ownerId: String(row.owner_id),
    displayName: String(row.display_name),
    connectionId: String(row.connection_id),
    allowedActions: jsonStringArray(row.allowed_actions_json),
    allowedResources: row.allowed_resources_json ? JSON.parse(String(row.allowed_resources_json)) : undefined,
    allowedSubjects: jsonStringArray(row.allowed_subjects_json),
    allowedGroups: jsonStringArray(row.allowed_groups_json),
    allowedAgentIds: jsonStringArray(row.allowed_agent_ids_json),
    credentialRef: typeof row.credential_ref === "string" && row.credential_ref ? row.credential_ref : undefined,
    mseResourceId: typeof row.mse_resource_id === "string" && row.mse_resource_id ? row.mse_resource_id : undefined,
    mseGatewayUrl: typeof row.mse_gateway_url === "string" && row.mse_gateway_url ? row.mse_gateway_url : undefined,
    mseGatewayUrlType:
      typeof row.mse_gateway_url_type === "string" && row.mse_gateway_url_type ? row.mse_gateway_url_type : undefined,
    mseStatus: typeof row.mse_status === "string" && row.mse_status ? row.mse_status : undefined,
    registrationStatus: String(row.registration_status ?? "local") as AppResourceRecord["registrationStatus"],
    credentialProviderNames: jsonStringArray(row.credential_provider_names_json),
    ingressApiKeyHashes: jsonStringArray(row.ingress_api_key_hashes_json),
    requiredOAuthScopes: jsonStringArray(row.required_oauth_scopes_json),
    allowedOAuthClientIds: jsonStringArray(row.allowed_oauth_client_ids_json),
    oauthIdentityClaims: jsonStringArray(row.oauth_identity_claims_json),
    ingressAuth: String(row.ingress_auth ?? "api_key") as AppResourceRecord["ingressAuth"],
    visibility: String(row.visibility) as AppResourceRecord["visibility"],
    status: String(row.status) as AppResourceRecord["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function jsonStringArray(value: unknown): string[] {
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

function validHashes(values: string[]): string[] {
  const hashes = unique(values).map((value) => value.toLowerCase());
  if (hashes.some((value) => !/^[a-f0-9]{64}$/u.test(value))) {
    throw new Error("Ingress API key hashes must be lowercase SHA-256 hex values.");
  }
  return hashes;
}
