import type { DatabaseBackend } from "../../core/database/executors.ts";

import { createMysqlWireBackend } from "../../core/database/mysql-runtime.ts";

export function createTidbSqlBackend(values: Record<string, string>, signal?: AbortSignal): Promise<DatabaseBackend> {
  return createMysqlWireBackend(
    values,
    {
      service: "tidb_sql",
      engine: "TiDB",
      defaultPort: 4000,
      defaultDatabase: "test",
      versionMatches: (version) => /\btidb\b/i.test(version),
    },
    signal,
  );
}
