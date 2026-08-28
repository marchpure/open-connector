import type { DatabaseBackend, DatabaseIdentity } from "../../core/database/executors.ts";
import type { DatabaseConnectionConfig, DatabaseScalar, Page, QueryResult } from "../../core/database/runtime.ts";
import type { Pool, PoolClient, QueryResult as PgQueryResult } from "pg";

import pg from "pg";
import {
  assertDatabaseEgress,
  assertReadOnlySql,
  boundedQueryResult,
  credentialPoolKey,
  databaseScanBudgetRows,
  DatabaseRuntimeError,
  normalizeDatabaseError,
  quoteIdentifier,
  readDatabaseConfig,
} from "../../core/database/runtime.ts";

const pools = new Map<string, { credentialKey: string; pool: Pool }>();
let shutdownRegistered = false;

export interface PostgresqlWireBackendOptions {
  service: "postgresql" | "hologres";
  engine: "PostgreSQL" | "Hologres";
  defaultPort: number;
  defaultDatabase: string;
  versionMatches: (version: string) => boolean;
  identityQuery?: string;
}

export async function createPostgresqlBackend(
  values: Record<string, string>,
  signal?: AbortSignal,
): Promise<DatabaseBackend> {
  return createPostgresqlWireBackend(
    values,
    {
      service: "postgresql",
      engine: "PostgreSQL",
      defaultPort: 5432,
      defaultDatabase: "postgres",
      versionMatches: (version) => !/hologres/i.test(version),
    },
    signal,
  );
}

export async function createPostgresqlWireBackend(
  values: Record<string, string>,
  options: PostgresqlWireBackendOptions,
  signal?: AbortSignal,
): Promise<DatabaseBackend> {
  const config = readDatabaseConfig(values, {
    port: options.defaultPort,
    database: options.defaultDatabase,
  });
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
    const pool = new pg.Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      max: 4,
      min: 0,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      ssl:
        config.tls === "disable"
          ? false
          : {
              rejectUnauthorized: config.tls === "verify-full",
              ca: config.caCertificate,
            },
    });
    // Server restarts can terminate an idle client outside an active query.
    // Consuming the pool event keeps the process alive so the next checkout reconnects.
    pool.on("error", () => undefined);
    entry = { credentialKey, pool };
    pools.set(endpointKey, entry);
  }
  return new PostgresqlBackend(config, entry.pool, options, signal);
}

class PostgresqlBackend implements DatabaseBackend {
  readonly config: DatabaseConnectionConfig;
  private readonly pool: Pool;
  private readonly options: PostgresqlWireBackendOptions;
  private readonly signal?: AbortSignal;

  constructor(
    config: DatabaseConnectionConfig,
    pool: Pool,
    options: PostgresqlWireBackendOptions,
    signal?: AbortSignal,
  ) {
    this.config = config;
    this.pool = pool;
    this.options = options;
    this.signal = signal;
  }

  async validate(): Promise<DatabaseIdentity> {
    const result = await this.readTransaction(
      "select current_database() as database, version() as version",
      [],
      10_000,
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    let version = String(row?.version ?? "");
    if (this.options.identityQuery) {
      const identityResult = await this.readTransaction(this.options.identityQuery, [], 10_000);
      version = String((identityResult.rows[0] as Record<string, unknown> | undefined)?.version ?? "");
    }
    if (!this.options.versionMatches(version)) {
      throw new DatabaseRuntimeError(
        "database_query_failed",
        `Connected server did not identify as ${this.options.engine}.`,
      );
    }
    return {
      engine: this.options.engine,
      version,
      database: String(row?.database ?? this.config.database),
    };
  }

  async listDatabases(page: Page): Promise<Array<{ name: string }>> {
    const result = await this.readTransaction(
      "select datname as name from pg_database where datallowconn and not datistemplate order by datname limit $1 offset $2",
      [page.pageSize, page.offset],
    );
    return result.rows.map((row) => ({ name: String((row as Record<string, unknown>).name) }));
  }

  async listSchemas(database: string | undefined, page: Page) {
    this.assertCurrentDatabase(database);
    const result = await this.readTransaction(
      `select current_database() as database, schema_name as name
         from information_schema.schemata
        order by schema_name limit $1 offset $2`,
      [page.pageSize, page.offset],
    );
    return result.rows.map((row) => {
      const item = row as Record<string, unknown>;
      return { database: String(item.database), name: String(item.name) };
    });
  }

  async listTables(database: string | undefined, schema: string | undefined, page: Page) {
    this.assertCurrentDatabase(database);
    const result = await this.readTransaction(
      `select table_catalog as database, table_schema as schema, table_name as name,
              case when table_type = 'VIEW' then 'view' else 'table' end as type
         from information_schema.tables
        where ($1::text is null or table_schema = $1)
        order by table_schema, table_name limit $2 offset $3`,
      [schema ?? null, page.pageSize, page.offset],
    );
    return result.rows.map((row) => {
      const item = row as Record<string, unknown>;
      return {
        database: String(item.database),
        schema: String(item.schema),
        name: String(item.name),
        type: item.type === "view" ? ("view" as const) : ("table" as const),
      };
    });
  }

  async describeTable(database: string | undefined, schema: string | undefined, table: string) {
    this.assertCurrentDatabase(database);
    const resolvedSchema = schema ?? "public";
    const result = await this.readTransaction(
      `select column_name as name, data_type as "dataType", is_nullable = 'YES' as nullable,
              ordinal_position as ordinal, column_default as "defaultValue"
         from information_schema.columns
        where table_catalog = current_database() and table_schema = $1 and table_name = $2
        order by ordinal_position`,
      [resolvedSchema, table],
    );
    return {
      database: this.config.database,
      schema: resolvedSchema,
      table,
      columns: result.rows.map((row) => {
        const item = row as Record<string, unknown>;
        return {
          name: String(item.name),
          dataType: String(item.dataType),
          nullable: Boolean(item.nullable),
          ordinal: Number(item.ordinal),
          defaultValue: item.defaultValue == null ? null : String(item.defaultValue),
        };
      }),
    };
  }

  async previewTable(database: string | undefined, schema: string | undefined, table: string, page: Page) {
    this.assertCurrentDatabase(database);
    const sql = `select * from ${quoteIdentifier(schema ?? "public", "double")}.${quoteIdentifier(table, "double")} limit $1 offset $2`;
    const result = await this.readTransaction(sql, [page.pageSize + 1, page.offset]);
    return this.toResult(result, page.pageSize, 10 * 1024 * 1024);
  }

  async executeReadQuery(
    query: string,
    parameters: DatabaseScalar[],
    limits: { maxRows: number; timeoutMs: number; maxBytes: number },
  ) {
    assertReadOnlySql(query, "postgresql");
    const bounded = `select * from (${stripFinalSemicolon(query)}) as openconnector_read limit ${limits.maxRows + 1}`;
    const result = await this.readTransaction(bounded, parameters, limits.timeoutMs, true);
    return this.toResult(result, limits.maxRows, limits.maxBytes);
  }

  private async readTransaction(
    sql: string,
    parameters: DatabaseScalar[],
    timeoutMs = 30_000,
    enforceScanBudget = false,
  ): Promise<PgQueryResult> {
    let client: PoolClient | undefined;
    const abort = (): void => client?.release(true);
    this.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (this.pool.waitingCount >= 8) {
        throw new DatabaseRuntimeError(
          "database_budget_exceeded",
          `${this.options.engine} connection queue limit exceeded.`,
        );
      }
      client = await this.pool.connect();
      await client.query("begin read only");
      await client.query(`set local statement_timeout = ${Math.max(100, Math.min(timeoutMs, 30_000))}`);
      if (enforceScanBudget) {
        await assertPostgresqlScanBudget(client, sql, parameters);
      }
      return await client.query(sql, parameters);
    } catch (error) {
      throw normalizeDatabaseError(error);
    } finally {
      await client?.query("rollback").catch(() => undefined);
      client?.release();
      this.signal?.removeEventListener("abort", abort);
    }
  }

  private toResult(result: PgQueryResult, maxRows: number, maxBytes: number): QueryResult {
    return boundedQueryResult(
      result.rows as Record<string, unknown>[],
      result.fields.map((field) => ({ name: field.name, dataType: String(field.dataTypeID) })),
      maxRows,
      maxBytes,
    );
  }

  private assertCurrentDatabase(database: string | undefined): void {
    if (database && database !== this.config.database) {
      throw normalizeDatabaseError(new Error("Cross-database discovery requires a separate PostgreSQL connection."));
    }
  }
}

async function assertPostgresqlScanBudget(
  client: PoolClient,
  sql: string,
  parameters: DatabaseScalar[],
): Promise<void> {
  const explain = await client.query({
    text: `EXPLAIN (FORMAT JSON) ${sql}`,
    values: parameters,
  });
  const document = explain.rows[0]?.["QUERY PLAN"];
  const plan = Array.isArray(document) ? document[0] : document;
  if (maximumPlanRows(plan) > databaseScanBudgetRows) {
    throw new DatabaseRuntimeError(
      "database_budget_exceeded",
      "PostgreSQL query exceeds the configured scan row budget.",
    );
  }
}

function maximumPlanRows(value: unknown): number {
  if (Array.isArray(value)) return Math.max(0, ...value.map(maximumPlanRows));
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  const own = typeof record["Plan Rows"] === "number" ? record["Plan Rows"] : 0;
  return Math.max(own, ...Object.values(record).map(maximumPlanRows));
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
