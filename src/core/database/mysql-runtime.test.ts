import { afterEach, describe, expect, it, vi } from "vitest";

const mysql = vi.hoisted(() => ({
  createPool: vi.fn(),
}));

vi.mock("mysql2/promise", () => ({ default: mysql }));

import { setPrivateNetworkAccessAllowed } from "../request.ts";
import { createMysqlWireBackend } from "./mysql-runtime.ts";

describe("MySQL-wire analytical runtime", () => {
  afterEach(() => {
    setPrivateNetworkAccessAllowed(false);
    delete process.env.CONNECTION_DATABASE_EGRESS_ALLOWLIST;
    mysql.createPool.mockReset();
  });

  it("applies bounded analytical session settings and provider-specific EXPLAIN", async () => {
    setPrivateNetworkAccessAllowed(true);
    process.env.CONNECTION_DATABASE_EGRESS_ALLOWLIST = "8.8.8.8";
    const queries: string[] = [];
    const connection = {
      query: vi.fn(async (query: string) => {
        queries.push(query);
        if (query === "SHOW GRANTS") {
          return [[{ grants: "app: Select_priv" }], []];
        }
        if (query.startsWith("EXPLAIN")) {
          return [[{ plan: "cardinality=2" }], []];
        }
        return [[], []];
      }),
      execute: vi.fn(async () => [[{ id: 1 }], [{ name: "id", type: 3, typeName: "LONG" }]]),
      release: vi.fn(),
      destroy: vi.fn(),
    };
    mysql.createPool.mockReturnValue({
      getConnection: vi.fn(async () => connection),
      end: vi.fn(async () => undefined),
    });

    const backend = await createMysqlWireBackend(
      { host: "8.8.8.8", port: "3306", database: "app", username: "reader", password: "secret", tls: "disable" },
      {
        service: "doris",
        engine: "Apache Doris",
        defaultPort: 9030,
        defaultDatabase: "information_schema",
        versionMatches: () => true,
      },
    );
    await backend.executeReadQuery("select * from `orders`", [], {
      maxRows: 10,
      maxBytes: 1024,
      timeoutMs: 1000,
    });

    expect(queries).toEqual([
      "SHOW GRANTS",
      "SET SESSION query_timeout = 1",
      "SET SESSION exec_mem_limit = 104857600",
      "SET SESSION sql_select_limit = 11",
      "EXPLAIN select * from (select * from `orders`) as openconnector_read limit 11",
    ]);
    expect(connection.execute).toHaveBeenCalledWith(
      { sql: "select * from (select * from `orders`) as openconnector_read limit 11", timeout: 1000 },
      [],
    );
  });

  it("preserves native MySQL-wire type names in query metadata", async () => {
    setPrivateNetworkAccessAllowed(true);
    process.env.CONNECTION_DATABASE_EGRESS_ALLOWLIST = "8.8.8.8";
    const connection = {
      query: vi.fn(async (query: string) => {
        if (query === "SHOW GRANTS") return [[{ grants: "app: Select_priv" }], []];
        if (query.startsWith("EXPLAIN")) return [[{ plan: "cardinality=2" }], []];
        return [[], []];
      }),
      execute: vi.fn(async () => [[{ id: 1 }], [{ name: "id", type: 3, typeName: "LONG" }]]),
      release: vi.fn(),
      destroy: vi.fn(),
    };
    mysql.createPool.mockReturnValue({
      getConnection: vi.fn(async () => connection),
      end: vi.fn(async () => undefined),
    });

    const backend = await createMysqlWireBackend(
      { host: "8.8.8.8", port: "3306", database: "app", username: "reader", password: "secret", tls: "disable" },
      {
        service: "mysql",
        engine: "MySQL",
        defaultPort: 3306,
        defaultDatabase: "mysql",
        versionMatches: () => true,
      },
    );
    const result = await backend.executeReadQuery("select * from `orders`", [], {
      maxRows: 10,
      maxBytes: 1024,
      timeoutMs: 1000,
    });

    expect(result.columns).toEqual([{ name: "id", dataType: "LONG" }]);
  });
});
