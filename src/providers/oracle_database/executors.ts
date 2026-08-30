import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { createDatabaseProviderRuntime } from "../../core/database/executors.ts";
import { createOracleBackend, mapOracleDatabaseError } from "./runtime.ts";

const runtime = createDatabaseProviderRuntime("oracle_database", createOracleBackend, mapOracleDatabaseError);

export const executors: ProviderExecutors = runtime.executors;
export const credentialValidators: CredentialValidators = runtime.credentialValidators;
