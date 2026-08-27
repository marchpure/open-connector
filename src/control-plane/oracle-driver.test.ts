import { beforeEach, describe, expect, it, vi } from "vitest";

const oracle = vi.hoisted(() => {
  const execute = vi.fn();
  const rollback = vi.fn();
  const closeConnection = vi.fn();
  const getConnection = vi.fn(async () => ({
    execute,
    rollback,
    close: closeConnection,
  }));
  return {
    execute,
    rollback,
    closeConnection,
    getConnection,
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

import { OracleThinDriver } from "./oracle-driver.ts";

describe("OracleThinDriver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oracle.rollback.mockResolvedValue(undefined);
    oracle.closeConnection.mockResolvedValue(undefined);
    oracle.execute.mockResolvedValueOnce({}).mockResolvedValueOnce({
      rows: [{ ID: 1 }],
      metaData: [{ name: "ID", dbTypeName: "NUMBER", nullable: false }],
    });
  });

  it("executes queries in a driver-level read-only transaction and rolls back", async () => {
    const driver = new OracleThinDriver(
      { host: "db", port: 1521, serviceName: "FREEPDB1" },
      { user: "reader", password: "secret" },
    );

    await expect(
      driver.query(
        "select id from app.orders",
        {},
        {
          maxRows: 10,
          timeoutMs: 100,
        },
      ),
    ).resolves.toEqual({
      rows: [{ ID: 1 }],
      columns: [{ name: "ID", dbTypeName: "NUMBER", nullable: false }],
      bytes: 10,
    });

    expect(oracle.execute).toHaveBeenNthCalledWith(1, "SET TRANSACTION READ ONLY");
    expect(oracle.execute).toHaveBeenNthCalledWith(
      2,
      "select id from app.orders",
      {},
      { outFormat: 4002, maxRows: 10 },
    );
    expect(oracle.rollback).toHaveBeenCalledOnce();
    expect(oracle.closeConnection).toHaveBeenCalledOnce();
  });
});
