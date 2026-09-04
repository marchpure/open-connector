import { describe, expect, it, vi } from "vitest";
import { createOracleAdapter } from "./executors.ts";

const credentials = {
  host: "127.0.0.1",
  port: 1521,
  database: "FREEPDB1",
  username: "reader",
  password: "secret",
  ssl: false,
};

type OracleTestConnection = {
  execute<T = unknown>(
    sql: string,
    binds?: unknown[] | Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ rows?: T[] }>;
  close(): Promise<void>;
  executeMock: ReturnType<typeof vi.fn>;
};

describe("Oracle Database provider adapter", () => {
  it("uses a default-exported node-oracledb module shape", async () => {
    const connection = fakeConnection([{ CURRENT_SCHEMA: "READER", CURRENT_USER: "READER" }]);
    const adapter = createOracleAdapter(async () => ({
      default: {
        OUT_FORMAT_OBJECT: 4002,
        getConnection: async () => connection,
      },
    }));

    await expect(adapter.validate(credentials)).resolves.toEqual({
      displayName: "READER@127.0.0.1/READER",
    });
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("discovers tables and normalizes nullable flags", async () => {
    const connection = fakeConnection(
      [{ schema: "READER", name: "USERS", type: "TABLE" }],
      [
        {
          schema: "READER",
          table: "USERS",
          name: "ID",
          dataType: "NUMBER",
          nullable: "N",
          ordinalPosition: 1,
        },
        {
          schema: "READER",
          table: "USERS",
          name: "NAME",
          dataType: "VARCHAR2",
          nullable: "Y",
          ordinalPosition: 2,
        },
      ],
    );
    const loadOracle: Parameters<typeof createOracleAdapter>[0] = async () => ({
      OUT_FORMAT_OBJECT: 4002,
      getConnection: async () => connection,
    });
    const adapter = createOracleAdapter(loadOracle);

    await expect(adapter.discover(credentials, { schema: "reader", table: "users", limit: 25 })).resolves.toEqual({
      tables: [{ schema: "READER", name: "USERS", type: "TABLE" }],
      columns: [
        { schema: "READER", table: "USERS", name: "ID", dataType: "NUMBER", nullable: false, ordinalPosition: 1 },
        { schema: "READER", table: "USERS", name: "NAME", dataType: "VARCHAR2", nullable: true, ordinalPosition: 2 },
      ],
    });
    expect(connection.executeMock).toHaveBeenCalledWith(
      expect.any(String),
      { schema_name: "READER", table_name: "USERS", row_limit: 25 },
      { outFormat: 4002 },
    );
    expect(connection.close).toHaveBeenCalledOnce();
  });
});

function fakeConnection(...results: unknown[][]): OracleTestConnection {
  const executeMock = vi.fn(
    async (_sql: string, _binds?: unknown[] | Record<string, unknown>, _options?: Record<string, unknown>) => ({
      rows: results.shift() ?? [],
    }),
  );
  return {
    async execute<T>(sql: string, binds?: unknown[] | Record<string, unknown>, options?: Record<string, unknown>) {
      const result = await executeMock(sql, binds, options);
      return { rows: result.rows as T[] };
    },
    executeMock,
    close: vi.fn(async () => {}),
  };
}
