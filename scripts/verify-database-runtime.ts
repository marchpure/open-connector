import type { CredentialValidators, ExecutionContext, ExecutionResult, ProviderExecutors } from "../src/core/types.ts";
import type { DatabaseCredentials } from "../src/providers/database-runtime.ts";

interface DatabaseTarget {
  service: "postgresql" | "mysql" | "oracle_database";
  displayName: string;
  modulePath: string;
  defaultPort: number;
  discoverInput: Record<string, unknown>;
  queryInput: Record<string, unknown>;
}

interface ProviderModule {
  credentialValidators: CredentialValidators;
  executors: ProviderExecutors;
}

const targets: DatabaseTarget[] = [
  {
    service: "postgresql",
    displayName: "PostgreSQL",
    modulePath: "../src/providers/postgresql/executors.ts",
    defaultPort: 5432,
    discoverInput: { schema: "public", limit: 5 },
    queryInput: { sql: "select 1 as ok", maxRows: 1 },
  },
  {
    service: "mysql",
    displayName: "MySQL",
    modulePath: "../src/providers/mysql/executors.ts",
    defaultPort: 3306,
    discoverInput: { limit: 5 },
    queryInput: { sql: "select 1 as ok", maxRows: 1 },
  },
  {
    service: "oracle_database",
    displayName: "Oracle Database",
    modulePath: "../src/providers/oracle_database/executors.ts",
    defaultPort: 1521,
    discoverInput: { limit: 5 },
    queryInput: { sql: "select 1 as ok from dual", maxRows: 1 },
  },
];

const results: unknown[] = [];

for (const target of targets) {
  const credentials = readCredentials(target);
  const module = (await import(target.modulePath)) as ProviderModule;
  const validation = await module.credentialValidators.customCredential?.(
    { values: credentialsToValues(credentials) },
    { fetcher: fetch, signal: undefined },
  );
  if (!validation?.profile) {
    throw new Error(`${target.service} validation did not return a credential profile`);
  }
  const context = executionContext(target.service, credentials);
  const discover = await runAction(
    module.executors,
    `${target.service}.discover_schema`,
    target.discoverInput,
    context,
  );
  const query = await runAction(module.executors, `${target.service}.query_readonly`, target.queryInput, context);

  results.push({
    service: target.service,
    displayName: target.displayName,
    validate: {
      displayName: validation?.profile.displayName,
      grantedScopes: validation?.grantedScopes,
    },
    discover: summarizeResult(discover, "tables", "columns"),
    query: summarizeResult(query, "rows"),
  });
}

console.log(JSON.stringify({ ok: true, checks: results }, null, 2));

function readCredentials(target: DatabaseTarget): DatabaseCredentials {
  const prefix = `VERIFY_${target.service.toUpperCase()}`;
  return {
    host: requiredEnv(`${prefix}_HOST`),
    port: Number(process.env[`${prefix}_PORT`] ?? target.defaultPort),
    database: requiredEnv(`${prefix}_DATABASE`),
    username: requiredEnv(`${prefix}_USERNAME`),
    password: requiredEnv(`${prefix}_PASSWORD`),
    ssl: process.env[`${prefix}_SSL`] === "true",
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required fixture environment variable: ${name}`);
  }
  return value;
}

function credentialsToValues(credentials: DatabaseCredentials): Record<string, string> {
  return {
    host: credentials.host,
    port: String(credentials.port),
    database: credentials.database,
    username: credentials.username,
    password: credentials.password,
    ssl: String(credentials.ssl),
  };
}

function executionContext(service: string, credentials: DatabaseCredentials): ExecutionContext {
  return {
    async getCredential(requestedService) {
      if (requestedService !== service) {
        return undefined;
      }
      return {
        authType: "custom_credential",
        values: credentialsToValues(credentials),
        profile: {
          accountId: `${credentials.username}@${credentials.host}:${credentials.port}/${credentials.database}`,
          displayName: `${credentials.username}@${credentials.host}/${credentials.database}`,
          grantedScopes: ["read"],
        },
        metadata: {},
      };
    },
  };
}

async function runAction(
  executors: ProviderExecutors,
  actionId: `${string}.${string}`,
  input: Record<string, unknown>,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const executor = executors[actionId];
  if (!executor) {
    throw new Error(`Missing executor: ${actionId}`);
  }
  const result = await executor(input, context);
  if (!result.ok) {
    throw new Error(`${actionId} failed: ${JSON.stringify(result.error)}`);
  }
  return result;
}

function summarizeResult(result: ExecutionResult, ...arrayKeys: string[]): Record<string, unknown> {
  const output = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>) : {};
  return {
    ok: result.ok,
    ...Object.fromEntries(
      arrayKeys.map((key) => [key, Array.isArray(output[key]) ? (output[key] as unknown[]).length : undefined]),
    ),
  };
}
