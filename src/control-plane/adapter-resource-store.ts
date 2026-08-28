import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { DatabaseSync } from "node:sqlite";

import { randomUUID } from "node:crypto";
import { redactSecrets } from "./redaction.ts";
import type { TenantPrincipal } from "./types.ts";

export type AdapterResourceKind = "oracle_database" | "rest_openapi" | "mcp" | "files";
export type AdapterResourceStatus = "ready" | "revoked";

export interface AdapterResourceMetadata {
  [key: string]: unknown;
}

export interface AdapterResourcePublic {
  resourceId: string;
  kind: AdapterResourceKind;
  displayName: string;
  status: AdapterResourceStatus;
  tier: "beta";
  sourceType: "adapter";
  metadata: AdapterResourceMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface AdapterResourceRecord extends AdapterResourcePublic {
  tenantId: string;
  workspaceId: string;
  ownerId: string;
  visibility: "personal" | "team";
  sourceId: string;
  definition: Record<string, unknown>;
}

export class TenantAdapterResourceStore {
  private readonly database: DatabaseSync;
  private readonly principal: TenantPrincipal;
  private readonly secretCodec: ISecretCodec;

  constructor(database: DatabaseSync, principal: TenantPrincipal, secretCodec: ISecretCodec) {
    this.database = database;
    this.principal = principal;
    this.secretCodec = secretCodec;
    this.database.exec(`
      create table if not exists tenant_adapter_resources (
        resource_id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        owner_id text not null,
        kind text not null,
        display_name text not null,
        visibility text not null,
        source_id text not null,
        metadata_json text not null,
        definition_ciphertext text not null,
        status text not null,
        created_at text not null,
        updated_at text not null,
        unique (tenant_id, workspace_id, kind, source_id)
      );
      create index if not exists idx_tenant_adapter_resources_scope
        on tenant_adapter_resources (tenant_id, workspace_id, created_at);
    `);
  }

  async save(input: {
    kind: AdapterResourceKind;
    displayName: string;
    visibility: "personal" | "team";
    sourceId: string;
    metadata?: AdapterResourceMetadata;
    definition?: Record<string, unknown>;
  }): Promise<AdapterResourcePublic> {
    const displayName = input.displayName.trim();
    const sourceId = input.sourceId.trim();
    if (!displayName || !sourceId) throw new Error("displayName and sourceId are required.");
    const now = new Date().toISOString();
    const metadata = redactSecrets(input.metadata ?? {}) as AdapterResourceMetadata;
    const definition = input.definition ?? {};
    const encrypted = await this.secretCodec.encode(JSON.stringify(definition));
    const existing = this.database
      .prepare(
        `select resource_id, created_at from tenant_adapter_resources
         where tenant_id=? and workspace_id=? and kind=? and source_id=?`,
      )
      .get(this.principal.tenantId, this.principal.workspaceId, input.kind, sourceId) as
      | { resource_id?: unknown; created_at?: unknown }
      | undefined;
    const resourceId = String(existing?.resource_id ?? randomUUID());
    const createdAt = String(existing?.created_at ?? now);
    this.database
      .prepare(
        `insert into tenant_adapter_resources
          (resource_id, tenant_id, workspace_id, owner_id, kind, display_name,
           visibility, source_id, metadata_json, definition_ciphertext, status,
           created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
         on conflict(tenant_id, workspace_id, kind, source_id) do update set
           owner_id=excluded.owner_id, display_name=excluded.display_name,
           visibility=excluded.visibility, metadata_json=excluded.metadata_json,
           definition_ciphertext=excluded.definition_ciphertext,
           status='ready', updated_at=excluded.updated_at`,
      )
      .run(
        resourceId,
        this.principal.tenantId,
        this.principal.workspaceId,
        this.principal.ownerId,
        input.kind,
        displayName,
        input.visibility,
        sourceId,
        JSON.stringify(metadata),
        encrypted,
        createdAt,
        now,
      );
    return {
      resourceId,
      kind: input.kind,
      displayName,
      status: "ready",
      tier: "beta",
      sourceType: "adapter",
      metadata,
      createdAt,
      updatedAt: now,
    };
  }

  list(): AdapterResourcePublic[] {
    const rows = this.database
      .prepare(
        `select * from tenant_adapter_resources
         where tenant_id=? and workspace_id=? and status <> 'revoked'
           and (owner_id=? or visibility='team')
         order by created_at`,
      )
      .all(
        this.principal.tenantId,
        this.principal.workspaceId,
        this.principal.ownerId,
      ) as Record<string, unknown>[];
    return rows.map(rowToPublic);
  }

  async get(resourceId: string): Promise<AdapterResourceRecord | undefined> {
    const row = this.database
      .prepare(
        `select * from tenant_adapter_resources
         where resource_id=? and tenant_id=? and workspace_id=?
           and status <> 'revoked' and (owner_id=? or visibility='team')`,
      )
      .get(
        resourceId,
        this.principal.tenantId,
        this.principal.workspaceId,
        this.principal.ownerId,
      ) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      ...rowToPublic(row),
      tenantId: this.principal.tenantId,
      workspaceId: this.principal.workspaceId,
      ownerId: String(row.owner_id),
      visibility: String(row.visibility) as "personal" | "team",
      sourceId: String(row.source_id),
      definition: JSON.parse(await this.secretCodec.decode(String(row.definition_ciphertext))) as Record<string, unknown>,
    };
  }
}

function rowToPublic(row: Record<string, unknown>): AdapterResourcePublic {
  const metadata = JSON.parse(String(row.metadata_json)) as AdapterResourceMetadata;
  delete metadata.fileId;
  delete metadata.downloadUrl;
  delete metadata.tenantId;
  delete metadata.workspaceId;
  return {
    resourceId: String(row.resource_id),
    kind: String(row.kind) as AdapterResourceKind,
    displayName: String(row.display_name),
    status: String(row.status) as AdapterResourceStatus,
    tier: "beta",
    sourceType: "adapter",
    metadata,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
