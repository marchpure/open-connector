import { describe, expect, it, vi } from "vitest";
import { mapOracleDatabaseError } from "../providers/oracle_database/runtime.ts";
import { OracleDatabaseAdapter } from "./oracle-adapter.ts";

describe("OracleDatabaseAdapter", () => {
  it("requires a service name and rejects non-read-only Oracle ASTs", async () => {
    expect(
      () =>
        new OracleDatabaseAdapter(
          { host: "db", port: 1521 },
          { query: vi.fn() },
          {
            maxRows: 10,
            maxBytes: 1024,
            timeoutMs: 100,
            maxConcurrent: 1,
          },
        ),
    ).toThrowError(/service name/);
    const adapter = new OracleDatabaseAdapter(
      { host: "db", port: 1521, serviceName: "FREEPDB1" },
      {
        query: vi.fn(),
      },
      { maxRows: 10, maxBytes: 1024, timeoutMs: 100, maxConcurrent: 1 },
    );
    await expect(adapter.query("delete from users")).rejects.toMatchObject({ code: "write_query" });
    await expect(adapter.query("select 1 from dual; delete from users")).rejects.toMatchObject({ code: "write_query" });
    await expect(adapter.query("select * from app.orders for update")).rejects.toMatchObject({ code: "write_query" });
    await expect(adapter.query("select dbms_lock.sleep(10) from dual")).rejects.toMatchObject({ code: "write_query" });
  });

  it("returns rows, schema, and AST-derived lineage while enforcing limits", async () => {
    const query = vi.fn(
      async (_sql: string, _binds: Record<string, unknown>, options: { maxRows: number; timeoutMs: number }) => {
        expect(options).toEqual({ maxRows: 10, timeoutMs: 100 });
        return {
          rows: [{ ID: 1 }],
          columns: [{ name: "ID", dbTypeName: "NUMBER", nullable: false }],
          bytes: 20,
        };
      },
    );
    const adapter = new OracleDatabaseAdapter(
      { host: "db", port: 1521, serviceName: "FREEPDB1" },
      { query },
      {
        maxRows: 10,
        maxBytes: 1024,
        timeoutMs: 100,
        maxConcurrent: 1,
        allowedSchemas: ["APP"],
      },
    );
    await expect(adapter.query("select id from app.orders where id = :id", { id: 1 })).resolves.toEqual({
      rows: [{ ID: 1 }],
      columns: [{ name: "ID", dbTypeName: "NUMBER", nullable: false }],
      bytes: 20,
      lineage: [{ schema: "APP", object: "ORDERS" }],
    });
    await expect(adapter.query("select * from other.orders")).rejects.toMatchObject({ code: "schema_denied" });

    query.mockResolvedValueOnce({
      rows: [{ ID: 1 }],
      columns: [{ name: "ID", dbTypeName: "NUMBER", nullable: false }],
      bytes: 2000,
    });
    await expect(adapter.query("select * from app.orders")).rejects.toMatchObject({ code: "query_limit" });
  });

  it("discovers allowed Oracle schemas, tables, and columns with bind variables", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ SCHEMA_NAME: "APP" }],
        bytes: 23,
      })
      .mockResolvedValueOnce({
        rows: [{ TABLE_NAME: "ORDERS" }],
        bytes: 25,
      })
      .mockResolvedValueOnce({
        rows: [{ COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", NULLABLE: "N", COLUMN_ID: 1 }],
        bytes: 75,
      });
    const adapter = new OracleDatabaseAdapter(
      { host: "db", port: 1521, serviceName: "FREEPDB1" },
      { query },
      {
        maxRows: 100,
        maxBytes: 1024,
        timeoutMs: 100,
        maxConcurrent: 1,
        allowedSchemas: ["APP"],
      },
    );

    await expect(adapter.discover()).resolves.toEqual({ schemas: ["APP"] });
    await expect(adapter.discover({ schema: "app" })).resolves.toEqual({
      schema: "APP",
      tables: ["ORDERS"],
    });
    await expect(adapter.discover({ schema: "APP", table: "orders" })).resolves.toEqual({
      schema: "APP",
      table: "ORDERS",
      columns: [{ name: "ID", dataType: "NUMBER", nullable: false, ordinal: 1 }],
    });
    await expect(adapter.discover({ schema: "OTHER" })).rejects.toMatchObject({ code: "schema_denied" });

    expect(query.mock.calls[1]?.[1]).toEqual({ schema: "APP" });
    expect(query.mock.calls[2]?.[1]).toEqual({ schema: "APP", tableName: "ORDERS" });
  });

  it("redacts protected dictionary access failures as permission denials", () => {
    expect(
      mapOracleDatabaseError({
        code: "ORA-00942",
        message: 'ORA-00942: table or view "SYS"."DBA_USERS" does not exist',
      }),
    ).toEqual({
      ok: false,
      error: { code: "database_permission_denied", message: "Database permission denied." },
    });
    expect(
      mapOracleDatabaseError({
        code: "ORA-00942",
        message: 'ORA-00942: table or view "APP"."DBA_USERS" does not exist',
      }),
    ).toEqual({
      ok: false,
      error: { code: "database_query_failed", message: "Database query failed." },
    });
  });
});
