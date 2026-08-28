import type { DatabaseBackend } from "../../core/database/executors.ts";

import { createMysqlWireBackend } from "../../core/database/mysql-runtime.ts";

export function createStarrocksBackend(values: Record<string, string>, signal?: AbortSignal): Promise<DatabaseBackend> {
  return createMysqlWireBackend(
    values,
    {
      service: "starrocks",
      engine: "StarRocks",
      defaultPort: 9030,
      defaultDatabase: "information_schema",
      versionMatches: (version) => /^\d+\.\d+\.\d+\s+\d+\.\d+\.\d+/.test(version),
      identityQuery: "SELECT current_version() AS native_version",
      identityVersionField: "native_version",
    },
    signal,
  );
}
