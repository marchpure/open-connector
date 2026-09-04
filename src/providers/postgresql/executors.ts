import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type {
  DatabaseAdapter,
  DatabaseCredentials,
  DatabaseProfile,
  DatabaseQueryResult,
  DatabaseSchema,
} from "../database-runtime.ts";
import type { Pool, PoolConfig } from "pg";

import { createDatabaseCredentialValidators, createDatabaseExecutors, limitRows } from "../database-runtime.ts";

const service = "postgresql";

export const executors: ProviderExecutors = createDatabaseExecutors({
  service,
  displayName: "PostgreSQL",
  defaultPort: 5432,
  adapter: createPostgresAdapter(),
});

export const credentialValidators: CredentialValidators = createDatabaseCredentialValidators(
  {
    service,
    displayName: "PostgreSQL",
    defaultPort: 5432,
    adapter: createPostgresAdapter(),
  },
  5432,
);

export function createPostgresAdapter(
  createPool: (config: PoolConfig) => Pool | Promise<Pool> = defaultCreatePool,
): DatabaseAdapter {
  return {
    async validate(credentials, signal): Promise<DatabaseProfile> {
      const pool = await createPoolConfig(credentials, createPool);
      try {
        const result = await pool.query<{ current_database: string; current_user: string }>(
          withAbort("select current_database(), current_user", signal),
        );
        const row = result.rows[0];
        return {
          displayName: `${row?.current_user ?? credentials.username}@${credentials.host}/${row?.current_database ?? credentials.database}`,
        };
      } finally {
        await pool.end();
      }
    },
    async discover(credentials, input, signal): Promise<DatabaseSchema> {
      const pool = await createPoolConfig(credentials, createPool);
      try {
        const [tables, columns] = await Promise.all([
          pool.query(
            withAbort(
              `select table_schema as schema, table_name as name, table_type as type
               from information_schema.tables
               where table_schema not in ('pg_catalog', 'information_schema')
                 and ($1::text is null or table_schema = $1)
                 and ($2::text is null or table_name = $2)
               order by table_schema, table_name
               limit $3`,
              signal,
              [input.schema ?? null, input.table ?? null, input.limit],
            ),
          ),
          pool.query(
            withAbort(
              `select table_schema as schema, table_name as table, column_name as name,
                      data_type as "dataType", is_nullable = 'YES' as nullable,
                      ordinal_position as "ordinalPosition"
               from information_schema.columns
               where table_schema not in ('pg_catalog', 'information_schema')
                 and ($1::text is null or table_schema = $1)
                 and ($2::text is null or table_name = $2)
               order by table_schema, table_name, ordinal_position
               limit $3`,
              signal,
              [input.schema ?? null, input.table ?? null, input.limit],
            ),
          ),
        ]);
        return { tables: tables.rows, columns: columns.rows };
      } finally {
        await pool.end();
      }
    },
    async query(credentials, input, signal): Promise<DatabaseQueryResult> {
      const pool = await createPoolConfig(credentials, createPool);
      try {
        const result = await pool.query(withAbort(`${input.sql} limit ${input.maxRows + 1}`, signal, input.parameters));
        return limitRows(result.rows, input.maxRows);
      } finally {
        await pool.end();
      }
    },
  };
}

async function createPoolConfig(
  credentials: DatabaseCredentials,
  createPool: (config: PoolConfig) => Pool | Promise<Pool>,
): Promise<Pool> {
  return await createPool({
    host: credentials.host,
    port: credentials.port,
    database: credentials.database,
    user: credentials.username,
    password: credentials.password,
    ssl: credentials.ssl ? { rejectUnauthorized: true } : false,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
}

function withAbort(text: string, signal: AbortSignal | undefined, values: unknown[] = []) {
  return { text, values, signal };
}

async function defaultCreatePool(config: PoolConfig): Promise<Pool> {
  const { Pool: PgPool } = await import("pg");
  return new PgPool(config);
}
