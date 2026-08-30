import type { CredentialValidationResult, ExecutionResult } from "../types.ts";

import sqlParser from "node-sql-parser";
import { createHash } from "node:crypto";
import { ProviderRequestError } from "../../providers/provider-runtime.ts";
import { assertGuardedEgressUrl } from "../guarded-fetch.ts";
import { isPrivateNetworkAccessAllowed } from "../request.ts";

const { Parser } = sqlParser;

export type DatabaseScalar = string | number | boolean | null;
export type DatabaseErrorCode =
  | "database_authentication_failed"
  | "database_network_failed"
  | "database_tls_failed"
  | "database_permission_denied"
  | "database_timeout"
  | "database_query_rejected"
  | "database_budget_exceeded"
  | "database_query_failed";

export interface DatabaseConnectionConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tls: "disable" | "require" | "verify-full";
  caCertificate?: string;
}

export interface QueryResult {
  columns: Array<{ name: string; dataType: string | null }>;
  rows: Record<string, unknown>[];
  rowCount: number;
  bytes: number;
  truncated: boolean;
}

export interface Page {
  offset: number;
  pageSize: number;
}

/** Fixed server-side scan ceilings; action callers cannot raise these values. */
export const databaseScanBudgetRows: number = 10_000_000;
export const databaseScanBudgetBytes: number = 100 * 1024 * 1024;

export class DatabaseRuntimeError extends Error {
  readonly code: DatabaseErrorCode;

  constructor(code: DatabaseErrorCode, message: string) {
    super(message);
    this.name = "DatabaseRuntimeError";
    this.code = code;
  }
}

export function readDatabaseConfig(
  values: Record<string, string>,
  defaults: { port: number; database: string },
): DatabaseConnectionConfig {
  const host = requiredString(values.host, "host");
  const port = values.port ? Number(values.port) : defaults.port;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new DatabaseRuntimeError("database_network_failed", "Database port must be between 1 and 65535.");
  }
  const tls = values.tls?.trim().toLowerCase() || "require";
  if (tls !== "disable" && tls !== "require" && tls !== "verify-full") {
    throw new DatabaseRuntimeError("database_tls_failed", "TLS mode must be disable, require, or verify-full.");
  }
  return {
    host,
    port,
    database: values.database?.trim() || defaults.database,
    username: requiredString(values.username, "username"),
    password: requiredString(values.password, "password"),
    tls,
    caCertificate: values.caCertificate?.trim() || undefined,
  };
}

export async function assertDatabaseEgress(config: DatabaseConnectionConfig): Promise<void> {
  assertDatabaseHostAllowlisted(config.host);
  await assertGuardedEgressUrl(`http://${formatUrlHost(config.host)}:${config.port}`, {
    fieldName: "database host",
    createError: (message) => new DatabaseRuntimeError("database_network_failed", message),
    allowPrivateNetwork: isPrivateNetworkAccessAllowed(),
  });
}

export function assertDatabaseHostAllowlisted(rawHost: string): void {
  const allowlist = (process.env.CONNECTION_DATABASE_EGRESS_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const host = rawHost.toLowerCase().replace(/\.$/, "");
  if (isPrivateNetworkAccessAllowed() && allowlist.length === 0) {
    throw new DatabaseRuntimeError(
      "database_network_failed",
      "Private database access requires CONNECTION_DATABASE_EGRESS_ALLOWLIST.",
    );
  }
  if (
    allowlist.length > 0 &&
    !allowlist.some((entry) => host === entry || (entry.startsWith(".") && host.endsWith(entry)))
  ) {
    throw new DatabaseRuntimeError(
      "database_network_failed",
      "Database host is not in the deployment egress allowlist.",
    );
  }
}

export function assertReadOnlySql(sql: string, dialect: "postgresql" | "mysql" | "transactsql"): void {
  const normalized = sql.trim();
  if (!normalized) rejectQuery();
  const parser = new Parser();
  let ast: unknown;
  try {
    ast = parser.astify(normalized, { database: dialect });
  } catch {
    rejectQuery();
  }
  if (Array.isArray(ast) || !ast || typeof ast !== "object") rejectQuery();
  const type = String((ast as { type?: unknown }).type ?? "").toLowerCase();
  if (type !== "select") rejectQuery();
  const tokens = tokenizeSql(normalized);
  const forbidden = new Set([
    "alter",
    "attach",
    "call",
    "copy",
    "create",
    "delete",
    "detach",
    "do",
    "drop",
    "execute",
    "grant",
    "insert",
    "into",
    "load",
    "merge",
    "optimize",
    "outfile",
    "dumpfile",
    "reconfigure",
    "replace",
    "revoke",
    "set",
    "truncate",
    "unload",
    "update",
    "use",
    "pg_read_file",
    "pg_read_binary_file",
    "pg_ls_dir",
    "pg_terminate_backend",
    "pg_cancel_backend",
    "setval",
    "nextval",
    "lo_import",
    "lo_export",
    "dblink",
    "advisory",
    "get_lock",
    "release_lock",
    "openquery",
    "openrowset",
    "opendatasource",
    "external",
    "notify",
    "set_config",
    "sleep",
    "pg_sleep",
    "benchmark",
    "load_file",
    "xp_cmdshell",
    "openrowset",
    "opendatasource",
  ]);
  if (
    tokens.some((token) => forbidden.has(token)) ||
    /\bfor\s+(update|share)\b/i.test(tokens.join(" ")) ||
    /\block\s+in\s+share\s+mode\b/i.test(tokens.join(" "))
  ) {
    rejectQuery();
  }
}

export function assertClickhouseReadOnlySql(sql: string): void {
  const normalized = sql.trim();
  const tokens = tokenizeSql(normalized);
  if (!normalized || !["select", "with"].includes(tokens[0] ?? "")) {
    rejectQuery();
  }
  const forbidden =
    /\b(alter|attach|azureblobstorage|create|delete|detach|drop|file|filecluster|format|hdfs|hdfscluster|insert|into|jdbc|kafka|kill|mongodb|move|mysql|nats|odbc|optimize|postgresql|rabbitmq|redis|remote|remotesecure|rename|replace|s3|s3cluster|set|system|truncate|update|url|urlcluster|use|sleep|sleepEachRow)\b/i;
  if (forbidden.test(tokens.join(" ")) || /\bs3(?:cluster)?\s*\(/i.test(normalized) || hasTopLevelSemicolon(normalized))
    rejectQuery();
}

export function readParameters(value: unknown): DatabaseScalar[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) {
    throw new DatabaseRuntimeError("database_query_rejected", "parameters must be an array of at most 256 scalars.");
  }
  return value.map((item) => {
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") return item;
    throw new DatabaseRuntimeError("database_query_rejected", "Query parameters must be scalar JSON values.");
  });
}

export function readLimits(input: Record<string, unknown>): { maxRows: number; timeoutMs: number; maxBytes: number } {
  return {
    maxRows: boundedInteger(input.maxRows, 1, 1000, 1000),
    timeoutMs: boundedInteger(input.timeoutMs, 100, 30_000, 30_000),
    maxBytes: 10 * 1024 * 1024,
  };
}

export function readPage(input: Record<string, unknown>): Page {
  const pageSize = boundedInteger(input.pageSize, 1, 200, 100);
  const raw =
    typeof input.cursor === "string" && input.cursor ? Buffer.from(input.cursor, "base64url").toString() : "0";
  const offset = Number(raw);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new DatabaseRuntimeError("database_query_rejected", "Invalid pagination cursor.");
  }
  return { offset, pageSize };
}

export function pageResult<T>(items: T[], page: Page): { items: T[]; nextCursor: string | null; truncated: boolean } {
  const truncated = items.length > page.pageSize;
  return {
    items: items.slice(0, page.pageSize),
    nextCursor: truncated ? Buffer.from(String(page.offset + page.pageSize)).toString("base64url") : null,
    truncated,
  };
}

export function boundedQueryResult(
  rows: Record<string, unknown>[],
  columns: Array<{ name: string; dataType?: string | null }>,
  maxRows: number,
  maxBytes: number,
): QueryResult {
  const output: Record<string, unknown>[] = [];
  let bytes = 2;
  let truncated = rows.length > maxRows;
  for (const row of rows.slice(0, maxRows)) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row));
    if (bytes + rowBytes > maxBytes) {
      truncated = true;
      break;
    }
    output.push(row);
    bytes += rowBytes;
  }
  return {
    columns: columns.map((column) => ({ name: column.name, dataType: column.dataType ?? null })),
    rows: output,
    rowCount: output.length,
    bytes,
    truncated,
  };
}

export function quoteIdentifier(value: unknown, style: "double" | "backtick" | "bracket"): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > 256) {
    throw new DatabaseRuntimeError("database_query_rejected", "Invalid database identifier.");
  }
  const identifier = value.trim();
  if (style === "backtick") return `\`${identifier.replaceAll("`", "``")}\``;
  if (style === "bracket") return `[${identifier.replaceAll("]", "]]")}]`;
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function credentialPoolKey(service: string, config: DatabaseConnectionConfig, extra = ""): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        service,
        config.host,
        config.port,
        config.database,
        config.username,
        config.password,
        config.tls,
        config.caCertificate ?? "",
        extra,
      ]),
    )
    .digest("hex");
}

export function validationResult(
  engine: string,
  version: string,
  config: DatabaseConnectionConfig,
): CredentialValidationResult {
  return {
    profile: {
      accountId: `${engine}:${config.host}:${config.port}:${config.database}:${config.username}`,
      displayName: `${config.username}@${config.host}/${config.database}`,
    },
    grantedScopes: ["read"],
    metadata: {
      engine,
      version,
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.username,
    },
  };
}

export function mapDatabaseError(error: unknown): ExecutionResult {
  const mapped = normalizeDatabaseError(error);
  return { ok: false, error: { code: mapped.code, message: mapped.message } };
}

export function normalizeDatabaseError(error: unknown): DatabaseRuntimeError {
  if (error instanceof DatabaseRuntimeError) return error;
  const candidate = error as { code?: string; number?: number; message?: string };
  const code = String(candidate?.code ?? "");
  const message = String(candidate?.message ?? "");
  if (/password|authentication|login failed|28P01|ER_ACCESS_DENIED_ERROR/i.test(`${code} ${message}`)) {
    return new DatabaseRuntimeError("database_authentication_failed", "Database authentication failed.");
  }
  if (/certificate|tls|ssl|self signed|unable to verify/i.test(`${code} ${message}`)) {
    return new DatabaseRuntimeError("database_tls_failed", "Database TLS verification failed.");
  }
  if (/timeout|cancel|57014|ETIMEOUT/i.test(`${code} ${message}`)) {
    return new DatabaseRuntimeError("database_timeout", "Database request timed out or was cancelled.");
  }
  if (
    /query governor|cost limit|max_examined_row_limit|max_scan_key_num|scan.*budget|rows? examined/i.test(
      `${code} ${message}`,
    )
  ) {
    return new DatabaseRuntimeError("database_budget_exceeded", "Database scan budget exceeded.");
  }
  if (/permission|denied|not authorized|42501|ER_DBACCESS_DENIED_ERROR/i.test(`${code} ${message}`)) {
    return new DatabaseRuntimeError("database_permission_denied", "Database permission denied.");
  }
  if (/ECONN|ENOTFOUND|EHOST|network|socket|connection.*closed/i.test(`${code} ${message}`)) {
    return new DatabaseRuntimeError("database_network_failed", "Database network connection failed.");
  }
  return new DatabaseRuntimeError("database_query_failed", "Database query failed.");
}

export function requiredInputString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DatabaseRuntimeError("database_query_rejected", `${field} is required.`);
  }
  return value.trim();
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DatabaseRuntimeError("database_network_failed", `${field} is required.`);
  }
  return value.trim();
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new DatabaseRuntimeError(
      "database_query_rejected",
      `Value must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return number;
}

function rejectQuery(): never {
  throw new DatabaseRuntimeError(
    "database_query_rejected",
    "Only one read-only SELECT or WITH query is allowed; writes, procedures, dangerous functions, and multi-statements are rejected.",
  );
}

function formatUrlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function tokenizeSql(sql: string): string[] {
  let output = "";
  let index = 0;
  let quote: "'" | '"' | "`" | "]" | undefined;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (quote) {
      if ((quote === "]" && char === "]") || (quote !== "]" && char === quote)) {
        if (next === char) {
          index += 2;
          continue;
        }
        quote = undefined;
      }
      output += " ";
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      quote = char === "[" ? "]" : char;
      output += " ";
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      index = sql.indexOf("\n", index + 2);
      if (index < 0) break;
      output += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) rejectQuery();
      index = end + 2;
      output += " ";
      continue;
    }
    output += char;
    index += 1;
  }
  if (quote) rejectQuery();
  if (hasTopLevelSemicolon(output)) rejectQuery();
  return output.toLowerCase().match(/[a-z_]+/g) ?? [];
}

function hasTopLevelSemicolon(sql: string): boolean {
  const trimmed = sql.trim();
  const withoutFinal = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  return withoutFinal.includes(";");
}

export function providerRequestError(error: unknown): ProviderRequestError {
  const mapped = normalizeDatabaseError(error);
  const status =
    mapped.code === "database_authentication_failed" ? 401 : mapped.code === "database_timeout" ? 504 : 400;
  return new ProviderRequestError(status, mapped.message, { code: mapped.code });
}

export function assertDatabaseResourceScope(
  service: string,
  actionId: string,
  input: unknown,
  scope: { schemas?: string[]; tables?: string[] } | undefined,
): void {
  if (!scope) return;
  const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const schemas = new Set((scope.schemas ?? []).map(normalizeScopeIdentifier));
  const tables = new Set((scope.tables ?? []).map(normalizeScopeIdentifier));
  const schema = typeof value.schema === "string" ? normalizeScopeIdentifier(value.schema) : undefined;
  const database = typeof value.database === "string" ? normalizeScopeIdentifier(value.database) : undefined;
  const selectedSchema =
    schema ?? (["mysql", "clickhouse", "doris", "starrocks"].includes(service) ? database : undefined);
  const table = typeof value.table === "string" ? normalizeScopeIdentifier(value.table) : undefined;

  if (selectedSchema && schemas.size > 0 && !schemas.has(selectedSchema)) {
    throw new DatabaseRuntimeError("database_permission_denied", "Database schema is outside the lease scope.");
  }
  if (table && tables.size > 0 && !scopeTableMatches(tables, selectedSchema, table)) {
    throw new DatabaseRuntimeError("database_permission_denied", "Database table is outside the lease scope.");
  }

  if (!actionId.endsWith("execute_read_query")) return;
  const query = typeof value.query === "string" ? value.query.trim() : "";
  if (!query) {
    throw new DatabaseRuntimeError("database_permission_denied", "Database query is outside the lease scope.");
  }

  const parser = new Parser();
  let references: Array<{ schema?: string; table: string }>;
  try {
    const parsed = parser.astify(query, { database: service === "postgresql" ? "postgresql" : "mysql" });
    const ctes = collectCteNames(parsed);
    references = parser
      .tableList(query, { database: service === "postgresql" ? "postgresql" : "mysql" })
      .flatMap((entry) => {
        const [, rawSchema, ...rawTable] = entry.split("::");
        const tableName = normalizeScopeIdentifier(rawTable.join("::"));
        const schemaName = rawSchema && rawSchema !== "null" ? normalizeScopeIdentifier(rawSchema) : undefined;
        return !schemaName && ctes.has(tableName) ? [] : [{ schema: schemaName, table: tableName }];
      });
  } catch {
    throw new DatabaseRuntimeError("database_permission_denied", "Database query is outside the lease scope.");
  }
  if (
    references.length === 0 ||
    references.some(
      (reference) =>
        (schemas.size > 0 && (!reference.schema || !schemas.has(reference.schema))) ||
        (tables.size > 0 && !scopeTableMatches(tables, reference.schema, reference.table)),
    )
  ) {
    throw new DatabaseRuntimeError("database_permission_denied", "Database query is outside the lease scope.");
  }
}

function normalizeScopeIdentifier(value: string): string {
  return value
    .trim()
    .replace(/^["`[]|["`]]$/g, "")
    .toLowerCase();
}

function scopeTableMatches(tables: Set<string>, schema: string | undefined, table: string): boolean {
  return tables.has(table) || (schema !== undefined && tables.has(`${schema}.${table}`));
}

function collectCteNames(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectCteNames(item, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.with)) {
    for (const item of record.with) {
      if (item && typeof item === "object") {
        const name = (item as Record<string, unknown>).name;
        if (typeof name === "string") output.add(normalizeScopeIdentifier(name));
        else if (name && typeof name === "object" && typeof (name as Record<string, unknown>).value === "string") {
          output.add(normalizeScopeIdentifier(String((name as Record<string, unknown>).value)));
        }
      }
    }
  }
  Object.values(record).forEach((item) => collectCteNames(item, output));
  return output;
}
