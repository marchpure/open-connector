import type { ResourceRef, TenantPrincipal } from "./types.ts";

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { TenantResourceStore } from "./resource-store.ts";

const principal: TenantPrincipal = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  subject: "user-a",
  ownerId: "user-a",
  audience: "knowledge-runtime",
};

describe("TenantResourceStore", () => {
  it("atomically appends only current tenant-scoped provider observations", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      create table tenant_connections (
        id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        service text not null,
        revision integer not null,
        status text not null
      );
      insert into tenant_connections values
        ('connection-a', 'tenant-a', 'workspace-a', 'tencent_docs', 2, 'ready'),
        ('connection-b', 'tenant-b', 'workspace-b', 'tencent_docs', 2, 'ready');
    `);
    const store = new TenantResourceStore(database, principal);
    const resource: ResourceRef = {
      sourceType: "tencent_docs",
      tenantId: "tenant-a",
      workspaceId: "workspace-a",
      connectionId: "connection-a",
      resourceId: "nested-doc",
      mimeType: "application/vnd.tencent-docs.doc",
    };

    expect(store.appendIfCurrent("connection-a", 2, "tencent_docs", [resource])).toBe(true);
    expect(
      store.authorize(
        "connection-a",
        "tencent_docs",
        "tencent_docs.get_doc_content",
        { fileID: "nested-doc" },
        { fileID: ["application/vnd.tencent-docs.doc"] },
      ),
    ).toEqual({ allowed: true });
    expect(
      store.authorize(
        "connection-a",
        "tencent_docs",
        "tencent_docs.get_doc_content",
        { fileID: "guessed-doc" },
        { fileID: ["application/vnd.tencent-docs.doc"] },
      ),
    ).toMatchObject({ allowed: false, code: "resource_not_discovered" });

    database.prepare("update tenant_connections set revision=3 where id='connection-a'").run();
    expect(store.appendIfCurrent("connection-a", 2, "tencent_docs", [{ ...resource, resourceId: "stale-doc" }])).toBe(
      false,
    );
    expect(
      store.appendIfCurrent("connection-b", 2, "tencent_docs", [
        { ...resource, connectionId: "connection-b", resourceId: "cross-tenant-doc" },
      ]),
    ).toBe(false);
    expect(
      database.prepare("select count(*) as count from connection_resources where resource_id <> 'nested-doc'").get(),
    ).toEqual({ count: 0 });
    database.close();
  });

  it("authorizes only the latest tenant-scoped discovery revision and resource kind", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      create table tenant_connections (
        id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        revision integer not null,
        status text not null
      );
      insert into tenant_connections values ('connection-a', 'tenant-a', 'workspace-a', 1, 'ready');
    `);
    const store = new TenantResourceStore(database, principal);
    const resource: ResourceRef = {
      sourceType: "feishu",
      tenantId: "tenant-a",
      workspaceId: "workspace-a",
      connectionId: "connection-a",
      resourceId: "doc-1",
      mimeType: "application/vnd.feishu.document",
    };
    store.replace("connection-a", 1, [resource]);

    expect(
      store.authorize("connection-a", "feishu", "feishu.get_document", { documentId: "doc-1" }, { documentId: [] }),
    ).toEqual({
      allowed: true,
    });
    expect(
      store.authorize(
        "connection-a",
        "feishu",
        "feishu.get_document",
        { documentId: "doc-1" },
        { documentId: ["application/vnd.feishu.other"] },
      ),
    ).toMatchObject({ allowed: false, code: "resource_not_discovered" });
    expect(
      store.authorize(
        "connection-a",
        "feishu",
        "feishu.get_document",
        { documentId: "doc-1" },
        { documentId: ["application/vnd.feishu.document"] },
      ),
    ).toEqual({
      allowed: true,
    });
    expect(
      store.authorize(
        "connection-a",
        "feishu",
        "feishu.get_document",
        { documentId: "doc-2" },
        { documentId: ["application/vnd.feishu.document"] },
      ),
    ).toMatchObject({
      allowed: false,
      code: "resource_not_discovered",
    });

    database.prepare("update tenant_connections set revision=2 where id='connection-a'").run();
    expect(
      store.authorize(
        "connection-a",
        "feishu",
        "feishu.get_document",
        { documentId: "doc-1" },
        { documentId: ["application/vnd.feishu.document"] },
      ),
    ).toMatchObject({
      allowed: false,
      code: "resource_not_discovered",
    });
    database.close();
  });

  it("does not authorize a resource from another tenant", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      create table tenant_connections (
        id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        revision integer not null,
        status text not null
      );
      insert into tenant_connections values ('connection-a', 'tenant-a', 'workspace-a', 1, 'ready');
    `);
    const store = new TenantResourceStore(database, { ...principal, tenantId: "tenant-b", workspaceId: "workspace-b" });
    expect(
      store.authorize("connection-a", "feishu", "feishu.get_document", { documentId: "doc-1" }, { documentId: [] }),
    ).toMatchObject({
      allowed: false,
      code: "resource_not_discovered",
    });
    database.close();
  });

  it("checks optional and array resource bindings without allowing guessed values", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      create table tenant_connections (
        id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        revision integer not null,
        status text not null
      );
      insert into tenant_connections values ('connection-a', 'tenant-a', 'workspace-a', 1, 'ready');
    `);
    const store = new TenantResourceStore(database, principal);
    const resources: ResourceRef[] = [
      {
        sourceType: "feishu",
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        connectionId: "connection-a",
        resourceId: "sheet-1",
      },
      {
        sourceType: "feishu",
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        connectionId: "connection-a",
        resourceId: "field-1",
        mimeType: "application/vnd.feishu.bitable.field",
      },
      {
        sourceType: "feishu",
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        connectionId: "connection-a",
        resourceId: "field-2",
        mimeType: "application/vnd.feishu.bitable.field",
      },
    ];
    store.replace("connection-a", 1, resources);

    expect(
      store.authorize(
        "connection-a",
        "feishu",
        "feishu.get_sheet",
        { spreadsheetToken: "sheet-1" },
        { required: { spreadsheetToken: [] }, optional: { sheetId: [] } },
      ),
    ).toEqual({ allowed: true });
    expect(
      store.authorize(
        "connection-a",
        "feishu",
        "feishu.get_sheet",
        { spreadsheetToken: "sheet-1", sheetId: "guessed-sheet" },
        { required: { spreadsheetToken: [] }, optional: { sheetId: [] } },
      ),
    ).toMatchObject({ allowed: false, code: "resource_not_discovered" });
    expect(
      store.authorize(
        "connection-a",
        "feishu",
        "feishu.get_fields",
        { fieldIds: ["field-1", "field-2"] },
        { required: { fieldIds: ["application/vnd.feishu.bitable.field"] } },
      ),
    ).toEqual({ allowed: true });
    database.close();
  });

  it("authorizes an explicitly supplied storage bucket only after discovery", () => {
    const database = new DatabaseSync(":memory:");
    const principal: TenantPrincipal = {
      tenantId: "tenant-a",
      workspaceId: "workspace-a",
      subject: "user-a",
      audience: "knowledge-runtime",
      ownerId: "user-a",
    };
    database.exec(`
      create table tenant_connections (
        id text primary key,
        tenant_id text not null,
        workspace_id text not null,
        owner_id text not null,
        service text not null,
        connection_name text not null,
        connector_definition_version text not null,
        credential_ref text not null,
        credential_ciphertext text not null,
        profile_json text not null,
        status text not null,
        revision integer not null,
        visibility text not null,
        created_at text not null,
        updated_at text not null
      );
    `);
    const store = new TenantResourceStore(database, principal);
    database.exec(`
      insert into tenant_connections
        (id, tenant_id, workspace_id, owner_id, service, connection_name,
         connector_definition_version, credential_ref, status, revision, visibility,
         credential_ciphertext, profile_json, created_at, updated_at)
      values ('connection-a', 'tenant-a', 'workspace-a', 'user-a', 'aws_s3', 'S3',
              '1.0.0', 'credential', 'ready', 1, 'personal', 'ciphertext', '{}',
              datetime('now'), datetime('now'))
    `);
    store.replace("connection-a", 1, [
      {
        sourceType: "aws_s3",
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        connectionId: "connection-a",
        resourceId: "documents",
        mimeType: "application/vnd.aws.s3.bucket",
      },
    ]);

    expect(
      store.authorize(
        "connection-a",
        "aws_s3",
        "aws_s3.head_object",
        { bucket: "documents" },
        {
          optional: { bucket: ["application/vnd.aws.s3.bucket"] },
        },
      ),
    ).toEqual({ allowed: true });
    expect(
      store.authorize(
        "connection-a",
        "aws_s3",
        "aws_s3.head_object",
        { bucket: "guessed" },
        {
          optional: { bucket: ["application/vnd.aws.s3.bucket"] },
        },
      ),
    ).toMatchObject({ allowed: false, code: "resource_not_discovered" });
    expect(
      store.authorize(
        "connection-a",
        "aws_s3",
        "aws_s3.head_object",
        {},
        {
          optional: { bucket: ["application/vnd.aws.s3.bucket"] },
        },
      ),
    ).toEqual({ allowed: true });
    database.close();
  });
});
