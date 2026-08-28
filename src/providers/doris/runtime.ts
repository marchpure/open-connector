import type { DatabaseBackend } from "../../core/database/executors.ts";

import { createMysqlWireBackend } from "../../core/database/mysql-runtime.ts";

export function createDorisBackend(values: Record<string, string>, signal?: AbortSignal): Promise<DatabaseBackend> {
  return createMysqlWireBackend(
    values,
    {
      service: "doris",
      engine: "Apache Doris",
      defaultPort: 9030,
      defaultDatabase: "information_schema",
      versionMatches: (version) => /doris/i.test(version),
    },
    signal,
  );
}
