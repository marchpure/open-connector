import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ConnectionJobStore } from "./job-store.ts";

describe("ConnectionJobStore", () => {
  it("persists tenant-scoped validate and discover results across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "connection-jobs-"));
    const path = join(root, "control.sqlite");
    try {
      const firstDatabase = new DatabaseSync(path);
      const first = new ConnectionJobStore(firstDatabase, {
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
      });
      const job = first.create("connection-1", "validate");
      first.start(job.id);
      first.succeed(job.id, { validated: true });
      firstDatabase.close();

      const secondDatabase = new DatabaseSync(path);
      const second = new ConnectionJobStore(secondDatabase, {
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
      });
      expect(second.get(job.id)).toMatchObject({
        id: job.id,
        connectionId: "connection-1",
        kind: "validate",
        status: "succeeded",
        result: { validated: true },
      });
      const otherTenant = new ConnectionJobStore(secondDatabase, {
        tenantId: "tenant-b",
        workspaceId: "workspace-b",
      });
      expect(otherTenant.get(job.id)).toBeUndefined();
      secondDatabase.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks interrupted running jobs failed when the service recovers", () => {
    const database = new DatabaseSync(":memory:");
    const jobs = new ConnectionJobStore(database, {
      tenantId: "tenant-a",
      workspaceId: "workspace-a",
    });
    const job = jobs.create("connection-1", "discover");
    jobs.start(job.id);

    expect(jobs.recoverInterrupted()).toBe(1);
    expect(jobs.get(job.id)).toMatchObject({
      status: "failed",
      error: { code: "worker_interrupted" },
    });
    database.close();
  });
});
