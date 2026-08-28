import type { DatabaseBackend } from "../../core/database/executors.ts";

import { createMysqlWireBackend } from "../../core/database/mysql-runtime.ts";

export function createMysqlBackend(values: Record<string, string>, signal?: AbortSignal): Promise<DatabaseBackend> {
  return createMysqlWireBackend(
    values,
    {
      service: "mysql",
      engine: "MySQL",
      defaultPort: 3306,
      defaultDatabase: "mysql",
      versionMatches: (version) => !/(doris|starrocks|mariadb|tidb|oceanbase)/i.test(version),
    },
    signal,
  );
}
