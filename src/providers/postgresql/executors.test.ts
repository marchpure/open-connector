import type { Pool, QueryConfig } from "pg";

import { describe, expect, it, vi } from "vitest";
import { createPostgresAdapter } from "./executors.ts";

const credentials = {
  host: "127.0.0.1",
  port: 5432,
  database: "app",
  username: "reader",
  password: "secret",
  ssl: false,
};

describe("PostgreSQL provider adapter", () => {
  it("validates credentials and reports a safe profile", async () => {
    const pool = fakePool([{ current_database: "app", current_user: "reader" }]);
    const adapter = createPostgresAdapter(() => pool);

    await expect(adapter.validate(credentials)).resolves.toEqual({
      displayName: "reader@127.0.0.1/app",
    });
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("discovers tables and columns through information_schema", async () => {
    const pool = fakePool(
      [{ schema: "public", name: "users", type: "BASE TABLE" }],
      [{ schema: "public", table: "users", name: "id", dataType: "integer", nullable: false, ordinalPosition: 1 }],
    );
    const adapter = createPostgresAdapter(() => pool);

    await expect(adapter.discover(credentials, { schema: "public", limit: 25 })).resolves.toEqual({
      tables: [{ schema: "public", name: "users", type: "BASE TABLE" }],
      columns: [
        { schema: "public", table: "users", name: "id", dataType: "integer", nullable: false, ordinalPosition: 1 },
      ],
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.objectContaining({
        values: ["public", null, 25],
      }),
    );
  });

  it("caps read-only query results with one extra row", async () => {
    const pool = fakePool([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const adapter = createPostgresAdapter(() => pool);

    await expect(
      adapter.query(credentials, { sql: "select * from users", parameters: [], maxRows: 2 }),
    ).resolves.toEqual({
      rows: [{ id: 1 }, { id: 2 }],
      rowCount: 2,
      truncated: true,
    });
    expect(pool.query).toHaveBeenCalledWith(expect.objectContaining({ text: "select * from users limit 3" }));
  });
});

function fakePool(...results: unknown[][]): Pool {
  const query = vi.fn(async (_query: string | QueryConfig) => ({ rows: results.shift() ?? [] }));
  return {
    query,
    end: vi.fn(async () => {}),
  } as unknown as Pool;
}
