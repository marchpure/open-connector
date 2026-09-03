import type { DatabaseBackend } from "../../core/database/executors.ts";
import type { DatabaseConnectionConfig } from "../../core/database/runtime.ts";
import type { ExecutionActor, ExecutionResult } from "../../core/types.ts";

import { createHash } from "node:crypto";
import { OracleAdapterError, OracleDatabaseAdapter } from "../../control-plane/oracle-adapter.ts";
import { OracleThinDriver } from "../../control-plane/oracle-driver.ts";
import {
  boundedQueryResult,
  DatabaseRuntimeError,
  assertDatabaseEgress,
  normalizeDatabaseError,
  pageResult,
  quoteIdentifier,
  readDatabaseConfig,
} from "../../core/database/runtime.ts";

const defaultConfig = { port: 1521, database: "FREEPDB1" };

export async function createOracleBackend(
  values: Record<string, string>,
  _signal?: AbortSignal,
  actor?: ExecutionActor,
): Promise<DatabaseBackend> {
  const generic = readDatabaseConfig(values, defaultConfig);
  const serviceName = optional(values.serviceName);
  const sid = optional(values.sid);
  if ((serviceName && sid) || (!serviceName && !sid)) {
    throw new DatabaseRuntimeError("database_network_failed", "Oracle requires exactly one of serviceName or sid.");
  }
  const config = {
    ...generic,
    database: serviceName ?? sid ?? generic.database,
  };
  await assertDatabaseEgress(config);
  const driver = new OracleThinDriver(
    {
      host: config.host,
      port: config.port,
      serviceName,
      sid,
      ...(config.tls === "disable" ? {} : { tls: { rejectUnauthorized: config.tls === "verify-full" } }),
    },
    { user: config.username, password: config.password },
  );
  const allowedSchemas = optional(values.allowedSchemas)
    ?.split(",")
    .map((schema) => schema.trim())
    .filter(Boolean);
  const allowedTables = optional(values.allowedTables)
    ?.split(",")
    .map((table) => table.trim())
    .filter(Boolean);
  const adapter = new OracleDatabaseAdapter(
    driverConfig(config, serviceName, sid),
    driver,
    {
      maxRows: 1000,
      maxBytes: 10 * 1024 * 1024,
      timeoutMs: 30_000,
      maxConcurrent: 2,
      allowedSchemas,
      allowedTables,
    },
    actor ? oracleSessionIdentity(actor) : undefined,
  );
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
    async listDatabases(page) {
      return pageResult([{ name: config.database }], page).items;
    },
    async listSchemas(_database, page) {
      if (!matchesCurrentDatabase(config, _database)) return [];
      const result = await adapter.discover();
      if (!("schemas" in result))
        throw new DatabaseRuntimeError("database_query_failed", "Oracle schema discovery failed.");
      return pageResult(
        result.schemas.map((name) => ({ database: config.database, name })),
        page,
      ).items;
    },
    async listTables(_database, schema, page) {
      if (!matchesCurrentDatabase(config, _database)) return [];
      const selectedSchema = schema ?? allowedSchemas?.[0];
      if (!selectedSchema) return [];
      const result = await adapter.discover({ schema: selectedSchema });
      if (!("tables" in result))
        throw new DatabaseRuntimeError("database_query_failed", "Oracle table discovery failed.");
      return pageResult(
        result.tables.map((name) => ({
          database: config.database,
          schema: selectedSchema,
          name,
          type: "table" as const,
        })),
        page,
      ).items;
    },
    async describeTable(_database, schema, table) {
      assertCurrentDatabase(config, _database);
      const result = await adapter.discover({ schema: schema ?? allowedSchemas?.[0], table });
      if (!("columns" in result))
        throw new DatabaseRuntimeError("database_query_failed", "Oracle table description failed.");
      return {
        database: config.database,
        schema: result.schema,
        table: result.table,
        columns: result.columns.map((column) => ({
          ...column,
          defaultValue: null,
        })),
      };
    },
    async previewTable(_database, schema, table, page) {
      assertCurrentDatabase(config, _database);
      const schemaName = schema ?? allowedSchemas?.[0];
      if (!schemaName) throw new DatabaseRuntimeError("database_query_rejected", "Oracle schema is required.");
      const sql = `select * from ${quoteIdentifier(schemaName, "double")}.${quoteIdentifier(table, "double")} offset :offset rows fetch next :limit rows only`;
      const result = await adapter.query(
        sql,
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
    async executeReadQuery(query, parameters, limits) {
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

function oracleSessionIdentity(actor: ExecutionActor): { clientId: string; clientInfo: string } {
  return {
    clientId: boundedOracleTraceValue(actor.userId),
    clientInfo: boundedOracleTraceValue(`agent=${actor.agentId ?? "unknown"};subject=${actor.subject}`),
  };
}

function boundedOracleTraceValue(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= 64) return value;
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 57)}`;
}

export function mapOracleDatabaseError(error: unknown): ExecutionResult {
  if (error instanceof OracleAdapterError) {
    if (error.code === "query_failed") {
      const mapped = normalizeDatabaseError(error.cause ?? error);
      return { ok: false, error: { code: mapped.code, message: mapped.message } };
    }
    const code =
      error.code === "write_query" || error.code === "invalid_config"
        ? "database_query_rejected"
        : error.code === "schema_denied"
          ? "database_permission_denied"
          : error.code === "query_limit"
            ? "database_budget_exceeded"
            : "database_query_failed";
    const mapped = new DatabaseRuntimeError(
      code,
      code === "database_query_rejected"
        ? "Only parameterized read-only SELECT/WITH queries are allowed."
        : code === "database_permission_denied"
          ? "Database permission denied."
          : "Database scan budget exceeded.",
    );
    return { ok: false, error: { code: mapped.code, message: mapped.message } };
  }
  const mapped = normalizeDatabaseError(error);
  return { ok: false, error: { code: mapped.code, message: mapped.message } };
}

function driverConfig(config: DatabaseConnectionConfig, serviceName?: string, sid?: string) {
  return {
    host: config.host,
    port: config.port,
    ...(serviceName ? { serviceName } : {}),
    ...(sid ? { sid } : {}),
  };
}

function assertCurrentDatabase(config: DatabaseConnectionConfig, database: string | undefined): void {
  if (!matchesCurrentDatabase(config, database)) {
    throw new DatabaseRuntimeError(
      "database_query_rejected",
      "Cross-database access requires a separate Oracle connection.",
    );
  }
}

function matchesCurrentDatabase(config: DatabaseConnectionConfig, database: string | undefined): boolean {
  return !database || database.trim().toLowerCase() === config.database.toLowerCase();
}

function optional(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
