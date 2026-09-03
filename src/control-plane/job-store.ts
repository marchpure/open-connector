import type { DatabaseSync } from "node:sqlite";

import { randomUUID } from "node:crypto";
import { redactSecrets } from "./redaction.ts";

export type ConnectionJobKind = "validate" | "discover";
export type ConnectionJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface ConnectionJob {
  id: string;
  connectionId: string;
  kind: ConnectionJobKind;
  status: ConnectionJobStatus;
  result?: unknown;
  error?: { code: string; message: string; authorizationUrl?: string };
  createdAt: string;
  updatedAt: string;
}

export class ConnectionJobStore {
  private readonly database: DatabaseSync;
  private readonly scope: { tenantId: string; workspaceId: string };

  constructor(database: DatabaseSync, scope: { tenantId: string; workspaceId: string }) {
    this.database = database;
    this.scope = scope;
    this.database.exec(`
      create table if not exists connection_jobs (
        id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        connection_id text not null,
        kind text not null check (kind in ('validate', 'discover')),
        status text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
        result_json text,
        error_json text,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists idx_connection_jobs_scope
        on connection_jobs (tenant_id, workspace_id, connection_id, created_at);
    `);
  }

  create(connectionId: string, kind: ConnectionJobKind): ConnectionJob {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(
        `insert into connection_jobs
          (id, tenant_id, workspace_id, connection_id, kind, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(id, this.scope.tenantId, this.scope.workspaceId, connectionId, kind, now, now);
    return this.get(id)!;
  }

  start(id: string): boolean {
    return this.transition(id, "running");
  }

  succeed(id: string, result: unknown): boolean {
    const updated = this.database
      .prepare(
        `update connection_jobs set status='succeeded', result_json=?, error_json=null, updated_at=?
          where id=? and tenant_id=? and workspace_id=? and status='running'`,
      )
      .run(
        JSON.stringify(redactSecrets(result)),
        new Date().toISOString(),
        id,
        this.scope.tenantId,
        this.scope.workspaceId,
      );
    return Number(updated.changes) === 1;
  }

  fail(id: string, error: { code: string; message: string; authorizationUrl?: string }): boolean {
    const updated = this.database
      .prepare(
        `update connection_jobs set status='failed', error_json=?, updated_at=?
          where id=? and tenant_id=? and workspace_id=? and status in ('queued', 'running')`,
      )
      .run(
        JSON.stringify(redactJobError(error)),
        new Date().toISOString(),
        id,
        this.scope.tenantId,
        this.scope.workspaceId,
      );
    return Number(updated.changes) === 1;
  }

  get(id: string): ConnectionJob | undefined {
    const row = this.database
      .prepare("select * from connection_jobs where id=? and tenant_id=? and workspace_id=?")
      .get(id, this.scope.tenantId, this.scope.workspaceId) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : undefined;
  }

  recoverInterrupted(): number {
    const now = new Date().toISOString();
    const updated = this.database
      .prepare(
        `update connection_jobs
            set status='failed', error_json=?, updated_at=?
          where tenant_id=? and workspace_id=? and status='running'`,
      )
      .run(
        JSON.stringify({ code: "worker_interrupted", message: "Connection worker stopped before completion." }),
        now,
        this.scope.tenantId,
        this.scope.workspaceId,
      );
    return Number(updated.changes);
  }

  private transition(id: string, status: "running"): boolean {
    const updated = this.database
      .prepare(
        `update connection_jobs set status=?, updated_at=?
          where id=? and tenant_id=? and workspace_id=? and status='queued'`,
      )
      .run(status, new Date().toISOString(), id, this.scope.tenantId, this.scope.workspaceId);
    return Number(updated.changes) === 1;
  }
}

function redactJobError(error: { code: string; message: string; authorizationUrl?: string }) {
  const safe = redactSecrets(error) as Record<string, unknown>;
  if (error.code === "authorization_required" && typeof error.authorizationUrl === "string") {
    try {
      const url = new URL(error.authorizationUrl);
      if (url.protocol === "https:") safe.authorizationUrl = url.toString();
    } catch {
      // Invalid URLs remain redacted and cannot be used for authorization.
    }
  }
  return safe;
}

function rowToJob(row: Record<string, unknown>): ConnectionJob {
  return {
    id: String(row.id),
    connectionId: String(row.connection_id),
    kind: String(row.kind) as ConnectionJobKind,
    status: String(row.status) as ConnectionJobStatus,
    result: row.result_json ? JSON.parse(String(row.result_json)) : undefined,
    error: row.error_json ? (JSON.parse(String(row.error_json)) as ConnectionJob["error"]) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
