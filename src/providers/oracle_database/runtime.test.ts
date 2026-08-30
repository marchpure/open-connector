import { beforeEach, describe, expect, it, vi } from "vitest";

const oracle = vi.hoisted(() => ({
  createPool: vi.fn(),
  poolClose: vi.fn(),
  getConnection: vi.fn(),
}));

vi.mock("oracledb", () => ({
  default: {
    createPool: oracle.createPool,
    OUT_FORMAT_OBJECT: 4002,
  },
}));

import { setPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { closeOraclePools, createOracleBackend } from "./runtime.ts";

function pool(): { getConnection: typeof oracle.getConnection; close: typeof oracle.poolClose } {
  return { getConnection: oracle.getConnection, close: oracle.poolClose };
}

const values = (password: string, serviceName = "POOL_TEST") => ({
  host: "10.0.0.1",
  port: "1521",
  username: "reader",
  password,
  tls: "disable",
  serviceName,
});

describe("Oracle database pool lifecycle", () => {
  beforeEach(async () => {
    await closeOraclePools();
    vi.clearAllMocks();
    setPrivateNetworkAccessAllowed(true);
    process.env.CONNECTION_DATABASE_EGRESS_ALLOWLIST = "10.0.0.1";
    oracle.poolClose.mockResolvedValue(undefined);
    oracle.getConnection.mockResolvedValue({
      execute: vi.fn(),
      rollback: vi.fn(),
      close: vi.fn(),
    });
    oracle.createPool.mockImplementation(async () => pool());
  });

  it("reuses one credential-scoped pool and closes it on rotation", async () => {
    await createOracleBackend(values("first"));
    await createOracleBackend(values("first"));
    expect(oracle.createPool).toHaveBeenCalledOnce();

    await createOracleBackend(values("second"));
    expect(oracle.createPool).toHaveBeenCalledTimes(2);
    expect(oracle.poolClose).toHaveBeenCalledOnce();

    await closeOraclePools();
    expect(oracle.poolClose).toHaveBeenCalledTimes(2);
  });
});
