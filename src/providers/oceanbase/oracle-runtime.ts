import "../../oracledb.d.ts";
import type { DatabaseBackend, DatabaseIdentity } from "../../core/database/executors.ts";
import type { DatabaseConnectionConfig, DatabaseScalar, Page, QueryResult } from "../../core/database/runtime.ts";
import type { Connection, Pool, PoolAttributes } from "oracledb";

import oracledb from "oracledb";
import {
  assertDatabaseEgress,
  assertReadOnlySql,
  boundedQueryResult,
  credentialPoolKey,
  DatabaseRuntimeError,
  normalizeDatabaseError,
  quoteIdentifier,
  readDatabaseConfig,
} from "../../core/database/runtime.ts";

const pools = new Map<string, { credentialKey: string; pool: Pool }>();

export async function createOceanbaseOracleBackend(
  values: Record<string, string>,
  signal?: AbortSignal,
): Promise<DatabaseBackend> {
  const config = readDatabaseConfig(values, { port: 2881, database: "SYS" });
  await assertDatabaseEgress(config);
  const endpointKey = [config.host, config.port, config.database, config.username].join("\0");
  const credentialKey = credentialPoolKey("oceanbase-oracle", config);
  let entry = pools.get(endpointKey);
  if (entry?.credentialKey !== credentialKey) {
    await entry?.pool.close(0).catch(() => undefined);
    entry = undefined;
  }
  if (!entry) {
    const attributes: PoolAttributes = {
      user: config.username,
      password: config.password,
      connectString: buildConnectString(config),
      poolMin: 0,
      poolMax: 4,
      poolIncrement: 1,
      homogeneous: true,
    };
    entry = { credentialKey, pool: await oracledb.createPool(attributes) };
    pools.set(endpointKey, entry);
  }
  return new OceanbaseOracleBackend(config, entry.pool, signal);
}

class OceanbaseOracleBackend implements DatabaseBackend {
  readonly config: DatabaseConnectionConfig;
  private readonly pool: Pool;
  private readonly signal?: AbortSignal;

  constructor(config: DatabaseConnectionConfig, pool: Pool, signal?: AbortSignal) {
    this.config = config;
    this.pool = pool;
    this.signal = signal;
  }

  async validate(): Promise<DatabaseIdentity> {
    const result = await this.read("select version() as VERSION from dual", {}, 1, 10_000);
    const version = String(result.rows[0]?.VERSION ?? result.rows[0]?.version ?? "");
    if (!/oceanbase/i.test(version)) {
      throw new DatabaseRuntimeError("database_query_failed", "Connected server did not identify as OceanBase.");
    }
    return { engine: "OceanBase Oracle mode", version, database: this.config.database };
  }

  async listDatabases(_page: Page): Promise<Array<{ name: string }>> {
    return [{ name: this.config.database }];
  }

  async listSchemas(database: string | undefined, page: Page) {
    this.assertCurrentDatabase(database);
    const result = await this.read(
      "select username as NAME from all_users order by username offset :offset rows fetch next :limit rows only",
      { offset: page.offset, limit: page.pageSize },
      page.pageSize,
    );
    return result.rows.map((row) => ({ database: this.config.database, name: String(row.NAME ?? row.name ?? "") }));
  }

  async listTables(database: string | undefined, schema: string | undefined, page: Page) {
    this.assertCurrentDatabase(database);
    const owner = (schema ?? this.config.username).toUpperCase();
    const result = await this.read(
      `select OWNER, OBJECT_NAME, OBJECT_TYPE from all_objects
        where owner = :owner and object_type in ('TABLE', 'VIEW')
        order by object_name offset :offset rows fetch next :limit rows only`,
      { owner, offset: page.offset, limit: page.pageSize },
      page.pageSize,
    );
    return result.rows.map((row) => ({
      database: this.config.database,
      schema: String(row.OWNER ?? row.owner ?? owner),
      name: String(row.OBJECT_NAME ?? row.object_name ?? ""),
      type: String(row.OBJECT_TYPE ?? row.object_type) === "VIEW" ? ("view" as const) : ("table" as const),
    }));
  }

  async describeTable(database: string | undefined, schema: string | undefined, table: string) {
    this.assertCurrentDatabase(database);
    const owner = (schema ?? this.config.username).toUpperCase();
    const result = await this.read(
      `select COLUMN_NAME, DATA_TYPE, NULLABLE, COLUMN_ID, DATA_DEFAULT
         from all_tab_columns where owner = :owner and table_name = :tableName order by column_id`,
      { owner, tableName: table.toUpperCase() },
      1000,
    );
    return {
      database: this.config.database,
      schema: owner,
      table,
      columns: result.rows.map((row) => ({
        name: String(row.COLUMN_NAME ?? row.column_name ?? ""),
        dataType: String(row.DATA_TYPE ?? row.data_type ?? ""),
        nullable: String(row.NULLABLE ?? row.nullable) === "Y",
        ordinal: Number(row.COLUMN_ID ?? row.column_id),
        defaultValue:
          (row.DATA_DEFAULT ?? row.data_default == null) ? null : String(row.DATA_DEFAULT ?? row.data_default),
      })),
    };
  }

  previewTable(database: string | undefined, schema: string | undefined, table: string, page: Page) {
    this.assertCurrentDatabase(database);
    const owner = schema ?? this.config.username;
    return this.read(
      `select * from ${quoteIdentifier(owner, "double")}.${quoteIdentifier(table, "double")} offset :offset rows fetch next :limit rows only`,
      { offset: page.offset, limit: page.pageSize + 1 },
      page.pageSize,
    );
  }

  executeReadQuery(
    query: string,
    parameters: DatabaseScalar[],
    limits: { maxRows: number; timeoutMs: number; maxBytes: number },
  ): Promise<QueryResult> {
    assertReadOnlySql(normalizeParametersForParser(query), "postgresql");
    const { sql, binds } = bindOracleParameters(query, parameters);
    return this.read(sql, binds, limits.maxRows, limits.timeoutMs, limits.maxBytes);
  }

  private async read(
    sql: string,
    binds: Record<string, unknown>,
    maxRows: number,
    timeoutMs = 30_000,
    maxBytes = 10 * 1024 * 1024,
  ): Promise<QueryResult> {
    let connection: Connection | undefined;
    const abort = (): void => {
      void connection?.close().catch(() => undefined);
    };
    this.signal?.addEventListener("abort", abort, { once: true });
    try {
      connection = await this.pool.getConnection();
      await connection.execute("SET TRANSACTION READ ONLY");
      const result = await withTimeout(
        connection.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: maxRows + 1 }),
        timeoutMs,
      );
      return boundedQueryResult(
        (result.rows ?? []) as Record<string, unknown>[],
        (result.metaData ?? []).map((column) => ({
          name: column.name,
          dataType: column.dbTypeName ?? null,
        })),
        maxRows,
        maxBytes,
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    } finally {
      await connection?.rollback().catch(() => undefined);
      await connection?.close().catch(() => undefined);
      this.signal?.removeEventListener("abort", abort);
    }
  }

  private assertCurrentDatabase(database: string | undefined): void {
    if (database && database !== this.config.database) {
      throw new DatabaseRuntimeError(
        "database_permission_denied",
        "Cross-database access requires a separate OceanBase connection.",
      );
    }
  }
}

function buildConnectString(config: DatabaseConnectionConfig): string {
  const protocol = config.tls === "disable" ? "tcp" : "tcps";
  return `${protocol}://${formatHost(config.host)}:${config.port}/${encodeURIComponent(config.database)}`;
}

function bindOracleParameters(
  sql: string,
  parameters: DatabaseScalar[],
): { sql: string; binds: Record<string, DatabaseScalar> } {
  let index = 0;
  const binds: Record<string, DatabaseScalar> = {};
  const output = rewritePlaceholders(sql, () => {
    if (index >= parameters.length) {
      throw new DatabaseRuntimeError("database_query_rejected", "OceanBase query has an unbound parameter.");
    }
    const name = `p${index}`;
    binds[name] = parameters[index++]!;
    return `:${name}`;
  });
  if (index !== parameters.length) {
    throw new DatabaseRuntimeError("database_query_rejected", "OceanBase query has unused parameters.");
  }
  return { sql: output, binds };
}

function normalizeParametersForParser(sql: string): string {
  return rewritePlaceholders(sql, () => "NULL");
}

function rewritePlaceholders(sql: string, replacement: () => string): string {
  let quote: "'" | '"' | undefined;
  let output = "";
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    if (quote) {
      output += char;
      if (char === quote) {
        if (sql[index + 1] === char) output += sql[++index];
        else quote = undefined;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      output += char;
    } else {
      output += char === "?" ? replacement() : char;
    }
  }
  return output;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new DatabaseRuntimeError("database_timeout", "OceanBase query timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
