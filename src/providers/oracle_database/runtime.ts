import type { DatabaseBackend } from "../../core/database/executors.ts";
import type { DatabaseConnectionConfig, DatabaseScalar, Page } from "../../core/database/runtime.ts";
import type { ExecutionResult } from "../../core/types.ts";

import { OracleAdapterError, OracleDatabaseAdapter } from "../../control-plane/oracle-adapter.ts";
import { OracleThinDriver } from "../../control-plane/oracle-driver.ts";
import {
  assertDatabaseEgress,
  boundedQueryResult,
  credentialPoolKey,
  DatabaseRuntimeError,
  normalizeDatabaseError,
  pageResult,
  quoteIdentifier,
  readDatabaseConfig,
} from "../../core/database/runtime.ts";

const defaults = { port: 1521, database: "FREEPDB1" };
const pools = new Map<string, { credentialKey: string; driver: OracleThinDriver }>();
let shutdownRegistered = false;

export async function createOracleBackend(values: Record<string, string>): Promise<DatabaseBackend> {
  const serviceName = optional(values.serviceName);
  if (!serviceName) {
    throw new DatabaseRuntimeError("database_query_rejected", "Oracle requires a serviceName.");
  }
  const generic = readDatabaseConfig({ ...values, database: serviceName }, defaults);
  const config: DatabaseConnectionConfig = {
    ...generic,
    database: serviceName,
  };
  await assertDatabaseEgress(config);
  registerShutdown();
  const endpointKey = ["oracle_database", config.host, config.port, config.database, config.username].join("\0");
  const credentialKey = credentialPoolKey("oracle_database", config, serviceName);
  let entry = pools.get(endpointKey);
  if (entry?.credentialKey !== credentialKey) {
    await entry?.driver.close();
    pools.delete(endpointKey);
    entry = undefined;
  }
  if (!entry) {
    entry = {
      credentialKey,
      driver: new OracleThinDriver(
        {
          host: config.host,
          port: config.port,
          serviceName,
          ...(config.tls === "disable" ? {} : { tls: { rejectUnauthorized: config.tls === "verify-full" } }),
        },
        { user: config.username, password: config.password },
      ),
    };
    pools.set(endpointKey, entry);
  }
  const driver = entry.driver;
  const allowedSchemas = optional(values.allowedSchemas)
    ?.split(",")
    .map((schema) => schema.trim())
    .filter(Boolean);
  const adapter = new OracleDatabaseAdapter({ host: config.host, port: config.port, serviceName }, driver, {
    maxRows: 1001,
    maxBytes: 10 * 1024 * 1024,
    timeoutMs: 30_000,
    maxConcurrent: 4,
    allowedSchemas,
  });

  return {
    config,
    async validate() {
      const result = await adapter.query("select banner as version from v$version where rownum = 1");
      const row = (result.rows[0] ?? {}) as Record<string, unknown>;
      return {
        engine: "Oracle Database",
        version: String(row.VERSION ?? row.version ?? ""),
        database: config.database,
      };
    },
    async listDatabases(page: Page) {
      return pageResult([{ name: config.database }], page).items;
    },
    async listSchemas(database: string | undefined, page: Page) {
      assertCurrentDatabase(config, database);
      const result = await adapter.discover();
      if (!("schemas" in result))
        throw new DatabaseRuntimeError("database_query_failed", "Oracle schema discovery failed.");
      return pageResult(
        result.schemas.map((name) => ({ database: config.database, name })),
        page,
      ).items;
    },
    async listTables(database: string | undefined, schema: string | undefined, page: Page) {
      assertCurrentDatabase(config, database);
      const selectedSchema = schema ?? (allowedSchemas?.length === 1 ? allowedSchemas[0] : undefined);
      if (!selectedSchema) throw new DatabaseRuntimeError("database_query_rejected", "Oracle schema is required.");
      const result = await adapter.discover({ schema: selectedSchema });
      if (!("tables" in result))
        throw new DatabaseRuntimeError("database_query_failed", "Oracle table discovery failed.");
      return pageResult(
        result.tables.map((name) => ({
          database: config.database,
          schema: result.schema,
          name,
          type: "table" as const,
        })),
        page,
      ).items;
    },
    async describeTable(database: string | undefined, schema: string | undefined, table: string) {
      assertCurrentDatabase(config, database);
      const selectedSchema = schema ?? (allowedSchemas?.length === 1 ? allowedSchemas[0] : undefined);
      if (!selectedSchema) throw new DatabaseRuntimeError("database_query_rejected", "Oracle schema is required.");
      const result = await adapter.discover({ schema: selectedSchema, table });
      if (!("columns" in result))
        throw new DatabaseRuntimeError("database_query_failed", "Oracle table description failed.");
      return {
        database: config.database,
        schema: result.schema,
        table: result.table,
        columns: result.columns.map((column) => ({ ...column, defaultValue: null })),
      };
    },
    async previewTable(database: string | undefined, schema: string | undefined, table: string, page: Page) {
      assertCurrentDatabase(config, database);
      const selectedSchema = schema ?? (allowedSchemas?.length === 1 ? allowedSchemas[0] : undefined);
      if (!selectedSchema) throw new DatabaseRuntimeError("database_query_rejected", "Oracle schema is required.");
      const result = await adapter.query(
        `select * from ${quoteIdentifier(selectedSchema, "double")}.${quoteIdentifier(table, "double")} offset :offset rows fetch next :limit rows only`,
        { offset: page.offset, limit: page.pageSize + 1 },
        { maxRows: page.pageSize + 1 },
      );
      return boundedQueryResult(
        result.rows as Record<string, unknown>[],
        result.columns ?? [],
        page.pageSize,
        10 * 1024 * 1024,
      );
    },
    async executeReadQuery(query: string, parameters: DatabaseScalar[], limits) {
      const result = await adapter.query(
        query,
        Object.fromEntries(parameters.map((value, index) => [`p${index + 1}`, value])),
        { maxRows: limits.maxRows + 1, maxBytes: limits.maxBytes, timeoutMs: limits.timeoutMs },
      );
      return boundedQueryResult(
        result.rows as Record<string, unknown>[],
        result.columns ?? [],
        limits.maxRows,
        limits.maxBytes,
      );
    },
  };
}

export function mapOracleDatabaseError(error: unknown): ExecutionResult {
  if (error instanceof OracleAdapterError) {
    if (error.code === "query_failed") return mapOracleDatabaseError(error.cause ?? error);
    const code =
      error.code === "write_query" || error.code === "invalid_config"
        ? "database_query_rejected"
        : error.code === "schema_denied"
          ? "database_permission_denied"
          : error.code === "query_limit"
            ? "database_budget_exceeded"
            : "database_query_failed";
    return {
      ok: false,
      error: {
        code,
        message:
          code === "database_query_rejected"
            ? "Only parameterized read-only SELECT/WITH queries are allowed."
            : code === "database_permission_denied"
              ? "Database permission denied."
              : code === "database_budget_exceeded"
                ? "Database scan budget exceeded."
                : "Database query failed.",
      },
    };
  }
  const oracleCode = String((error as { code?: unknown })?.code ?? "");
  const oracleMessage = String((error as { message?: unknown })?.message ?? "");
  if (
    /ORA-00942/i.test(`${oracleCode} ${oracleMessage}`) &&
    /"SYS"\."(?:DBA_USERS|USER\$|OBJ\$|V_\$SESSION|V_\$PARAMETER)"/i.test(oracleMessage)
  ) {
    return {
      ok: false,
      error: { code: "database_permission_denied", message: "Database permission denied." },
    };
  }
  const mapped = normalizeDatabaseError(error);
  return { ok: false, error: { code: mapped.code, message: mapped.message } };
}

export async function closeOraclePools(): Promise<void> {
  const entries = [...pools.values()];
  pools.clear();
  await Promise.all(entries.map((entry) => entry.driver.close()));
}

function assertCurrentDatabase(config: DatabaseConnectionConfig, database: string | undefined): void {
  if (database && database.trim().toLowerCase() !== config.database.toLowerCase()) {
    throw new DatabaseRuntimeError(
      "database_query_rejected",
      "Cross-database access requires a separate Oracle connection.",
    );
  }
}

function optional(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function registerShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  process.once("beforeExit", () => {
    void closeOraclePools();
  });
}
