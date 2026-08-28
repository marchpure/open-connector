import { describe, expect, it } from "vitest";
import {
  assertClickhouseReadOnlySql,
  assertReadOnlySql,
  boundedQueryResult,
  quoteIdentifier,
  readPage,
} from "./runtime.ts";

describe("database query safety", () => {
  it.each(["postgresql", "mysql", "transactsql"] as const)("accepts one SELECT or read CTE for %s", (dialect) => {
    expect(() => assertReadOnlySql("select * from users where id = $1", dialect)).not.toThrow();
    expect(() =>
      assertReadOnlySql("with visible as (select id from users) select * from visible", dialect),
    ).not.toThrow();
  });

  it.each(["postgresql", "mysql", "transactsql"] as const)(
    "rejects writes and multiple statements for %s",
    (dialect) => {
      for (const query of [
        "insert into users(id) values (1)",
        "update users set name = 'x'",
        "delete from users",
        "drop table users",
        "select 1; delete from users",
        "with removed as (delete from users returning *) select * from removed",
        "select * from users for update",
      ]) {
        expect(() => assertReadOnlySql(query, dialect), query).toThrowError(/read-only/i);
      }
    },
  );

  it("rejects dangerous functions while ignoring quoted words and comments", () => {
    expect(() => assertReadOnlySql("select pg_read_file('/etc/passwd')", "postgresql")).toThrowError(/read-only/i);
    expect(() => assertReadOnlySql("select pg_sleep(5)", "postgresql")).toThrowError(/read-only/i);
    expect(() => assertReadOnlySql("select load_file('/etc/passwd')", "mysql")).toThrowError(/read-only/i);
    expect(() => assertReadOnlySql("select 'delete from users' as text -- update\n", "postgresql")).not.toThrow();
  });

  it("applies ClickHouse-specific read syntax and dangerous table-function blocks", () => {
    expect(() => assertClickhouseReadOnlySql("SELECT * FROM events WHERE id = {p1:String}")).not.toThrow();
    expect(() => assertClickhouseReadOnlySql("SELECT * FROM url('https://example.com')")).toThrowError(/read-only/i);
    expect(() => assertClickhouseReadOnlySql("SELECT * FROM remote('host', 'db', 'events')")).toThrowError(
      /read-only/i,
    );
    expect(() => assertClickhouseReadOnlySql("SELECT * FROM s3Cluster('cluster', 'bucket', 'events')")).toThrowError(
      /read-only/i,
    );
    expect(() => assertClickhouseReadOnlySql("SELECT sleep(5)")).toThrowError(/read-only/i);
    expect(() => assertClickhouseReadOnlySql("SELECT sleepEachRow(5) FROM events")).toThrowError(/read-only/i);
    expect(() => assertClickhouseReadOnlySql("SELECT 1; DROP TABLE events")).toThrowError(/read-only/i);
  });

  it("quotes Unicode identifiers and bounds result bytes and rows", () => {
    expect(quoteIdentifier('订单"表', "double")).toBe('"订单""表"');
    expect(quoteIdentifier("订单`表", "backtick")).toBe("`订单``表`");
    expect(quoteIdentifier("订单]表", "bracket")).toBe("[订单]]表]");
    expect(boundedQueryResult([{ id: 1 }, { id: 2 }], [{ name: "id" }], 1, 1024)).toMatchObject({
      rowCount: 1,
      truncated: true,
    });
  });

  it("uses opaque bounded pagination cursors", () => {
    expect(readPage({ pageSize: 200, cursor: Buffer.from("20").toString("base64url") })).toEqual({
      pageSize: 200,
      offset: 20,
    });
    expect(() => readPage({ cursor: "not-an-offset" })).toThrowError(/cursor/i);
  });
});
