import type { DatabaseBackend } from "../../core/database/executors.ts";

import { createMysqlWireBackend } from "../../core/database/mysql-runtime.ts";
import { DatabaseRuntimeError } from "../../core/database/runtime.ts";
import { createOceanbaseOracleBackend } from "./oracle-runtime.ts";

export function createOceanbaseBackend(values: Record<string, string>, signal?: AbortSignal): Promise<DatabaseBackend> {
  const mode = values.mode?.trim().toLowerCase();
  if (mode === "oracle") return createOceanbaseOracleBackend(values, signal);
  if (mode !== "mysql")
    throw new DatabaseRuntimeError("database_query_rejected", "OceanBase compatibility mode must be mysql or oracle.");
  return createMysqlWireBackend(
    values,
    {
      service: "oceanbase",
      engine: "OceanBase",
      defaultPort: 2881,
      defaultDatabase: "test",
      versionMatches: (version) => /\boceanbase\b/i.test(version),
    },
    signal,
  );
}
