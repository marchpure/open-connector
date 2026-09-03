import type { DatabaseBackend } from "../../core/database/executors.ts";

import { createPostgresqlBackend } from "../postgresql/runtime.ts";

export function createHologresBackend(values: Record<string, string>, signal?: AbortSignal): Promise<DatabaseBackend> {
  return createPostgresqlBackend(values, signal);
}
