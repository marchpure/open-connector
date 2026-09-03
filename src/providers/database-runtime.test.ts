import { describe, expect, it } from "vitest";
import {
  assertReadOnlySql,
  limitRows,
  readDatabaseCredentials,
  readDiscoveryInput,
  readQueryInput,
} from "./database-runtime.ts";

describe("database runtime helpers", () => {
  it("normalizes connection credentials and defaults the database port", () => {
    expect(
      readDatabaseCredentials(
        {
          host: "db.example.com",
          database: "warehouse",
          username: "analyst",
          password: "secret",
          ssl: "true",
        },
        5432,
      ),
    ).toEqual({
      host: "db.example.com",
      port: 5432,
      database: "warehouse",
      username: "analyst",
      password: "secret",
      ssl: true,
    });
  });

  it("rejects write SQL and multiple statements for read-only actions", () => {
    expect(() => assertReadOnlySql("select * from users")).not.toThrow();
    expect(() => assertReadOnlySql("with recent as (select * from users) select * from recent")).not.toThrow();
    expect(() => assertReadOnlySql("select * from users; delete from users")).toThrow("Only one SQL statement");
    expect(() => assertReadOnlySql("update users set name = 'x'")).toThrow("Only read-only SELECT");
  });

  it("normalizes discovery and query limits", () => {
    expect(readDiscoveryInput({ schema: "public", limit: 10 })).toEqual({ schema: "public", limit: 10 });
    expect(readQueryInput({ sql: "select * from users;", parameters: ["active"], maxRows: 5 })).toEqual({
      sql: "select * from users",
      parameters: ["active"],
      maxRows: 5,
    });
    expect(limitRows([{ id: 1 }, { id: 2 }], 1)).toEqual({ rows: [{ id: 1 }], rowCount: 1, truncated: true });
  });
});
