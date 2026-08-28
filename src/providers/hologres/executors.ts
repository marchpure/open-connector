import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { createDatabaseProviderRuntime } from "../../core/database/executors.ts";
import { createHologresBackend } from "./runtime.ts";

const runtime = createDatabaseProviderRuntime("hologres", createHologresBackend);
export const executors: ProviderExecutors = runtime.executors;
export const credentialValidators: CredentialValidators = runtime.credentialValidators;
