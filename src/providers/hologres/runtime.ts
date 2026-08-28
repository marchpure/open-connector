import type { DatabaseBackend } from "../../core/database/executors.ts";

import { createPostgresqlWireBackend } from "../postgresql/runtime.ts";

export function createHologresBackend(values: Record<string, string>, signal?: AbortSignal): Promise<DatabaseBackend> {
  return createPostgresqlWireBackend(
    values,
    {
      service: "hologres",
      engine: "Hologres",
      defaultPort: 80,
      defaultDatabase: "postgres",
      identityQuery: "select hg_version() as version",
      versionMatches: (version) => Boolean(version.trim()),
    },
    signal,
  );
}
