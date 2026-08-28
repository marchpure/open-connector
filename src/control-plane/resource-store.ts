import type { PolicyErrorCode } from "../core/action-policy.ts";
import type { ResourceAuthorization } from "../server/actions/action-runner.ts";
import type { ResourceRef, TenantPrincipal } from "./types.ts";
import type { DatabaseSync } from "node:sqlite";

/**
 * Persists the latest visibility-aware discovery result for one connection.
 * Runtime authorization is intentionally exact-match and revision-bound.
 */
export class TenantResourceStore implements ResourceAuthorization {
  private readonly database: DatabaseSync;
  private readonly principal: TenantPrincipal;

  constructor(database: DatabaseSync, principal: TenantPrincipal) {
    this.database = database;
    this.principal = principal;
    this.database.exec(`
      create table if not exists connection_resources (
        tenant_id text not null,
        workspace_id text not null,
        connection_id text not null,
        connection_revision integer not null,
        source_type text not null,
        resource_id text not null,
        resource_token text,
        resource_json text not null,
        discovered_at text not null,
        primary key (tenant_id, workspace_id, connection_id, connection_revision, source_type, resource_id)
      );
      create index if not exists idx_connection_resources_lookup
        on connection_resources (tenant_id, workspace_id, connection_id, connection_revision, resource_token);
    `);
  }

  replace(connectionId: string, connectionRevision: number, resources: ResourceRef[]): void {
    this.database.exec("begin immediate");
    try {
      this.database
        .prepare("delete from connection_resources where tenant_id=? and workspace_id=? and connection_id=?")
        .run(this.principal.tenantId, this.principal.workspaceId, connectionId);
      const insert = this.database.prepare(
        `insert into connection_resources
          (tenant_id, workspace_id, connection_id, connection_revision, source_type,
           resource_id, resource_token, resource_json, discovered_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const discoveredAt = new Date().toISOString();
      for (const resource of resources) {
        insert.run(
          this.principal.tenantId,
          this.principal.workspaceId,
          connectionId,
          connectionRevision,
          resource.sourceType,
          resource.resourceId,
          resource.resourceToken ?? null,
          JSON.stringify(resource),
          discoveredAt,
        );
      }
      this.database.exec("commit");
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  /**
   * Append provider-observed resources only while the exact connection
   * revision is still active and tenant-visible.
   */
  appendIfCurrent(
    connectionId: string,
    connectionRevision: number,
    service: string,
    resources: ResourceRef[],
  ): boolean {
    this.database.exec("begin immediate");
    try {
      const connection = this.database
        .prepare(
          `select revision from tenant_connections
            where id=? and tenant_id=? and workspace_id=? and service=? and status <> 'revoked'`,
        )
        .get(connectionId, this.principal.tenantId, this.principal.workspaceId, service) as
        | Record<string, unknown>
        | undefined;
      if (Number(connection?.revision) !== connectionRevision) {
        this.database.exec("rollback");
        return false;
      }

      const insert = this.database.prepare(
        `insert into connection_resources
          (tenant_id, workspace_id, connection_id, connection_revision, source_type,
           resource_id, resource_token, resource_json, discovered_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (tenant_id, workspace_id, connection_id, connection_revision, source_type, resource_id)
         do update set resource_token=excluded.resource_token,
                       resource_json=excluded.resource_json,
                       discovered_at=excluded.discovered_at`,
      );
      const discoveredAt = new Date().toISOString();
      for (const resource of resources.slice(0, 100)) {
        if (
          resource.tenantId !== this.principal.tenantId ||
          resource.workspaceId !== this.principal.workspaceId ||
          resource.connectionId !== connectionId ||
          resource.sourceType !== service ||
          !resource.resourceId.trim()
        ) {
          continue;
        }
        insert.run(
          this.principal.tenantId,
          this.principal.workspaceId,
          connectionId,
          connectionRevision,
          resource.sourceType,
          resource.resourceId,
          resource.resourceToken ?? null,
          JSON.stringify(resource),
          discoveredAt,
        );
      }
      this.database.exec("commit");
      return true;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  authorize(
    connectionId: string,
    service: string,
    _actionId: string,
    input: unknown,
    bindings:
      | {
          required?: Record<string, readonly string[]>;
          optional?: Record<string, readonly string[]>;
        }
      | Record<string, readonly string[]>,
  ): { allowed: true } | { allowed: false; code: PolicyErrorCode; message: string } {
    const record =
      input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const connection = this.database
      .prepare(
        `select revision from tenant_connections
          where id=? and tenant_id=? and workspace_id=? and status <> 'revoked'`,
      )
      .get(connectionId, this.principal.tenantId, this.principal.workspaceId) as Record<string, unknown> | undefined;
    const revision = Number(connection?.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      return denied();
    }

    const normalized: {
      required: Record<string, readonly string[]>;
      optional: Record<string, readonly string[]>;
    } =
      Object.hasOwn(bindings, "required") || Object.hasOwn(bindings, "optional")
        ? (() => {
            const structured = bindings as {
              required?: Record<string, readonly string[]>;
              optional?: Record<string, readonly string[]>;
            };
            return {
              required: structured.required ?? {},
              optional: structured.optional ?? {},
            };
          })()
        : { required: bindings as Record<string, readonly string[]>, optional: {} };
    for (const [field, kinds] of Object.entries(normalized.required ?? {})) {
      if (!authorizeField(record[field], field, kinds, this, connectionId, revision, service)) return denied();
    }
    for (const [field, kinds] of Object.entries(normalized.optional ?? {})) {
      if (record[field] === undefined || record[field] === null || record[field] === "") continue;
      if (!authorizeField(record[field], field, kinds, this, connectionId, revision, service)) return denied();
    }
    return { allowed: true };
  }

  lookup(connectionId: string, revision: number, service: string, value: string): ResourceRef | undefined {
    const resource = this.database
      .prepare(
        `select resource_json from connection_resources
          where tenant_id=? and workspace_id=? and connection_id=? and connection_revision=?
            and source_type=? and (resource_id=? or resource_token=?)
          limit 1`,
      )
      .get(this.principal.tenantId, this.principal.workspaceId, connectionId, revision, service, value, value) as
      | Record<string, unknown>
      | undefined;
    return resource?.resource_json ? (JSON.parse(String(resource.resource_json)) as ResourceRef) : undefined;
  }
}

function authorizeField(
  rawValue: unknown,
  field: string,
  kinds: readonly string[],
  store: TenantResourceStore,
  connectionId: string,
  revision: number,
  service: string,
): boolean {
  const values =
    typeof rawValue === "string"
      ? [rawValue.trim()]
      : Array.isArray(rawValue) && rawValue.every((value) => typeof value === "string")
        ? rawValue.map((value) => value.trim())
        : [];
  if (values.length === 0 || values.some((value) => !value)) return false;
  return values.every((value) => {
    const resource = store.lookup(connectionId, revision, service, value);
    if (!resource) return false;
    return kinds.length === 0 || (resource.mimeType !== undefined && kinds.includes(resource.mimeType));
  });
}

function denied(): { allowed: false; code: PolicyErrorCode; message: string } {
  return {
    allowed: false,
    code: "resource_not_discovered",
    message: "The requested resource is not present in the latest connection discovery result.",
  };
}
