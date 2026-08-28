import type { DatabaseBackend, DatabaseIdentity } from "./executors.ts";
import type { DatabaseConnectionConfig, DatabaseScalar, Page, QueryResult } from "./runtime.ts";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

import mysql from "mysql2/promise";
import {
  assertDatabaseEgress,
  assertReadOnlySql,
  boundedQueryResult,
  credentialPoolKey,
  databaseScanBudgetBytes,
  databaseScanBudgetRows,
  DatabaseRuntimeError,
  normalizeDatabaseError,
  quoteIdentifier,
  readDatabaseConfig,
} from "./runtime.ts";

interface MysqlBackendOptions {
  service: "mysql" | "doris" | "starrocks";
  engine: "MySQL" | "Apache Doris" | "StarRocks";
  defaultPort: number;
  defaultDatabase: string;
  versionMatches: (version: string) => boolean;
  identityQuery?: string;
  identityVersionField?: string;
}

interface ReadSessionOptions {
  enforceScanBudget?: boolean;
  maxRows?: number;
}

const pools = new Map<string, { credentialKey: string; pool: Pool }>();
let shutdownRegistered = false;

export async function createMysqlWireBackend(
  values: Record<string, string>,
  options: MysqlBackendOptions,
  signal?: AbortSignal,
): Promise<DatabaseBackend> {
  const config = readDatabaseConfig(values, { port: options.defaultPort, database: options.defaultDatabase });
  await assertDatabaseEgress(config);
  registerShutdown();
  const endpointKey = [options.service, config.host, config.port, config.database, config.username].join("\0");
  const credentialKey = credentialPoolKey(options.service, config);
  let entry = pools.get(endpointKey);
  if (entry?.credentialKey !== credentialKey) {
    await entry?.pool.end().catch(() => undefined);
    entry = undefined;
  }
  if (!entry) {
    const pool = mysql.createPool({
      host: config.host,
      port: config.port,
      database: config.database || undefined,
      user: config.username,
      password: config.password,
      waitForConnections: true,
      connectionLimit: 4,
      maxIdle: 4,
      idleTimeout: 30_000,
      queueLimit: 8,
      connectTimeout: 10_000,
      enableKeepAlive: true,
      multipleStatements: false,
      ssl:
        config.tls === "disable"
          ? undefined
          : {
              rejectUnauthorized: config.tls === "verify-full",
              ca: config.caCertificate,
            },
    });
    entry = { credentialKey, pool };
    pools.set(endpointKey, entry);
  }
  return new MysqlWireBackend(config, entry.pool, options, signal);
}

class MysqlWireBackend implements DatabaseBackend {
  readonly config: DatabaseConnectionConfig;
  private readonly pool: Pool;
  private readonly options: MysqlBackendOptions;
  private readonly signal?: AbortSignal;

  constructor(config: DatabaseConnectionConfig, pool: Pool, options: MysqlBackendOptions, signal?: AbortSignal) {
    this.config = config;
    this.pool = pool;
    this.options = options;
    this.signal = signal;
  }

  async validate(): Promise<DatabaseIdentity> {
    const [rows] = await this.readSession(
      "select database() as current_database, version() as version, @@version_comment as version_comment",
      [],
      10_000,
    );
    const row = (rows as RowDataPacket[])[0];
    let version = String(row?.version ?? "");
    const fingerprint = `${version} ${String(row?.version_comment ?? "")}`;
    if (!this.options.versionMatches(fingerprint)) {
      throw new DatabaseRuntimeError(
        "database_query_failed",
        `Connected server did not identify as ${this.options.engine}.`,
      );
    }
    if (this.options.identityQuery) {
      const [identityRows] = await this.readSession(this.options.identityQuery, [], 10_000);
      const identity = (identityRows as RowDataPacket[])[0];
      if (!identity) {
        throw new DatabaseRuntimeError(
          "database_query_failed",
          `Connected server did not return ${this.options.engine} identity metadata.`,
        );
      }
      if (this.options.identityVersionField) {
        version = String(identity[this.options.identityVersionField] ?? version);
      }
    }
    return { engine: this.options.engine, version, database: String(row?.current_database ?? this.config.database) };
  }

  async listDatabases(page: Page): Promise<Array<{ name: string }>> {
    const [rows] = await this.readSession(
      `select schema_name as name from information_schema.schemata
        order by schema_name limit ${page.pageSize} offset ${page.offset}`,
      [],
    );
    return (rows as RowDataPacket[]).map((row) => ({ name: String(row.name) }));
  }

  async listSchemas(database: string | undefined, page: Page) {
    const selected = database ?? this.config.database;
    const [rows] = await this.readSession(
      `select schema_name as name from information_schema.schemata
        where (? = '' or schema_name = ?)
        order by schema_name limit ${page.pageSize} offset ${page.offset}`,
      [selected, selected],
    );
    return (rows as RowDataPacket[]).map((row) => ({ database: String(row.name), name: String(row.name) }));
  }

  async listTables(database: string | undefined, schema: string | undefined, page: Page) {
    const selected = schema ?? database ?? this.config.database;
    const [rows] = await this.readSession(
      `select table_schema as \`database\`, table_schema as \`schema\`, table_name as name,
              case when table_type = 'VIEW' then 'view' else 'table' end as type
        from information_schema.tables
        where (? = '' or table_schema = ?)
        order by table_schema, table_name limit ${page.pageSize} offset ${page.offset}`,
      [selected, selected],
    );
    return (rows as RowDataPacket[]).map((row) => ({
      database: String(row.database),
      schema: String(row.schema),
      name: String(row.name),
      type: row.type === "view" ? ("view" as const) : ("table" as const),
    }));
  }

  async describeTable(database: string | undefined, schema: string | undefined, table: string) {
    const selected = schema ?? database ?? this.config.database;
    const [rows] = await this.readSession(
      `select column_name as name, column_type as dataType, is_nullable = 'YES' as nullable,
              ordinal_position as ordinal, column_default as defaultValue
         from information_schema.columns
        where table_schema = ? and table_name = ?
        order by ordinal_position`,
      [selected, table],
    );
    return {
      database: selected,
      schema: selected,
      table,
      columns: (rows as RowDataPacket[]).map((row) => ({
        name: String(row.name),
        dataType: String(row.dataType),
        nullable: Boolean(row.nullable),
        ordinal: Number(row.ordinal),
        defaultValue: row.defaultValue == null ? null : String(row.defaultValue),
      })),
    };
  }

  async previewTable(database: string | undefined, schema: string | undefined, table: string, page: Page) {
    const selected = schema ?? database ?? this.config.database;
    const sql = `select * from ${quoteIdentifier(selected, "backtick")}.${quoteIdentifier(table, "backtick")} limit ${page.pageSize + 1} offset ${page.offset}`;
    const [rows, fields] = await this.readSession(sql, [], 30_000, {
      enforceScanBudget: true,
      maxRows: page.pageSize + 1,
    });
    return boundedQueryResult(
      rows as Record<string, unknown>[],
      fields.map((field) => ({
        name: field.name,
        dataType: field.typeName ?? (field.type == null ? null : String(field.type)),
      })),
      page.pageSize,
      10 * 1024 * 1024,
    );
  }

  async executeReadQuery(
    query: string,
    parameters: DatabaseScalar[],
    limits: { maxRows: number; timeoutMs: number; maxBytes: number },
  ): Promise<QueryResult> {
    assertReadOnlySql(query, "mysql");
    const bounded = `select * from (${stripFinalSemicolon(query)}) as openconnector_read limit ${limits.maxRows + 1}`;
    const [rows, fields] = await this.readSession(bounded, parameters, limits.timeoutMs, {
      enforceScanBudget: true,
      maxRows: limits.maxRows + 1,
    });
    return boundedQueryResult(
      rows as Record<string, unknown>[],
      fields.map((field) => ({
        name: field.name,
        dataType: field.typeName ?? (field.type == null ? null : String(field.type)),
      })),
      limits.maxRows,
      limits.maxBytes,
    );
  }

  private async readSession(
    sql: string,
    parameters: DatabaseScalar[],
    timeoutMs = 30_000,
    options: ReadSessionOptions = {},
  ): Promise<Awaited<ReturnType<PoolConnection["execute"]>>> {
    let connection: PoolConnection | undefined;
    const abort = (): void => connection?.destroy();
    this.signal?.addEventListener("abort", abort, { once: true });
    try {
      connection = await this.pool.getConnection();
      if (this.options.service === "mysql") {
        await connection.query("SET SESSION TRANSACTION READ ONLY");
        await connection.query("START TRANSACTION READ ONLY");
      } else {
        await assertMysqlWireReadOnlyPrincipal(connection, this.options.engine);
      }
      if (this.options.service !== "mysql") {
        await configureAnalyticalSession(connection, timeoutMs, options.maxRows);
      }
      if (options.enforceScanBudget) {
        await assertMysqlScanBudget(connection, sql, parameters, timeoutMs, this.options.service);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          connection.execute({ sql, timeout: timeoutMs }, parameters),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              connection?.destroy();
              reject(new DatabaseRuntimeError("database_timeout", "Database request timed out."));
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (error) {
      throw normalizeDatabaseError(error);
    } finally {
      if (this.options.service === "mysql") {
        await connection?.query("ROLLBACK").catch(() => undefined);
      }
      connection?.release();
      this.signal?.removeEventListener("abort", abort);
    }
  }
}

async function assertMysqlScanBudget(
  connection: PoolConnection,
  sql: string,
  parameters: DatabaseScalar[],
  timeoutMs: number,
  service: MysqlBackendOptions["service"] = "mysql",
): Promise<void> {
  if (service !== "mysql") {
    const [rows] = await queryWithTimeout(connection, `EXPLAIN ${sql}`, parameters, timeoutMs);
    const explanation = (rows as RowDataPacket[])
      .flatMap((row) => Object.values(row))
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    const estimates = [...explanation.matchAll(/\bcardinality\s*=\s*([0-9]+)/gi)].map((match) => Number(match[1]));
    if (estimates.some((estimate) => estimate > databaseScanBudgetRows)) {
      throw new DatabaseRuntimeError(
        "database_budget_exceeded",
        `${service === "doris" ? "Doris" : "StarRocks"} query exceeds the configured scan row budget.`,
      );
    }
    return;
  }
  const [rows] = await queryWithTimeout(connection, `EXPLAIN FORMAT=JSON ${sql}`, parameters, timeoutMs);
  const raw = Object.values((rows as RowDataPacket[])[0] ?? {})[0];
  if (typeof raw !== "string") return;
  let plan: unknown;
  try {
    plan = JSON.parse(raw) as unknown;
  } catch {
    return;
  }
  if (maximumEstimatedRows(plan) > databaseScanBudgetRows) {
    throw new DatabaseRuntimeError("database_budget_exceeded", "MySQL query exceeds the configured scan row budget.");
  }
}

async function queryWithTimeout(
  connection: PoolConnection,
  sql: string,
  parameters: DatabaseScalar[],
  timeoutMs: number,
): Promise<Awaited<ReturnType<PoolConnection["query"]>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      connection.query(sql, parameters),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          connection.destroy();
          reject(new DatabaseRuntimeError("database_timeout", "Database request timed out."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function configureAnalyticalSession(
  connection: PoolConnection,
  timeoutMs: number,
  maxRows: number | undefined,
): Promise<void> {
  const timeoutSeconds = Math.max(1, Math.ceil(Math.min(timeoutMs, 30_000) / 1000));
  await connection.query(`SET SESSION query_timeout = ${timeoutSeconds}`);
  await connection.query(`SET SESSION exec_mem_limit = ${databaseScanBudgetBytes}`);
  if (maxRows !== undefined) {
    await connection.query(`SET SESSION sql_select_limit = ${Math.max(1, Math.min(maxRows, 1000))}`);
  }
}

function maximumEstimatedRows(value: unknown): number {
  if (Array.isArray(value)) return Math.max(0, ...value.map(maximumEstimatedRows));
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  const candidates = ["rows_examined_per_scan", "rows_produced_per_join", "rows"];
  const own = Math.max(0, ...candidates.map((key) => (typeof record[key] === "number" ? record[key] : 0)));
  return Math.max(own, ...Object.values(record).map(maximumEstimatedRows));
}

async function assertMysqlWireReadOnlyPrincipal(connection: PoolConnection, engine: string): Promise<void> {
  const [rows] = await connection.query("SHOW GRANTS");
  const grants = (rows as RowDataPacket[])
    .flatMap((row) => Object.values(row))
    .map(String)
    .join(" ");
  if (/\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|LOAD|ADMIN|NODE|OPERATE)\b/i.test(grants)) {
    throw new DatabaseRuntimeError(
      "database_permission_denied",
      `${engine} credentials must be a minimally privileged read-only account.`,
    );
  }
}

function stripFinalSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, "");
}

function registerShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  const close = (): void => {
    for (const entry of pools.values()) void entry.pool.end();
    pools.clear();
  };
  process.once("beforeExit", close);
  process.once("SIGTERM", close);
}
