import type { DatabaseBackend, DatabaseIdentity } from "../../core/database/executors.ts";
import type { DatabaseConnectionConfig, DatabaseScalar, Page, QueryResult } from "../../core/database/runtime.ts";
import type { ConnectionPool, IResult, Request } from "mssql";

import sql from "mssql";
import {
  assertDatabaseEgress,
  assertReadOnlySql,
  boundedQueryResult,
  credentialPoolKey,
  databaseScanBudgetBytes,
  DatabaseRuntimeError,
  normalizeDatabaseError,
  quoteIdentifier,
  readDatabaseConfig,
} from "../../core/database/runtime.ts";

interface SqlServerConfig extends DatabaseConnectionConfig {
  instanceName?: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
}

const pools = new Map<string, { credentialKey: string; pool: Promise<ConnectionPool> }>();
const activeQueries = new Map<ConnectionPool, number>();
let shutdownRegistered = false;

export async function createSqlServerBackend(
  values: Record<string, string>,
  signal?: AbortSignal,
): Promise<DatabaseBackend> {
  const common = readDatabaseConfig(values, { port: 1433, database: "master" });
  const instanceName = values.instanceName?.trim() || undefined;
  if (instanceName && values.port?.trim()) {
    throw new DatabaseRuntimeError(
      "database_network_failed",
      "SQL Server instanceName and explicit port are mutually exclusive.",
    );
  }
  const config: SqlServerConfig = {
    ...common,
    instanceName,
    encrypt: readBoolean(values.encrypt, common.tls !== "disable"),
    trustServerCertificate: readBoolean(values.trustServerCertificate, common.tls === "require"),
  };
  if (config.encrypt !== (config.tls !== "disable")) {
    throw new DatabaseRuntimeError(
      "database_tls_failed",
      "SQL Server encrypt must be false for tls=disable and true for tls=require or tls=verify-full.",
    );
  }
  if (config.tls === "verify-full" && config.trustServerCertificate) {
    throw new DatabaseRuntimeError(
      "database_tls_failed",
      "SQL Server trustServerCertificate=true is incompatible with tls=verify-full.",
    );
  }
  await assertDatabaseEgress(config);
  registerShutdown();
  const endpointKey = [config.host, config.port, config.database, config.username, config.instanceName ?? ""].join(
    "\0",
  );
  const credentialKey = credentialPoolKey(
    "sql_server",
    config,
    `${config.instanceName ?? ""}:${config.encrypt}:${config.trustServerCertificate}`,
  );
  let entry = pools.get(endpointKey);
  if (entry?.credentialKey !== credentialKey) {
    await entry?.pool.then((item) => item.close()).catch(() => undefined);
    entry = undefined;
  }
  if (!entry) {
    const pool = new sql.ConnectionPool({
      server: config.host,
      port: config.instanceName ? undefined : config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      pool: { min: 0, max: 4, idleTimeoutMillis: 30_000 },
      connectionTimeout: 10_000,
      requestTimeout: 30_000,
      options: {
        instanceName: config.instanceName,
        encrypt: config.encrypt,
        trustServerCertificate: config.trustServerCertificate,
        ...(config.caCertificate ? { cryptoCredentialsDetails: { ca: config.caCertificate } } : {}),
        enableArithAbort: true,
        appName: "OpenConnector",
      },
    })
      .connect()
      .catch((error) => {
        pools.delete(endpointKey);
        throw error;
      });
    entry = { credentialKey, pool };
    pools.set(endpointKey, entry);
  }
  const backend = new SqlServerBackend(config, await entry.pool, signal);
  await backend.assertReadOnlyPrincipal();
  return backend;
}

class SqlServerBackend implements DatabaseBackend {
  readonly config: SqlServerConfig;
  private readonly pool: ConnectionPool;
  private readonly signal?: AbortSignal;

  constructor(config: SqlServerConfig, pool: ConnectionPool, signal?: AbortSignal) {
    this.config = config;
    this.pool = pool;
    this.signal = signal;
  }

  async validate(): Promise<DatabaseIdentity> {
    await this.assertReadOnlyPrincipal();
    const result = await this.query(
      "select db_name() as [database], cast(serverproperty('ProductVersion') as nvarchar(128)) as version",
      [],
      10_000,
    );
    const row = result.recordset[0] as Record<string, unknown> | undefined;
    return {
      engine: "Microsoft SQL Server",
      version: String(row?.version ?? ""),
      database: String(row?.database ?? this.config.database),
    };
  }

  async listDatabases(page: Page): Promise<Array<{ name: string }>> {
    const result = await this.query(
      `select name from sys.databases
        where state_desc = 'ONLINE' and has_dbaccess(name) = 1
        order by name offset @p1 rows fetch next @p2 rows only`,
      [page.offset, page.pageSize],
    );
    return result.recordset.map((row) => ({ name: String((row as Record<string, unknown>).name) }));
  }

  async listSchemas(database: string | undefined, page: Page) {
    this.assertCurrentDatabase(database);
    const result = await this.query(
      `select db_name() as [database], name
         from sys.schemas order by name
         offset @p1 rows fetch next @p2 rows only`,
      [page.offset, page.pageSize],
    );
    return result.recordset.map((row) => {
      const item = row as Record<string, unknown>;
      return { database: String(item.database), name: String(item.name) };
    });
  }

  async listTables(database: string | undefined, schema: string | undefined, page: Page) {
    this.assertCurrentDatabase(database);
    const result = await this.query(
      `select db_name() as [database], s.name as [schema], o.name,
              case when o.type = 'V' then 'view' else 'table' end as type
         from sys.objects o join sys.schemas s on s.schema_id = o.schema_id
        where o.type in ('U', 'V') and (@p1 is null or s.name = @p1)
        order by s.name, o.name offset @p2 rows fetch next @p3 rows only`,
      [schema ?? null, page.offset, page.pageSize],
    );
    return result.recordset.map((row) => {
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
    const selectedSchema = schema ?? "dbo";
    const result = await this.query(
      `select c.name, type_name(c.user_type_id) as dataType, c.is_nullable as nullable,
              c.column_id as ordinal, object_definition(c.default_object_id) as defaultValue
         from sys.columns c
         join sys.objects o on o.object_id = c.object_id
         join sys.schemas s on s.schema_id = o.schema_id
        where s.name = @p1 and o.name = @p2 order by c.column_id`,
      [selectedSchema, table],
    );
    return {
      database: this.config.database,
      schema: selectedSchema,
      table,
      columns: result.recordset.map((row) => {
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
    const selectedSchema = schema ?? "dbo";
    const query = `select * from ${quoteIdentifier(selectedSchema, "bracket")}.${quoteIdentifier(table, "bracket")}
      order by (select null) offset @p1 rows fetch next @p2 rows only`;
    const result = await this.query(query, [page.offset, page.pageSize + 1], 30_000, true);
    return this.toResult(result, page.pageSize, 10 * 1024 * 1024);
  }

  async executeReadQuery(
    query: string,
    parameters: DatabaseScalar[],
    limits: { maxRows: number; timeoutMs: number; maxBytes: number },
  ): Promise<QueryResult> {
    assertReadOnlySql(query, "transactsql");
    const bounded = `select top (${limits.maxRows + 1}) * from (${stripFinalSemicolon(query)}) as openconnector_read`;
    return this.toResult(
      await this.query(bounded, parameters, limits.timeoutMs, true),
      limits.maxRows,
      limits.maxBytes,
    );
  }

  async assertReadOnlyPrincipal(): Promise<void> {
    const result = await this.query(
      `select
         has_perms_by_name(db_name(), 'DATABASE', 'INSERT') as can_insert,
         has_perms_by_name(db_name(), 'DATABASE', 'UPDATE') as can_update,
         has_perms_by_name(db_name(), 'DATABASE', 'DELETE') as can_delete,
         has_perms_by_name(db_name(), 'DATABASE', 'ALTER') as can_alter,
         case when exists (
           select 1
             from sys.objects o
             cross apply sys.fn_my_permissions(
               quotename(schema_name(o.schema_id)) + '.' + quotename(o.name),
               'OBJECT'
             ) p
            where p.permission_name in (
              'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'CONTROL', 'TAKE OWNERSHIP',
              'EXECUTE', 'REFERENCES'
            )
         ) then 1 else 0 end as can_write_object`,
      [],
      10_000,
    );
    const row = result.recordset[0] as Record<string, unknown> | undefined;
    if (
      ["can_insert", "can_update", "can_delete", "can_alter", "can_write_object"].some(
        (key) => Number(row?.[key]) === 1,
      )
    ) {
      throw new DatabaseRuntimeError(
        "database_permission_denied",
        "SQL Server credentials must be a minimally privileged read-only principal.",
      );
    }
  }

  private async query(
    text: string,
    parameters: DatabaseScalar[],
    timeoutMs = 30_000,
    enforceScanBudget = false,
  ): Promise<IResult<Record<string, unknown>>> {
    const active = activeQueries.get(this.pool) ?? 0;
    if (active >= 12) {
      throw new DatabaseRuntimeError("database_budget_exceeded", "SQL Server connection queue limit exceeded.");
    }
    activeQueries.set(this.pool, active + 1);
    const request: Request = this.pool.request();
    parameters.forEach((value, index) => request.input(`p${index + 1}`, value));
    const abort = (): void => request.cancel();
    const timer = setTimeout(abort, timeoutMs);
    this.signal?.addEventListener("abort", abort, { once: true });
    try {
      const boundedText = enforceScanBudget
        ? `SET QUERY_GOVERNOR_COST_LIMIT ${Math.max(1, Math.floor(databaseScanBudgetBytes / 1024 / 1024))}; ${text}`
        : text;
      return (await request.query(boundedText)) as IResult<Record<string, unknown>>;
    } catch (error) {
      throw normalizeDatabaseError(error);
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", abort);
      const remaining = (activeQueries.get(this.pool) ?? 1) - 1;
      if (remaining > 0) activeQueries.set(this.pool, remaining);
      else activeQueries.delete(this.pool);
    }
  }

  private toResult(result: IResult<Record<string, unknown>>, maxRows: number, maxBytes: number): QueryResult {
    const columns = Object.values(result.recordset.columns ?? {}).map((column) => ({
      name: column.name,
      dataType: readSqlServerTypeName(column.type),
    }));
    return boundedQueryResult(result.recordset, columns, maxRows, maxBytes);
  }

  private assertCurrentDatabase(database: string | undefined): void {
    if (database && database !== this.config.database) {
      throw new DatabaseRuntimeError(
        "database_query_rejected",
        "Cross-database discovery requires a separate SQL Server connection.",
      );
    }
  }
}

function readSqlServerTypeName(value: unknown): string | null {
  if (value && typeof value === "object" && "name" in value && typeof value.name === "string") {
    return value.name;
  }
  if (typeof value === "function" && value.name) {
    return value.name;
  }
  return null;
}

function stripFinalSemicolon(query: string): string {
  return query.trim().replace(/;\s*$/, "");
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new DatabaseRuntimeError("database_tls_failed", "Boolean connection option is invalid.");
}

function registerShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  const close = (): void => {
    for (const entry of pools.values()) void entry.pool.then((item) => item.close()).catch(() => undefined);
    pools.clear();
  };
  process.once("beforeExit", close);
  process.once("SIGTERM", close);
}
