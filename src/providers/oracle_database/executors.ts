import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type {
  DatabaseAdapter,
  DatabaseColumn,
  DatabaseCredentials,
  DatabaseProfile,
  DatabaseQueryResult,
  DatabaseSchema,
  DatabaseTable,
} from "../database-runtime.ts";

import {
  createDatabaseCredentialValidators,
  createDatabaseExecutors,
  limitRows,
  loadOptionalModule,
} from "../database-runtime.ts";

const service = "oracle_database";

export const executors: ProviderExecutors = createDatabaseExecutors({
  service,
  displayName: "Oracle Database",
  defaultPort: 1521,
  adapter: createOracleAdapter(),
});

export const credentialValidators: CredentialValidators = createDatabaseCredentialValidators(
  {
    service,
    displayName: "Oracle Database",
    defaultPort: 1521,
    adapter: createOracleAdapter(),
  },
  1521,
);

interface OracleResult<T> {
  rows?: T[];
}

interface OracleConnection {
  execute<T = unknown>(sql: string, binds?: unknown[], options?: Record<string, unknown>): Promise<OracleResult<T>>;
  close(): Promise<void>;
}

interface OracleDbModule {
  OUT_FORMAT_OBJECT: number;
  getConnection(options: Record<string, unknown>): Promise<OracleConnection>;
}

interface OracleColumnRow extends Omit<DatabaseColumn, "nullable"> {
  nullable?: string | boolean;
}

export function createOracleAdapter(loadOracle: () => Promise<OracleDbModule> = defaultLoadOracle): DatabaseAdapter {
  return {
    async validate(credentials, signal): Promise<DatabaseProfile> {
      const oracle = await loadOracle();
      const connection = await openConnection(oracle, credentials);
      try {
        throwIfAborted(signal);
        const result = await connection.execute<{ CURRENT_SCHEMA: string; CURRENT_USER: string }>(
          "select sys_context('USERENV', 'CURRENT_SCHEMA') as current_schema, user as current_user from dual",
          [],
          { outFormat: oracle.OUT_FORMAT_OBJECT },
        );
        const row = result.rows?.[0];
        return {
          displayName: `${row?.CURRENT_USER ?? credentials.username}@${credentials.host}/${row?.CURRENT_SCHEMA ?? credentials.database}`,
        };
      } finally {
        await connection.close();
      }
    },
    async discover(credentials, input, signal): Promise<DatabaseSchema> {
      const oracle = await loadOracle();
      const connection = await openConnection(oracle, credentials);
      try {
        throwIfAborted(signal);
        const [tables, columns] = await Promise.all([
          connection.execute<DatabaseTable>(
            `select owner as "schema", table_name as "name", 'TABLE' as "type"
             from all_tables
             where (:schema_name is null or owner = :schema_name)
               and (:table_name is null or table_name = :table_name)
             order by owner, table_name
             fetch first :row_limit rows only`,
            [input.schema?.toUpperCase() ?? null, input.table?.toUpperCase() ?? null, input.limit],
            { outFormat: oracle.OUT_FORMAT_OBJECT },
          ),
          connection.execute<OracleColumnRow>(
            `select owner as "schema", table_name as "table", column_name as "name",
                    data_type as "dataType", nullable as "nullable",
                    column_id as "ordinalPosition"
             from all_tab_columns
             where (:schema_name is null or owner = :schema_name)
               and (:table_name is null or table_name = :table_name)
             order by owner, table_name, column_id
             fetch first :row_limit rows only`,
            [input.schema?.toUpperCase() ?? null, input.table?.toUpperCase() ?? null, input.limit],
            { outFormat: oracle.OUT_FORMAT_OBJECT },
          ),
        ]);
        return { tables: tables.rows ?? [], columns: normalizeOracleColumns(columns.rows ?? []) };
      } finally {
        await connection.close();
      }
    },
    async query(credentials, input, signal): Promise<DatabaseQueryResult> {
      const oracle = await loadOracle();
      const connection = await openConnection(oracle, credentials);
      try {
        throwIfAborted(signal);
        const result = await connection.execute(
          `select * from (${input.sql}) where rownum <= :row_limit`,
          [...input.parameters, input.maxRows + 1],
          { outFormat: oracle.OUT_FORMAT_OBJECT },
        );
        return limitRows(result.rows ?? [], input.maxRows);
      } finally {
        await connection.close();
      }
    },
  };
}

async function openConnection(oracle: OracleDbModule, credentials: DatabaseCredentials): Promise<OracleConnection> {
  return oracle.getConnection({
    user: credentials.username,
    password: credentials.password,
    connectString: `${credentials.host}:${credentials.port}/${credentials.database}`,
  });
}

async function defaultLoadOracle(): Promise<OracleDbModule> {
  return loadOptionalModule<OracleDbModule>("oracledb");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function normalizeOracleColumns(rows: OracleColumnRow[]): DatabaseColumn[] {
  return rows.map((row) => ({
    ...row,
    nullable: row.nullable === true || row.nullable === "Y",
  }));
}
