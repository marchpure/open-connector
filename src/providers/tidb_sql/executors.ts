import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { createDatabaseProviderRuntime } from "../../core/database/executors.ts";
import { createTidbSqlBackend } from "./runtime.ts";

const runtime = createDatabaseProviderRuntime("tidb_sql", createTidbSqlBackend);
export const executors: ProviderExecutors = runtime.executors;
export const credentialValidators: CredentialValidators = runtime.credentialValidators;
