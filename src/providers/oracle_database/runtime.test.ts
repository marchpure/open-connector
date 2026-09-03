import { beforeEach, describe, expect, it, vi } from "vitest";
import { OracleAdapterError } from "../../control-plane/oracle-adapter.ts";

const oracle = vi.hoisted(() => {
  const execute = vi.fn();
  const rollback = vi.fn();
  const closeConnection = vi.fn();
  const connection = {
    callTimeout: 0,
    clientId: "",
    clientInfo: "",
    execute,
    rollback,
    close: closeConnection,
  };
  const getConnection = vi.fn(async () => connection);
  return {
    execute,
    rollback,
    closeConnection,
    getConnection,
    connection,
    createPool: vi.fn(async () => ({
      getConnection,
      close: vi.fn(),
    })),
  };
});

vi.mock("oracledb", () => ({
  default: {
    createPool: oracle.createPool,
    OUT_FORMAT_OBJECT: 4002,
  },
}));

import { executors } from "./executors.ts";
import { mapOracleDatabaseError, createOracleBackend } from "./runtime.ts";

describe("Oracle canonical database runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oracle.connection.callTimeout = 0;
    oracle.rollback.mockResolvedValue(undefined);
    oracle.closeConnection.mockResolvedValue(undefined);
  });

  it("uses bound pagination for table previews", async () => {
    oracle.execute.mockResolvedValueOnce({}).mockResolvedValueOnce({
      rows: [{ ORDER_ID: "O-1" }],
      metaData: [{ name: "ORDER_ID", dbTypeName: "VARCHAR2", nullable: false }],
    });
    const backend = await createOracleBackend({
      host: "oracle.test",
      port: "1521",
      serviceName: "FREEPDB1",
      username: "reader",
      password: "secret",
      tls: "disable",
      allowedSchemas: "STEP3B",
    });

    await expect(
      backend.previewTable(undefined, "STEP3B", "STEP3B_ORDERS", { offset: 20, pageSize: 10 }),
    ).resolves.toMatchObject({
      rowCount: 1,
      truncated: false,
    });

    expect(oracle.execute).toHaveBeenNthCalledWith(
      2,
      'select * from "STEP3B"."STEP3B_ORDERS" offset :offset rows fetch next :limit rows only',
      { offset: 20, limit: 11 },
      { outFormat: 4002, maxRows: 11 },
    );
  });

  it("maps positional canonical parameters to Oracle named binds and per-action limits", async () => {
    oracle.execute.mockResolvedValueOnce({}).mockResolvedValueOnce({
      rows: [{ VALUE: "safe" }],
      metaData: [{ name: "VALUE", dbTypeName: "VARCHAR2", nullable: true }],
    });
    const backend = await createOracleBackend({
      host: "oracle.test",
      port: "1521",
      serviceName: "FREEPDB1",
      username: "reader",
      password: "secret",
      tls: "disable",
    });
    oracle.connection.callTimeout = 10_000;

    await expect(
      backend.executeReadQuery("select :p1 as value from dual", ["safe"], {
        maxRows: 5,
        maxBytes: 1024,
        timeoutMs: 250,
      }),
    ).resolves.toMatchObject({
      rows: [{ VALUE: "safe" }],
      rowCount: 1,
      truncated: false,
    });

    expect(oracle.execute).toHaveBeenNthCalledWith(
      2,
      "select :p1 as value from dual",
      { p1: "safe" },
      { outFormat: 4002, maxRows: 6 },
    );
    expect(oracle.connection.callTimeout).toBe(10_000);
    expect(oracle.createPool).toHaveBeenCalledWith(
      expect.objectContaining({ connectString: "tcp://oracle.test:1521/FREEPDB1" }),
    );
  });

  it("uses TCPS connection strings when TLS is required", async () => {
    oracle.execute.mockResolvedValueOnce({}).mockResolvedValueOnce({
      rows: [{ VERSION: "Oracle Database 23c" }],
      metaData: [{ name: "VERSION", dbTypeName: "VARCHAR2", nullable: true }],
    });

    const backend = await createOracleBackend({
      host: "oracle.test",
      port: "1521",
      serviceName: "FREEPDB1",
      username: "reader",
      password: "secret",
      tls: "verify-full",
    });
    await backend.validate();

    expect(oracle.createPool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectString: "tcps://oracle.test:1521/FREEPDB1",
        sslServerDNMatch: true,
      }),
    );
  });

  it("propagates a verified TIP user and agent into the Oracle session", async () => {
    const sessionIdentities: Array<{ clientId: string; clientInfo: string }> = [];
    oracle.execute.mockImplementation(async () => {
      sessionIdentities.push({ clientId: oracle.connection.clientId, clientInfo: oracle.connection.clientInfo });
      return sessionIdentities.length === 1 ? {} : { rows: [] };
    });
    const backend = await createOracleBackend(
      {
        host: "oracle.test",
        port: "1521",
        serviceName: "FREEPDB1",
        username: "reader",
        password: "secret",
        tls: "disable",
      },
      undefined,
      {
        tenantId: "tenant-a",
        userId: "user-1",
        subject: "identity-subject-1",
        agentId: "claw-1",
      },
    );

    await backend.validate();

    expect(oracle.connection.clientId).toBe("");
    expect(oracle.connection.clientInfo).toBe("");
    expect(sessionIdentities).toEqual([
      { clientId: "user-1", clientInfo: "agent=claw-1;subject=identity-subject-1" },
      { clientId: "user-1", clientInfo: "agent=claw-1;subject=identity-subject-1" },
    ]);
    expect(oracle.execute).toHaveBeenCalledWith("SET TRANSACTION READ ONLY");
  });

  it("returns empty discovery for a different Oracle service name", async () => {
    const backend = await createOracleBackend({
      host: "oracle.test",
      port: "1521",
      serviceName: "FREEPDB1",
      username: "reader",
      password: "secret",
      tls: "disable",
      allowedSchemas: "STEP3B",
    });

    await expect(backend.listSchemas("otherdb", { offset: 0, pageSize: 20 })).resolves.toEqual([]);
    await expect(backend.listTables("otherdb", "STEP3B", { offset: 0, pageSize: 20 })).resolves.toEqual([]);
    await expect(backend.describeTable("otherdb", "STEP3B", "STEP3B_ORDERS")).rejects.toThrow(/Cross-database/);
    expect(oracle.execute).not.toHaveBeenCalled();
  });

  it("maps Oracle adapter safety failures to canonical database action errors", async () => {
    const result = await executors["oracle_database.execute_read_query"](
      { query: "delete from STEP3B.STEP3B_ORDERS" },
      {
        getCredential: async () => ({
          authType: "custom_credential",
          values: {
            host: "oracle.test",
            port: "1521",
            serviceName: "FREEPDB1",
            username: "reader",
            password: "secret",
            tls: "disable",
          },
          profile: {
            accountId: "oracle.test:1521/FREEPDB1/reader",
            displayName: "reader@oracle.test/FREEPDB1",
            grantedScopes: ["read"],
          },
          metadata: {},
        }),
      },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "database_query_rejected",
        message: "Only parameterized read-only SELECT/WITH queries are allowed.",
      },
    });
    expect(oracle.getConnection).not.toHaveBeenCalled();
    expect(oracle.execute).not.toHaveBeenCalled();
  });

  it("classifies wrapped Oracle driver failures without exposing driver details", async () => {
    oracle.createPool.mockRejectedValueOnce(
      Object.assign(new Error("ORA-01017: invalid username/password"), {
        code: "ORA-01017",
      }),
    );

    const result = await executors["oracle_database.validate_connection"](
      {},
      {
        getCredential: async () => ({
          authType: "custom_credential",
          values: {
            host: "oracle.test",
            port: "1521",
            serviceName: "FREEPDB1",
            username: "reader",
            password: "secret",
            tls: "disable",
          },
          profile: {
            accountId: "oracle.test:1521/FREEPDB1/reader",
            displayName: "reader@oracle.test/FREEPDB1",
            grantedScopes: ["read"],
          },
          metadata: {},
        }),
      },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "database_authentication_failed",
        message: "Database authentication failed.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");

    expect(
      mapOracleDatabaseError(
        new OracleAdapterError("query_failed", "Oracle query failed.", new Error("Oracle query timed out.")),
      ),
    ).toMatchObject({ ok: false, error: { code: "database_timeout" } });
  });
});
