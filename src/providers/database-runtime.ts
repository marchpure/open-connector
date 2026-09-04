import type {
  CredentialDefinition,
  CredentialValidators,
  ExecutionContext,
  ExecutionResult,
  ProviderExecutors,
} from "../core/types.ts";

import { optionalInteger, optionalString, requiredString } from "../core/cast.ts";
import {
  defineProviderExecutors,
  ProviderRequestError,
  requireCustomCredential,
  toProviderExecutionError,
} from "./provider-runtime.ts";

export interface DatabaseAdapter {
  validate(credentials: DatabaseCredentials, signal?: AbortSignal): Promise<DatabaseProfile>;
  discover(
    credentials: DatabaseCredentials,
    input: DatabaseDiscoveryInput,
    signal?: AbortSignal,
  ): Promise<DatabaseSchema>;
  query(
    credentials: DatabaseCredentials,
    input: DatabaseQueryInput,
    signal?: AbortSignal,
  ): Promise<DatabaseQueryResult>;
}

export interface DatabaseProviderRuntimeOptions {
  service: string;
  displayName: string;
  defaultPort: number;
  adapter: DatabaseAdapter;
}

export interface DatabaseCredentials {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

export interface DatabaseDiscoveryInput {
  schema?: string;
  table?: string;
  limit: number;
}

export interface DatabaseTable {
  schema: string;
  name: string;
  type: string;
}

export interface DatabaseColumn {
  schema: string;
  table: string;
  name: string;
  dataType: string;
  nullable?: boolean;
  ordinalPosition?: number;
}

export interface DatabaseSchema {
  tables: DatabaseTable[];
  columns: DatabaseColumn[];
}

export interface DatabaseQueryInput {
  sql: string;
  parameters: unknown[];
  maxRows: number;
}

export interface DatabaseQueryResult {
  rows: unknown[];
  rowCount: number;
  truncated: boolean;
}

interface DatabaseActionContext {
  credentials: DatabaseCredentials;
  adapter: DatabaseAdapter;
  signal?: AbortSignal;
}

export function databaseCredentialFields(defaultPort: number): CredentialDefinition[] {
  return [
    {
      key: "host",
      label: "Host",
      inputType: "text" as const,
      required: true,
      secret: false,
      placeholder: "db.example.com",
    },
    {
      key: "port",
      label: "Port",
      inputType: "text" as const,
      required: false,
      secret: false,
      placeholder: String(defaultPort),
    },
    {
      key: "database",
      label: "Database",
      inputType: "text" as const,
      required: true,
      secret: false,
    },
    {
      key: "username",
      label: "Username",
      inputType: "text" as const,
      required: true,
      secret: false,
    },
    {
      key: "password",
      label: "Password",
      inputType: "password" as const,
      required: true,
      secret: true,
    },
    {
      key: "ssl",
      label: "Use SSL",
      inputType: "text" as const,
      required: false,
      secret: false,
      placeholder: "true",
      description: "Set to true for TLS connections.",
    },
  ];
}

export function createDatabaseExecutors(options: DatabaseProviderRuntimeOptions): ProviderExecutors {
  return defineProviderExecutors<DatabaseActionContext>({
    service: options.service,
    mapError: (error) =>
      toProviderExecutionError(toDatabaseProviderError(error), `${options.displayName} request failed`),
    handlers: {
      discover_schema(input, context) {
        return context.adapter.discover(context.credentials, readDiscoveryInput(input), context.signal);
      },
      query_readonly(input, context) {
        return context.adapter.query(context.credentials, readQueryInput(input), context.signal);
      },
    },
    async createContext(context: ExecutionContext): Promise<DatabaseActionContext> {
      const credential = await requireCustomCredential(context, options.service);
      return {
        credentials: readDatabaseCredentials(credential.values, options.defaultPort),
        adapter: options.adapter,
        signal: context.signal,
      };
    },
  });
}

export function createDatabaseCredentialValidators(
  options: DatabaseProviderRuntimeOptions,
  defaultPort: number,
): CredentialValidators {
  return {
    async customCredential(input, { signal }) {
      const credentials = readDatabaseCredentials(input.values, defaultPort);
      let profile: DatabaseProfile;
      try {
        profile = await options.adapter.validate(credentials, signal);
      } catch (error) {
        throw toDatabaseProviderError(error);
      }
      return {
        profile: {
          accountId: `${credentials.username}@${credentials.host}:${credentials.port}/${credentials.database}`,
          displayName: profile.displayName,
          grantedScopes: ["read"],
        },
        grantedScopes: ["read"],
        metadata: {
          host: credentials.host,
          port: credentials.port,
          database: credentials.database,
          username: credentials.username,
          driver: options.service,
        },
      };
    },
  };
}

export interface DatabaseProfile {
  displayName: string;
}

export function readDatabaseCredentials(values: Record<string, unknown>, defaultPort: number): DatabaseCredentials {
  const portInput = optionalString(values.port);
  const port = portInput ? Number(portInput) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ProviderRequestError(400, "port must be an integer from 1 to 65535");
  }
  return {
    host: requiredString(values.host, "host", providerInputError),
    port,
    database: requiredString(values.database, "database", providerInputError),
    username: requiredString(values.username, "username", providerInputError),
    password: requiredString(values.password, "password", providerInputError),
    ssl: parseBoolean(values.ssl),
  };
}

export function readDiscoveryInput(input: Record<string, unknown>): DatabaseDiscoveryInput {
  const limit = optionalInteger(input.limit) ?? 100;
  if (limit < 1 || limit > 500) {
    throw new ProviderRequestError(400, "limit must be between 1 and 500");
  }
  return {
    schema: optionalString(input.schema),
    table: optionalString(input.table),
    limit,
  };
}

export function readQueryInput(input: Record<string, unknown>): DatabaseQueryInput {
  const sql = normalizeReadOnlySql(requiredString(input.sql, "sql", providerInputError).trim());
  const parameters = Array.isArray(input.parameters) ? input.parameters : [];
  const maxRows = optionalInteger(input.maxRows) ?? 100;
  if (maxRows < 1 || maxRows > 1000) {
    throw new ProviderRequestError(400, "maxRows must be between 1 and 1000");
  }
  return { sql, parameters, maxRows };
}

export function assertReadOnlySql(sql: string): void {
  normalizeReadOnlySql(sql);
}

function normalizeReadOnlySql(sql: string): string {
  const withoutTrailingSemicolon = sql.replace(/;\s*$/u, "");
  if (withoutTrailingSemicolon.includes(";")) {
    throw new ProviderRequestError(400, "Only one SQL statement is allowed.");
  }
  const normalized = withoutSqlComments(withoutTrailingSemicolon).trim().toLowerCase();
  if (!normalized.startsWith("select ") && !normalized.startsWith("with ")) {
    throw new ProviderRequestError(400, "Only read-only SELECT statements are allowed.");
  }
  if (/\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|call|execute)\b/u.test(normalized)) {
    throw new ProviderRequestError(400, "Only read-only SELECT statements are allowed.");
  }
  return withoutTrailingSemicolon;
}

export function limitRows(rows: unknown[], maxRows: number): DatabaseQueryResult {
  return {
    rows: rows.slice(0, maxRows),
    rowCount: Math.min(rows.length, maxRows),
    truncated: rows.length > maxRows,
  };
}

export async function loadOptionalModule<T>(packageName: string, installName: string = packageName): Promise<T> {
  try {
    return (await import(packageName)) as T;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      throw new ProviderRequestError(501, `${installName} driver is not installed in this runtime image.`);
    }
    throw error;
  }
}

export function toDatabaseProviderError(error: unknown): unknown {
  if (error instanceof ProviderRequestError) {
    return error;
  }
  if (isDriverMissingError(error)) {
    return new ProviderRequestError(501, "Database driver is not installed in this runtime image.");
  }
  if (isDatabaseAuthError(error)) {
    return new ProviderRequestError(401, "Database rejected the supplied credentials.");
  }
  if (isDatabaseTimeoutError(error)) {
    return new ProviderRequestError(504, "Database connection timed out.");
  }
  if (isDatabaseNetworkError(error)) {
    return new ProviderRequestError(502, "Database network connection failed.");
  }
  return error;
}

export function toDatabaseExecutionError(error: unknown, displayName = "Database"): ExecutionResult {
  return toProviderExecutionError(toDatabaseProviderError(error), `${displayName} request failed`);
}

function withoutSqlComments(sql: string): string {
  return sql.replace(/--.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  const text = optionalString(value)?.toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

function providerInputError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

function isDatabaseAuthError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "28P01" || code === "ER_ACCESS_DENIED_ERROR" || code === "ORA-01017" || code === "NJS-116";
}

function isDriverMissingError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

function isDatabaseTimeoutError(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "ETIMEDOUT" ||
    code === "ETIMEOUT" ||
    code === "CONNECT_TIMEOUT" ||
    code === "PROTOCOL_SEQUENCE_TIMEOUT" ||
    code === "NJS-040" ||
    code === "NJS-510"
  );
}

function isDatabaseNetworkError(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "ENOTFOUND" ||
    code === "ORA-12154" ||
    code === "ORA-12514" ||
    code === "ORA-12541" ||
    code === "ORA-12545" ||
    code === "NJS-503" ||
    code === "NJS-511"
  );
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code) {
    return code;
  }
  const match = /(?:ORA|NJS)-\d{4,5}/u.exec(error.message);
  return match?.[0];
}
