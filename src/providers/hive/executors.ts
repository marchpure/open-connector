import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { createDatabaseProviderRuntime } from "../../core/database/executors.ts";
import { createHiveBackend } from "./runtime.ts";

const runtime = createDatabaseProviderRuntime("hive", createHiveBackend);
export const executors: ProviderExecutors = runtime.executors;
export const credentialValidators: CredentialValidators = runtime.credentialValidators;
