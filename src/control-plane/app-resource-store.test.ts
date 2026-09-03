import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AppResourceStore } from "./app-resource-store.ts";

const owner = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  subject: "owner-subject",
  ownerId: "owner",
  audience: "asi",
};

describe("AppResourceStore", () => {
  it("authorizes an explicit TIP userpool group and rejects another tenant", () => {
    const database = new DatabaseSync(":memory:");
    const store = new AppResourceStore(database);
    const resource = store.save({
      resourceId: "oracle-app",
      principal: owner,
      displayName: "Oracle",
      connectionId: "connection-a",
      allowedActions: ["oracle_database.list_tables"],
      allowedGroups: ["oracle-readers"],
    });
    expect(
      store.getForPrincipal(resource.resourceId, {
        ...owner,
        subject: "reader-subject",
        ownerId: "reader",
        groups: ["oracle-readers"],
      }),
    ).toMatchObject({ connectionId: "connection-a" });
    expect(
      store.getForPrincipal(resource.resourceId, {
        ...owner,
        tenantId: "tenant-b",
        workspaceId: "workspace-b",
        ownerId: "reader",
        groups: ["oracle-readers"],
      }),
    ).toBeUndefined();
    expect(
      store.getForPrincipal(resource.resourceId, { ...owner, ownerId: "reader", groups: ["other"] }),
    ).toBeUndefined();
    database.close();
  });

  it("does not allow an existing resource id or name to be silently replaced", () => {
    const database = new DatabaseSync(":memory:");
    const store = new AppResourceStore(database);
    const resource = store.save({
      resourceId: "oracle-app",
      principal: owner,
      displayName: "Oracle",
      connectionId: "connection-a",
      allowedActions: ["oracle_database.list_tables"],
    });
    expect(store.getAnyForTenant(resource.resourceId, owner)).toBeDefined();
    expect(store.getByName("Oracle", owner)).toMatchObject({ resourceId: "oracle-app" });
    expect(() =>
      store.save({
        resourceId: "oracle-app",
        principal: { ...owner, tenantId: "tenant-b", workspaceId: "workspace-b", ownerId: "attacker" },
        displayName: "Replacement",
        connectionId: "connection-b",
        allowedActions: ["oracle_database.list_tables"],
      }),
    ).toThrow("already exists");
    expect(store.getAnyForTenant("oracle-app", owner)).toMatchObject({
      displayName: "Oracle",
      connectionId: "connection-a",
    });
    database.close();
  });
});
