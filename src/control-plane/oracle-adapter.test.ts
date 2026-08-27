import { describe, expect, it, vi } from "vitest";
import { OracleDatabaseAdapter } from "./oracle-adapter.ts";

describe("OracleDatabaseAdapter", () => {
  it("requires service_name or SID and rejects writes", async () => {
    expect(() => new OracleDatabaseAdapter({ host: "db", port: 1521 }, { query: vi.fn() }, {
      maxRows: 10, maxBytes: 1024, timeoutMs: 100, maxConcurrent: 1,
    })).toThrowError(/service_name or SID/);
    const adapter = new OracleDatabaseAdapter({ host: "db", port: 1521, serviceName: "FREEPDB1" }, {
      query: vi.fn(),
    }, { maxRows: 10, maxBytes: 1024, timeoutMs: 100, maxConcurrent: 1 });
    await expect(adapter.query("delete from users")).rejects.toMatchObject({ code: "write_query" });
  });

  it("passes read-only limits to the driver and enforces bytes", async () => {
    const query = vi.fn(async (_sql: string, _binds: Record<string, unknown>, options: { maxRows: number; timeoutMs: number }) => {
      expect(options).toEqual({ maxRows: 10, timeoutMs: 100 });
      return { rows: [{ id: 1 }], bytes: 2000 };
    });
    const adapter = new OracleDatabaseAdapter({ host: "db", port: 1521, sid: "ORCL" }, { query }, {
      maxRows: 10, maxBytes: 1024, timeoutMs: 100, maxConcurrent: 1,
    });
    await expect(adapter.query("select * from users where id = :id", { id: 1 })).rejects.toMatchObject({ code: "query_limit" });
  });
});
