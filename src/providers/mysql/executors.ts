import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type {
  DatabaseAdapter,
  DatabaseColumn,
  DatabaseCredentials,
  DatabaseDiscoveryInput,
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

const service = "mysql";

export const executors: ProviderExecutors = createDatabaseExecutors({
  service,
  displayName: "MySQL",
  defaultPort: 3306,
  adapter: createMysqlAdapter(),
});

export const credentialValidators: CredentialValidators = createDatabaseCredentialValidators(
  {
    service,
    displayName: "MySQL",
    defaultPort: 3306,
    adapter: createMysqlAdapter(),
  },
  3306,
);

interface MysqlConnection {
  execute<T = unknown[]>(sql: string, parameters?: unknown[]): Promise<[T]>;
  end(): Promise<void>;
}

interface Mysql2PromiseModule {
  createConnection(options: Record<string, unknown>): Promise<MysqlConnection>;
}

export function createMysqlAdapter(
  createConnection: (options: Record<string, unknown>) => Promise<MysqlConnection> = defaultCreateConnection,
): DatabaseAdapter {
  return {
    async validate(credentials, signal): Promise<DatabaseProfile> {
      const connection = await openConnection(credentials, createConnection);
      try {
        throwIfAborted(signal);
        const [rows] = await connection.execute<Array<{ database_name: string; user_name: string }>>(
          "select database() as database_name, current_user() as user_name",
        );
        const row = rows[0];
        return {
          displayName: `${row?.user_name ?? credentials.username}@${credentials.host}/${row?.database_name ?? credentials.database}`,
        };
      } finally {
        await connection.end();
      }
    },
    async discover(credentials, input, signal): Promise<DatabaseSchema> {
      const connection = await openConnection(credentials, createConnection);
      try {
        throwIfAborted(signal);
        const filters = discoveryWhere(input);
        const [tables] = await connection.execute(
          `select table_schema as \`schema\`, table_name as name, table_type as type
           from information_schema.tables
           where table_schema not in ('information_schema', 'mysql', 'performance_schema', 'sys')${filters.sql}
           order by table_schema, table_name
           limit ?`,
          [...filters.parameters, input.limit],
        );
        const [columns] = await connection.execute(
          `select table_schema as \`schema\`, table_name as \`table\`, column_name as name,
                  data_type as dataType, is_nullable = 'YES' as nullable,
                  ordinal_position as ordinalPosition
           from information_schema.columns
           where table_schema not in ('information_schema', 'mysql', 'performance_schema', 'sys')${filters.sql}
           order by table_schema, table_name, ordinal_position
           limit ?`,
          [...filters.parameters, input.limit],
        );
        return { tables: rowsArray<DatabaseTable>(tables), columns: rowsArray<DatabaseColumn>(columns) };
      } finally {
        await connection.end();
      }
    },
    async query(credentials, input, signal): Promise<DatabaseQueryResult> {
      const connection = await openConnection(credentials, createConnection);
      try {
        throwIfAborted(signal);
        const [rows] = await connection.execute(`${input.sql} limit ${input.maxRows + 1}`, input.parameters);
        return limitRows(rowsArray(rows), input.maxRows);
      } finally {
        await connection.end();
      }
    },
  };
}

async function openConnection(
  credentials: DatabaseCredentials,
  createConnection: (options: Record<string, unknown>) => Promise<MysqlConnection>,
): Promise<MysqlConnection> {
  return createConnection({
    host: credentials.host,
    port: credentials.port,
    database: credentials.database,
    user: credentials.username,
    password: credentials.password,
    ssl: credentials.ssl ? {} : undefined,
  });
}

async function defaultCreateConnection(options: Record<string, unknown>): Promise<MysqlConnection> {
  const mysql = await loadOptionalModule<Mysql2PromiseModule>("mysql2/promise", "mysql2");
  return mysql.createConnection(options);
}

function discoveryWhere(input: DatabaseDiscoveryInput): { sql: string; parameters: unknown[] } {
  const clauses: string[] = [];
  const parameters: unknown[] = [];
  if (input.schema) {
    clauses.push("table_schema = ?");
    parameters.push(input.schema);
  }
  if (input.table) {
    clauses.push("table_name = ?");
    parameters.push(input.table);
  }
  return { sql: clauses.length > 0 ? ` and ${clauses.join(" and ")}` : "", parameters };
}

function rowsArray<T = unknown>(rows: unknown): T[] {
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}
