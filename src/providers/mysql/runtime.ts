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
      // MariaDB speaks the MySQL wire protocol and is commonly exposed by
      // managed "MySQL" instances. Keep rejecting analytical/other engines,
      // but accept MariaDB as a compatible MySQL endpoint.
      versionMatches: (version) => !/(doris|starrocks|tidb|oceanbase)/i.test(version),
    },
    signal,
  );
}
