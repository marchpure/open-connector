import { beforeEach, describe, expect, it, vi } from "vitest";

const mssql = vi.hoisted(() => {
  interface FakeRequest {
    input: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }

  const configs: Record<string, unknown>[] = [];
  const requests: FakeRequest[] = [];
  let queryImplementation: (text: string) => Promise<Record<string, unknown>>;

  class ConnectionPool {
    readonly config: Record<string, unknown>;

    constructor(config: Record<string, unknown>) {
      this.config = config;
      configs.push(config);
    }

    async connect(): Promise<this> {
      return this;
    }

    async close(): Promise<void> {}

    request(): FakeRequest {
      let rejectPending: ((error: Error) => void) | undefined;
      const request: FakeRequest = {
        input: vi.fn().mockReturnThis(),
        cancel: vi.fn(() => rejectPending?.(Object.assign(new Error("Canceled."), { code: "ECANCEL" }))),
        query: vi.fn((text: string) => {
          const result = queryImplementation(text);
          return new Promise((resolve, reject) => {
            rejectPending = reject;
            result.then(resolve, reject);
          });
        }),
      };
      requests.push(request);
      return request;
    }
  }

  const readonlyResult = {
    recordset: [
      {
        can_insert: 0,
        can_update: 0,
        can_delete: 0,
        can_alter: 0,
        can_write_object: 0,
      },
    ],
  };

  return {
    ConnectionPool,
    configs,
    requests,
    readonlyResult,
    setQueryImplementation(implementation: (text: string) => Promise<Record<string, unknown>>): void {
      queryImplementation = implementation;
    },
  };
});

vi.mock("mssql", () => ({
  default: { ConnectionPool: mssql.ConnectionPool },
}));

import { normalizeDatabaseError } from "../../core/database/runtime.ts";
import { createSqlServerBackend } from "./runtime.ts";

const baseCredential = {
  host: "8.8.8.8",
  database: "app",
  username: "reader",
  password: "secret",
  tls: "verify-full",
};

describe("SQL Server runtime contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mssql.configs.length = 0;
    mssql.requests.length = 0;
    mssql.setQueryImplementation(async () => mssql.readonlyResult);
    delete process.env.CONNECTION_DATABASE_EGRESS_ALLOWLIST;
  });

  it("rejects an instance name combined with an explicit port", async () => {
    await expect(
      createSqlServerBackend({ ...baseCredential, instanceName: "SQLEXPRESS", port: "1433" }),
    ).rejects.toThrow(/mutually exclusive/i);
    expect(mssql.configs).toHaveLength(0);
  });

  it("maps TLS modes to driver encryption and certificate defaults", async () => {
    await createSqlServerBackend({ ...baseCredential, username: "verify-reader" });
    await createSqlServerBackend({
      ...baseCredential,
      username: "require-reader",
      tls: "require",
    });
    await createSqlServerBackend({
      ...baseCredential,
      username: "plain-reader",
      tls: "disable",
    });

    expect(mssql.configs.map((config) => config.options)).toEqual([
      expect.objectContaining({ encrypt: true, trustServerCertificate: false }),
      expect.objectContaining({ encrypt: true, trustServerCertificate: true }),
      expect.objectContaining({ encrypt: false, trustServerCertificate: false }),
    ]);

    await expect(
      createSqlServerBackend({ ...baseCredential, username: "bad-encrypt", encrypt: "false" }),
    ).rejects.toThrow(/encrypt must be false.*tls=disable.*true.*tls=require/i);
    await expect(
      createSqlServerBackend({
        ...baseCredential,
        username: "bad-trust",
        trustServerCertificate: "true",
      }),
    ).rejects.toThrow(/incompatible.*verify-full/i);
  });

  it("binds scalar query parameters instead of interpolating values", async () => {
    mssql.setQueryImplementation(async (text) =>
      text.includes("openconnector_read")
        ? {
            recordset: Object.assign([{ value: "safe" }], {
              columns: { value: { name: "value" } },
            }),
          }
        : mssql.readonlyResult,
    );
    const backend = await createSqlServerBackend({ ...baseCredential, username: "binding-reader" });

    await backend.executeReadQuery("select @p1 as value", ["'; drop table users; --"], {
      maxRows: 10,
      maxBytes: 1024,
      timeoutMs: 1000,
    });

    const queryRequest = mssql.requests.at(-1);
    expect(queryRequest?.input).toHaveBeenCalledWith("p1", "'; drop table users; --");
    expect(queryRequest?.query).toHaveBeenCalledWith(expect.not.stringContaining("drop table users"));
  });

  it("cancels a request at its timeout and returns the stable timeout class", async () => {
    mssql.setQueryImplementation(async (text) => {
      if (!text.includes("openconnector_read")) return mssql.readonlyResult;
      return new Promise(() => undefined);
    });
    const backend = await createSqlServerBackend({ ...baseCredential, username: "timeout-reader" });

    await expect(
      backend.executeReadQuery("select 1 as value", [], {
        maxRows: 10,
        maxBytes: 1024,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "database_timeout" });
    expect(mssql.requests.at(-1)?.cancel).toHaveBeenCalledOnce();
  });

  it("rejects principals with effective write privileges", async () => {
    mssql.setQueryImplementation(async () => ({
      recordset: [{ ...mssql.readonlyResult.recordset[0], can_write_object: 1 }],
    }));

    await expect(createSqlServerBackend({ ...baseCredential, username: "writer" })).rejects.toMatchObject({
      code: "database_permission_denied",
    });
  });

  it.each([
    [
      { code: "ELOGIN", message: "Login failed for user private-name." },
      "database_authentication_failed",
      "Database authentication failed.",
    ],
    [
      { code: "ESOCKET", message: "socket closed at private-host." },
      "database_network_failed",
      "Database network connection failed.",
    ],
    [
      { code: "ETIMEOUT", message: "request timeout for private-query." },
      "database_timeout",
      "Database request timed out or was cancelled.",
    ],
    [
      { code: "EPERM", message: "permission denied on private-table." },
      "database_permission_denied",
      "Database permission denied.",
    ],
    [
      { code: "ECERT", message: "self signed certificate private-ca." },
      "database_tls_failed",
      "Database TLS verification failed.",
    ],
  ])("maps driver failures without exposing server details", (error, code, message) => {
    const mapped = normalizeDatabaseError(error);
    expect(mapped.code).toBe(code);
    expect(mapped.message).toBe(message);
    expect(mapped.message).not.toContain("private");
  });
});
