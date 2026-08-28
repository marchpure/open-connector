import type { DatabaseBackend, DatabaseIdentity } from "../../core/database/executors.ts";
import type { DatabaseConnectionConfig, DatabaseScalar, Page, QueryResult } from "../../core/database/runtime.ts";

import hive from "hive-driver";
import {
  assertDatabaseEgress,
  assertReadOnlySql,
  boundedQueryResult,
  DatabaseRuntimeError,
  quoteIdentifier,
  readDatabaseConfig,
} from "../../core/database/runtime.ts";

export async function createHiveBackend(
  values: Record<string, string>,
  signal?: AbortSignal,
): Promise<DatabaseBackend> {
  const config = readDatabaseConfig(values, { port: 10000, database: "default" });
  await assertDatabaseEgress(config);
  const authMode = values.authMode?.trim().toLowerCase();
  if (authMode !== "nosasl" && authMode !== "ldap") {
    throw new DatabaseRuntimeError(
      "database_authentication_failed",
      "Hive authMode must be nosasl or ldap; Kerberos is unavailable without the optional native module.",
    );
  }
  return new HiveBackend(config, authMode, signal);
}

class HiveBackend implements DatabaseBackend {
  readonly config: DatabaseConnectionConfig;
  private readonly authMode: "nosasl" | "ldap";
  private readonly signal?: AbortSignal;

  constructor(config: DatabaseConnectionConfig, authMode: "nosasl" | "ldap", signal?: AbortSignal) {
    this.config = config;
    this.authMode = authMode;
    this.signal = signal;
  }

  async validate(): Promise<DatabaseIdentity> {
    const result = await this.query("SELECT version() AS version", 1, 10_000);
    return { engine: "Apache Hive", version: String(result.rows[0]?.version ?? ""), database: this.config.database };
  }

  async listDatabases(page: Page): Promise<Array<{ name: string }>> {
    const result = await this.query("SHOW DATABASES", page.offset + page.pageSize);
    return result.rows.slice(page.offset).map((row) => ({ name: String(Object.values(row)[0] ?? "") }));
  }

  async listSchemas(database: string | undefined, page: Page) {
    const selected = database ?? this.config.database;
    const databases = await this.listDatabases(page);
    return databases
      .filter((item) => !database || item.name === selected)
      .map((item) => ({ database: item.name, name: item.name }));
  }

  async listTables(database: string | undefined, schema: string | undefined, page: Page) {
    const selected = schema ?? database ?? this.config.database;
    const result = await this.query(
      `SHOW TABLES IN ${quoteIdentifier(selected, "backtick")}`,
      page.offset + page.pageSize,
    );
    return result.rows.slice(page.offset).map((row) => ({
      database: selected,
      schema: selected,
      name: String(Object.values(row)[0] ?? ""),
      type: "table" as const,
    }));
  }

  async describeTable(database: string | undefined, schema: string | undefined, table: string) {
    const selected = schema ?? database ?? this.config.database;
    const result = await this.query(
      `DESCRIBE ${quoteIdentifier(selected, "backtick")}.${quoteIdentifier(table, "backtick")}`,
      1000,
    );
    return {
      database: selected,
      schema: selected,
      table,
      columns: result.rows
        .filter((row) => String(Object.values(row)[0] ?? "").trim() && !String(Object.values(row)[0]).startsWith("#"))
        .map((row, index) => {
          const values = Object.values(row);
          return {
            name: String(values[0] ?? ""),
            dataType: String(values[1] ?? ""),
            nullable: true,
            ordinal: index + 1,
            defaultValue: null,
          };
        }),
    };
  }

  previewTable(database: string | undefined, schema: string | undefined, table: string, page: Page) {
    const selected = schema ?? database ?? this.config.database;
    return this.query(
      `SELECT * FROM ${quoteIdentifier(selected, "backtick")}.${quoteIdentifier(table, "backtick")} LIMIT ${page.pageSize + 1} OFFSET ${page.offset}`,
      page.pageSize,
    );
  }

  async executeReadQuery(
    query: string,
    parameters: DatabaseScalar[],
    limits: { maxRows: number; timeoutMs: number; maxBytes: number },
  ): Promise<QueryResult> {
    assertReadOnlySql(query, "mysql");
    return this.query(bindHiveParameters(query, parameters), limits.maxRows, limits.timeoutMs, limits.maxBytes);
  }

  private async query(sql: string, maxRows: number, timeoutMs = 30_000, maxBytes = 10 * 1024 * 1024) {
    const client = new hive.HiveClient(hive.thrift.TCLIService, hive.thrift.TCLIService_types);
    let operation:
      | {
          setMaxRows(value: number): void;
          cancel(): Promise<unknown>;
          close(): Promise<unknown>;
        }
      | undefined;
    let timedOut = false;
    const abort = (): void => {
      void operation?.cancel().catch(() => undefined);
      client.close();
    };
    this.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => {
        timedOut = true;
        abort();
      },
      Math.min(Math.max(timeoutMs, 100), 30_000),
    );
    try {
      await client.connect(
        {
          host: this.config.host,
          port: this.config.port,
          options: {
            connect_timeout: 10_000,
            timeout: timeoutMs,
            ssl: this.config.tls !== "disable",
            ca: this.config.caCertificate,
          },
        },
        new hive.connections.TcpConnection(),
        this.authMode === "nosasl"
          ? new hive.auth.NoSaslAuthentication()
          : new hive.auth.PlainTcpAuthentication({
              username: this.config.username,
              password: this.config.password,
            }),
      );
      const session = await client.openSession({
        client_protocol: hive.thrift.TCLIService_types.TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V10,
        configuration: {
          "hive.server2.thrift.resultset.max.fetch.size": String(maxRows + 1),
          "hive.fetch.task.conversion": "minimal",
        },
      });
      const hiveOperation = await session.executeStatement(sql, { runAsync: true });
      operation = hiveOperation;
      operation.setMaxRows(maxRows + 1);
      const utils = new hive.HiveUtils(hive.thrift.TCLIService_types);
      await utils.waitUntilReady(hiveOperation, false);
      await utils.fetchAll(hiveOperation);
      const rows = utils.getResult(hiveOperation).getValue() as Record<string, unknown>[];
      const names = rows.length > 0 ? Object.keys(rows[0]!) : [];
      return boundedQueryResult(
        rows,
        names.map((name) => ({ name, dataType: null })),
        maxRows,
        maxBytes,
      );
    } catch (error) {
      if (timedOut || this.signal?.aborted) {
        throw new DatabaseRuntimeError("database_timeout", "Hive query timed out or was cancelled.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      await operation?.close().catch(() => undefined);
      client.close();
      this.signal?.removeEventListener("abort", abort);
    }
  }
}

function bindHiveParameters(sql: string, parameters: DatabaseScalar[]): string {
  let index = 0;
  let quote: "'" | '"' | "`" | undefined;
  let output = "";
  for (let offset = 0; offset < sql.length; offset += 1) {
    const char = sql[offset]!;
    if (quote) {
      output += char;
      if (char === quote) {
        if (sql[offset + 1] === char) output += sql[++offset];
        else quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      output += char;
    } else if (char === "?") {
      if (index >= parameters.length) {
        throw new DatabaseRuntimeError("database_query_rejected", "Hive query has an unbound parameter.");
      }
      output += toHiveLiteral(parameters[index++]!);
    } else {
      output += char;
    }
  }
  if (index !== parameters.length) {
    throw new DatabaseRuntimeError("database_query_rejected", "Hive query has unused parameters.");
  }
  return output;
}

function toHiveLiteral(value: DatabaseScalar): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new DatabaseRuntimeError("database_query_rejected", "Invalid numeric parameter.");
    return String(value);
  }
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
