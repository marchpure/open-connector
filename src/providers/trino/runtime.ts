import type { DatabaseBackend, DatabaseIdentity } from "../../core/database/executors.ts";
import type { DatabaseConnectionConfig, DatabaseScalar, Page, QueryResult } from "../../core/database/runtime.ts";

import { Buffer } from "node:buffer";
import {
  assertDatabaseEgress,
  assertReadOnlySql,
  boundedQueryResult,
  DatabaseRuntimeError,
  quoteIdentifier,
  readDatabaseConfig,
} from "../../core/database/runtime.ts";
import { isPrivateNetworkAccessAllowed, readBoundedResponseBytes } from "../../core/request.ts";
import { createProviderFetch } from "../provider-runtime.ts";

interface TrinoColumn {
  name?: unknown;
  type?: unknown;
}

interface TrinoPage {
  id?: unknown;
  nextUri?: unknown;
  data?: unknown;
  columns?: unknown;
  error?: { message?: unknown; errorName?: unknown };
}

const trinoFetch = createProviderFetch({ allowPrivateNetwork: isPrivateNetworkAccessAllowed });

export async function createTrinoBackend(
  values: Record<string, string>,
  signal?: AbortSignal,
): Promise<DatabaseBackend> {
  const config = readDatabaseConfig(values, { port: 8443, database: "system" });
  await assertDatabaseEgress(config);
  const authMode = values.authMode?.trim().toLowerCase();
  if (authMode !== "none" && authMode !== "basic") {
    throw new DatabaseRuntimeError("database_authentication_failed", "Trino authMode must be none or basic.");
  }
  if (authMode === "basic" && config.tls === "disable") {
    throw new DatabaseRuntimeError("database_tls_failed", "Trino Basic authentication requires TLS.");
  }
  return new TrinoBackend(config, values.schema?.trim() || "information_schema", authMode, signal);
}

class TrinoBackend implements DatabaseBackend {
  readonly config: DatabaseConnectionConfig;
  private readonly schema: string;
  private readonly authMode: "none" | "basic";
  private readonly signal?: AbortSignal;

  constructor(config: DatabaseConnectionConfig, schema: string, authMode: "none" | "basic", signal?: AbortSignal) {
    this.config = config;
    this.schema = schema;
    this.authMode = authMode;
    this.signal = signal;
  }

  async validate(): Promise<DatabaseIdentity> {
    const result = await this.query("SELECT version() AS version", 1, 10_000);
    return {
      engine: "Trino",
      version: String(result.rows[0]?.version ?? ""),
      database: this.config.database,
    };
  }

  async listDatabases(page: Page): Promise<Array<{ name: string }>> {
    const result = await this.query("SHOW CATALOGS", page.offset + page.pageSize);
    return result.rows.slice(page.offset).map((row) => ({ name: String(Object.values(row)[0] ?? "") }));
  }

  async listSchemas(database: string | undefined, page: Page) {
    const catalog = database ?? this.config.database;
    const result = await this.query(
      `SHOW SCHEMAS FROM ${quoteIdentifier(catalog, "double")}`,
      page.offset + page.pageSize,
    );
    return result.rows.slice(page.offset).map((row) => ({
      database: catalog,
      name: String(Object.values(row)[0] ?? ""),
    }));
  }

  async listTables(database: string | undefined, schema: string | undefined, page: Page) {
    const catalog = database ?? this.config.database;
    const selectedSchema = schema ?? this.schema;
    const result = await this.query(
      `SELECT table_catalog, table_schema, table_name, table_type
         FROM ${quoteIdentifier(catalog, "double")}.information_schema.tables
        WHERE table_schema = ${toTrinoLiteral(selectedSchema)}
        ORDER BY table_name`,
      page.offset + page.pageSize,
    );
    return result.rows.slice(page.offset).map((row) => ({
      database: String(row.table_catalog),
      schema: String(row.table_schema),
      name: String(row.table_name),
      type: String(row.table_type).toUpperCase().includes("VIEW") ? ("view" as const) : ("table" as const),
    }));
  }

  async describeTable(database: string | undefined, schema: string | undefined, table: string) {
    const catalog = database ?? this.config.database;
    const selectedSchema = schema ?? this.schema;
    const result = await this.query(
      `SELECT column_name, data_type, is_nullable, ordinal_position, column_default
         FROM ${quoteIdentifier(catalog, "double")}.information_schema.columns
        WHERE table_schema = ${toTrinoLiteral(selectedSchema)}
          AND table_name = ${toTrinoLiteral(table)}
        ORDER BY ordinal_position`,
      1000,
    );
    return {
      database: catalog,
      schema: selectedSchema,
      table,
      columns: result.rows.map((row) => ({
        name: String(row.column_name),
        dataType: String(row.data_type),
        nullable: row.is_nullable === "YES",
        ordinal: Number(row.ordinal_position),
        defaultValue: row.column_default == null ? null : String(row.column_default),
      })),
    };
  }

  async previewTable(database: string | undefined, schema: string | undefined, table: string, page: Page) {
    const catalog = database ?? this.config.database;
    const selectedSchema = schema ?? this.schema;
    return this.query(
      `SELECT * FROM ${quoteIdentifier(catalog, "double")}.${quoteIdentifier(selectedSchema, "double")}.${quoteIdentifier(table, "double")} OFFSET ${page.offset} ROWS FETCH FIRST ${page.pageSize + 1} ROWS ONLY`,
      page.pageSize,
    );
  }

  async executeReadQuery(
    query: string,
    parameters: DatabaseScalar[],
    limits: { maxRows: number; timeoutMs: number; maxBytes: number },
  ): Promise<QueryResult> {
    assertReadOnlySql(normalizeTrinoParametersForParser(query), "postgresql");
    return this.query(query, limits.maxRows, limits.timeoutMs, parameters, limits.maxBytes);
  }

  private async query(
    sql: string,
    maxRows: number,
    timeoutMs = 30_000,
    parameters: DatabaseScalar[] = [],
    maxBytes = 10 * 1024 * 1024,
  ): Promise<QueryResult> {
    const origin = `${this.config.tls === "disable" ? "http" : "https"}://${formatHost(this.config.host)}:${this.config.port}`;
    const headers: Record<string, string> = {
      "content-type": "text/plain; charset=utf-8",
      "x-trino-user": this.config.username,
      "x-trino-catalog": this.config.database,
      "x-trino-schema": this.schema,
      "x-trino-client-tags": "openconnector,read-only",
      "x-trino-source": "open-connector",
    };
    if (this.authMode === "basic") {
      headers.authorization = `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64")}`;
    }
    let statement = sql;
    if (parameters.length > 0) {
      headers["x-trino-prepared-statement"] = `openconnector=${encodeURIComponent(sql)}`;
      statement = `EXECUTE openconnector USING ${parameters.map(toTrinoLiteral).join(", ")}`;
    }
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 100), 30_000);
    let nextUrl = `${origin}/v1/statement`;
    let method: "POST" | "GET" = "POST";
    const rows: Record<string, unknown>[] = [];
    let columns: Array<{ name: string; dataType: string | null }> = [];
    let queryId: string | undefined;
    try {
      while (true) {
        if (Date.now() >= deadline) throw new DatabaseRuntimeError("database_timeout", "Trino query timed out.");
        assertSameOrigin(nextUrl, origin);
        const response = await trinoFetch(nextUrl, {
          method,
          headers,
          body: method === "POST" ? statement : undefined,
          signal: this.signal,
        });
        if (!response.ok)
          throw new DatabaseRuntimeError("database_query_failed", `Trino returned HTTP ${response.status}.`);
        const payload = await readTrinoPage(response, this.signal);
        queryId = typeof payload.id === "string" ? payload.id : queryId;
        if (payload.error) {
          throw new DatabaseRuntimeError(
            /permission|access denied/i.test(String(payload.error.errorName))
              ? "database_permission_denied"
              : "database_query_failed",
            "Trino query failed.",
          );
        }
        if (Array.isArray(payload.columns)) {
          columns = payload.columns.map((column) => {
            const item = column as TrinoColumn;
            return { name: String(item.name ?? ""), dataType: item.type == null ? null : String(item.type) };
          });
        }
        if (Array.isArray(payload.data)) {
          for (const rawRow of payload.data) {
            if (!Array.isArray(rawRow)) continue;
            rows.push(Object.fromEntries(columns.map((column, index) => [column.name, rawRow[index]])));
          }
        }
        if (rows.length > maxRows || typeof payload.nextUri !== "string") break;
        nextUrl = payload.nextUri;
        method = "GET";
      }
    } finally {
      if (queryId && rows.length > maxRows) {
        await trinoFetch(`${origin}/v1/query/${encodeURIComponent(queryId)}`, {
          method: "DELETE",
          headers,
        }).catch(() => undefined);
      }
    }
    return boundedQueryResult(rows, columns, maxRows, maxBytes);
  }
}

async function readTrinoPage(response: Response, signal?: AbortSignal): Promise<TrinoPage> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: 12 * 1024 * 1024,
    fieldName: "Trino response",
    signal,
    createError: (message) => new DatabaseRuntimeError("database_budget_exceeded", message),
  });
  return JSON.parse(new TextDecoder().decode(bytes)) as TrinoPage;
}

function assertSameOrigin(value: string, origin: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DatabaseRuntimeError("database_network_failed", "Trino returned an invalid nextUri.");
  }
  if (url.origin !== origin) {
    throw new DatabaseRuntimeError("database_network_failed", "Trino returned a cross-origin nextUri.");
  }
}

function toTrinoLiteral(value: DatabaseScalar): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new DatabaseRuntimeError("database_query_rejected", "Invalid numeric parameter.");
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function normalizeTrinoParametersForParser(sql: string): string {
  let quote: "'" | '"' | "`" | undefined;
  let output = "";
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    if (quote) {
      output += char;
      if (char === quote) {
        if (sql[index + 1] === char) output += sql[++index];
        else quote = undefined;
      }
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
      output += char;
    } else {
      output += char === "?" ? "NULL" : char;
    }
  }
  return output;
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
