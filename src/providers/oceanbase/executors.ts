import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { createDatabaseProviderRuntime } from "../../core/database/executors.ts";
import { createOceanbaseBackend } from "./runtime.ts";

const runtime = createDatabaseProviderRuntime("oceanbase", createOceanbaseBackend);
export const executors: ProviderExecutors = runtime.executors;
export const credentialValidators: CredentialValidators = runtime.credentialValidators;
