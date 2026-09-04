import { describe, expect, it } from "vitest";
import {
  assertReadOnlySql,
  createDatabaseCredentialValidators,
  createDatabaseExecutors,
  limitRows,
  readDatabaseCredentials,
  readDiscoveryInput,
  readQueryInput,
  toDatabaseExecutionError,
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

  it("distinguishes driver, credential, timeout, and network failures without leaking connection secrets", async () => {
    const secret = "super-secret-password";
    const connectString = `postgresql://reader:${secret}@db.example.com:5432/app`;
    const failures = [
      {
        error: Object.assign(new Error(`password authentication failed for user reader at ${connectString}`), {
          code: "28P01",
        }),
        code: "authorization_failed",
        message: "Database rejected the supplied credentials.",
        status: 401,
      },
      {
        error: Object.assign(new Error(`connect timeout while opening ${connectString}`), { code: "ETIMEDOUT" }),
        code: "provider_error",
        message: "Database connection timed out.",
        status: 504,
      },
      {
        error: Object.assign(new Error(`connect ECONNREFUSED ${connectString}`), { code: "ECONNREFUSED" }),
        code: "provider_error",
        message: "Database network connection failed.",
        status: 502,
      },
      {
        error: Object.assign(new Error("Cannot find package 'mysql2'"), { code: "ERR_MODULE_NOT_FOUND" }),
        code: "provider_error",
        message: "Database driver is not installed in this runtime image.",
        status: 501,
      },
    ];

    for (const failure of failures) {
      const result = toDatabaseExecutionError(failure.error);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe(failure.code);
      expect(result.error?.message).toBe(failure.message);
      if (failure.status) {
        expect(result.error?.details).toMatchObject({ status: failure.status });
      }
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(connectString);
    }
  });

  it("normalizes connection validation driver errors before returning them to callers", async () => {
    const validators = createDatabaseCredentialValidators(
      {
        service: "postgresql",
        displayName: "PostgreSQL",
        defaultPort: 5432,
        adapter: {
          async validate() {
            throw Object.assign(new Error("Access denied for user with password bad-password"), {
              code: "ER_ACCESS_DENIED_ERROR",
            });
          },
          async discover() {
            throw new Error("not used");
          },
          async query() {
            throw new Error("not used");
          },
        },
      },
      5432,
    );

    await expect(
      validators.customCredential?.(
        {
          values: {
            host: "db.example.com",
            database: "app",
            username: "reader",
            password: "bad-password",
          },
        },
        { fetcher: fetch, signal: undefined },
      ),
    ).rejects.toMatchObject({ status: 401, message: "Database rejected the supplied credentials." });
  });

  it("normalizes action driver errors before returning them to callers", async () => {
    const executors = createDatabaseExecutors({
      service: "postgresql",
      displayName: "PostgreSQL",
      defaultPort: 5432,
      adapter: {
        async validate() {
          throw new Error("not used");
        },
        async discover() {
          throw Object.assign(new Error("connect timeout with password bad-password"), { code: "ETIMEDOUT" });
        },
        async query() {
          throw new Error("not used");
        },
      },
    });

    const result = await executors["postgresql.discover_schema"]!(
      { limit: 1 },
      {
        async getCredential() {
          return {
            authType: "custom_credential",
            values: {
              host: "db.example.com",
              database: "app",
              username: "reader",
              password: "bad-password",
            },
            profile: { accountId: "reader", displayName: "reader", grantedScopes: ["read"] },
            metadata: {},
          };
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "provider_error",
        message: "Database connection timed out.",
        details: { status: 504 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("bad-password");
  });
});
