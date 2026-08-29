import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { createDatabaseProviderRuntime } from "../../core/database/executors.ts";
import { createTrinoBackend } from "./runtime.ts";

const runtime = createDatabaseProviderRuntime("trino", createTrinoBackend);
export const executors: ProviderExecutors = runtime.executors;
export const credentialValidators: CredentialValidators = runtime.credentialValidators;
