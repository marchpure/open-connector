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
});
