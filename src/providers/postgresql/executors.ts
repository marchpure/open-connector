import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { createDatabaseProviderRuntime } from "../../core/database/executors.ts";
import { createPostgresqlBackend } from "./runtime.ts";

const runtime = createDatabaseProviderRuntime("postgresql", createPostgresqlBackend);

export const executors: ProviderExecutors = runtime.executors;
export const credentialValidators: CredentialValidators = runtime.credentialValidators;
