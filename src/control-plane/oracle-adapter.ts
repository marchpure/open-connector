import { getParsedNodes, getParserFromInput } from "@griffithswaite/ts-plsql-parser";

export interface OracleConnectionConfig {
  host: string;
  port: number;
  serviceName?: string;
  tls?: { walletPath?: string; rejectUnauthorized: boolean };
  ssh?: { host: string; port: number; user: string };
}

export interface OracleQueryDriver {
  query(
    sql: string,
    binds: Record<string, unknown>,
    options: { maxRows: number; timeoutMs: number },
  ): Promise<OracleQueryResult>;
}

export interface OracleColumn {
  name: string;
  dbTypeName?: string;
  nullable?: boolean;
}

export interface OracleLineage {
  schema?: string;
  object: string;
}

export interface OracleQueryResult {
  rows: unknown[];
  columns?: OracleColumn[];
  bytes: number;
  lineage?: OracleLineage[];
}

export type OracleDiscoveryResult =
  | { schemas: string[] }
  | { schema: string; tables: string[] }
  | {
      schema: string;
      table: string;
      columns: Array<{ name: string; dataType: string; nullable: boolean; ordinal: number }>;
    };

export interface OracleQueryLimits {
  maxRows: number;
  maxBytes: number;
  timeoutMs: number;
  maxConcurrent: number;
  allowedSchemas?: string[];
}

export class OracleAdapterError extends Error {
  readonly code: "invalid_config" | "write_query" | "schema_denied" | "query_limit" | "query_failed";
  readonly cause?: unknown;

  constructor(code: OracleAdapterError["code"], message: string, cause?: unknown) {
    super(message);
    this.name = "OracleAdapterError";
    this.code = code;
    this.cause = cause;
  }
}

export class OracleDatabaseAdapter {
  private active = 0;
  private readonly config: OracleConnectionConfig;
  private readonly driver: OracleQueryDriver;
  private readonly limits: OracleQueryLimits;

  constructor(config: OracleConnectionConfig, driver: OracleQueryDriver, limits: OracleQueryLimits) {
    this.config = config;
    this.driver = driver;
    this.limits = limits;
    if (!config.serviceName) {
      throw new OracleAdapterError("invalid_config", "Oracle requires a service name.");
    }
  }

  async query(
    sql: string,
    binds: Record<string, unknown> = {},
    overrides: Partial<Pick<OracleQueryLimits, "maxRows" | "maxBytes" | "timeoutMs">> = {},
  ): Promise<OracleQueryResult> {
    const lineage = analyzeReadOnlyQuery(sql);
    assertAllowedSchemas(lineage, this.limits.allowedSchemas);
    return { ...(await this.execute(sql, binds, overrides)), lineage };
  }

  async discover(input: { schema?: string; table?: string } = {}): Promise<OracleDiscoveryResult> {
    if (input.table && !input.schema) {
      throw new OracleAdapterError("invalid_config", "Oracle table discovery requires a schema.");
    }
    if (!input.schema) {
      const allowed = this.limits.allowedSchemas?.map(normalizeDiscoveryIdentifier);
      const binds = Object.fromEntries((allowed ?? []).map((schema, index) => [`schema${index}`, schema]));
      const filter = allowed?.length
        ? ` where username in (${allowed.map((_, index) => `:schema${index}`).join(", ")})`
        : "";
      const result = await this.execute(
        `select username as schema_name from all_users${filter} order by username`,
        binds,
      );
      return { schemas: result.rows.map((row) => stringField(row, "SCHEMA_NAME")) };
    }

    const schema = normalizeDiscoveryIdentifier(input.schema);
    assertAllowedSchemas([{ schema, object: "*" }], this.limits.allowedSchemas);
    if (!input.table) {
      const result = await this.execute("select table_name from all_tables where owner = :schema order by table_name", {
        schema,
      });
      return { schema, tables: result.rows.map((row) => stringField(row, "TABLE_NAME")) };
    }

    const table = normalizeDiscoveryIdentifier(input.table);
    const result = await this.execute(
      `select column_name, data_type, nullable, column_id
         from all_tab_columns
        where owner = :schema and table_name = :tableName
        order by column_id`,
      { schema, tableName: table },
    );
    return {
      schema,
      table,
      columns: result.rows.map((row) => ({
        name: stringField(row, "COLUMN_NAME"),
        dataType: stringField(row, "DATA_TYPE"),
        nullable: stringField(row, "NULLABLE") === "Y",
        ordinal: numberField(row, "COLUMN_ID"),
      })),
    };
  }

  private async execute(
    sql: string,
    binds: Record<string, unknown>,
    overrides: Partial<Pick<OracleQueryLimits, "maxRows" | "maxBytes" | "timeoutMs">> = {},
  ): Promise<OracleQueryResult> {
    if (this.active >= this.limits.maxConcurrent) {
      throw new OracleAdapterError("query_limit", "Oracle concurrency limit exceeded.");
    }
    const maxRows = overrides.maxRows ?? this.limits.maxRows;
    const maxBytes = overrides.maxBytes ?? this.limits.maxBytes;
    const timeoutMs = overrides.timeoutMs ?? this.limits.timeoutMs;
    this.active += 1;
    try {
      const result = await this.driver.query(sql, binds, {
        maxRows,
        timeoutMs,
      });
      if (result.rows.length > maxRows || result.bytes > maxBytes) {
        throw new OracleAdapterError("query_limit", "Oracle result limit exceeded.");
      }
      return result;
    } catch (error) {
      if (error instanceof OracleAdapterError) throw error;
      throw new OracleAdapterError("query_failed", "Oracle query failed.", error);
    } finally {
      this.active -= 1;
    }
  }
}

function normalizeDiscoveryIdentifier(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_$#]*$/.test(normalized)) {
    throw new OracleAdapterError("invalid_config", "Oracle schema and table names must be valid identifiers.");
  }
  return normalized;
}

function stringField(row: unknown, field: string): string {
  if (!row || typeof row !== "object") {
    throw new OracleAdapterError("query_failed", `Oracle discovery result is missing ${field}.`);
  }
  const value = (row as Record<string, unknown>)[field];
  if (typeof value !== "string") {
    throw new OracleAdapterError("query_failed", `Oracle discovery result is missing ${field}.`);
  }
  return value;
}

function numberField(row: unknown, field: string): number {
  if (!row || typeof row !== "object") {
    throw new OracleAdapterError("query_failed", `Oracle discovery result is missing ${field}.`);
  }
  const value = Number((row as Record<string, unknown>)[field]);
  if (!Number.isFinite(value)) {
    throw new OracleAdapterError("query_failed", `Oracle discovery result is missing ${field}.`);
  }
  return value;
}

interface ParseNode {
  type: string;
  text: string;
  children?: ParseNode[];
  nodes?: ParseNode[];
}

function analyzeReadOnlyQuery(sql: string): OracleLineage[] {
  const parser = getParserFromInput(sql);
  const tree = parser.sql_script();
  const parsed = getParsedNodes(sql, tree);
  const nodes = flatten(parsed.nodes as ParseNode[]);
  const units = nodes.filter((node) => node.type === "Unit_statementContext");
  const selects = nodes.filter((node) => node.type === "Select_statementContext");
  const hasPackageCall = nodes.some(
    (node) =>
      node.type === "General_elementContext" &&
      childNodes(node).some(
        (child) =>
          child.type === "General_element_partContext" &&
          childNodes(child).some((part) => part.type === "Function_argumentContext"),
      ),
  );
  const hasDatabaseLink = nodes.some((node) => node.type === "Tableview_nameContext" && node.text.includes("@"));

  if (
    (parser as unknown as { _syntaxErrors: number })._syntaxErrors > 0 ||
    units.length !== 1 ||
    selects.length !== 1 ||
    nodes.some((node) => node.type === "For_update_clauseContext") ||
    hasPackageCall ||
    hasDatabaseLink
  ) {
    throw new OracleAdapterError("write_query", "Only parameterized read-only SELECT/WITH queries are allowed.");
  }

  return nodes
    .filter((node) => node.type === "Tableview_nameContext")
    .map(toLineage)
    .filter(
      (item, index, all) =>
        all.findIndex((candidate) => candidate.schema === item.schema && candidate.object === item.object) === index,
    );
}

function flatten(roots: ParseNode[]): ParseNode[] {
  const nodes: ParseNode[] = [...roots];
  for (const root of roots) nodes.push(...flatten(childNodes(root)));
  return nodes;
}

function childNodes(node: ParseNode): ParseNode[] {
  return node.nodes ?? node.children ?? [];
}

function toLineage(node: ParseNode): OracleLineage {
  const [first, second] = splitQualifiedIdentifier(node.text);
  return second === undefined
    ? { object: normalizeIdentifier(first) }
    : { schema: normalizeIdentifier(first), object: normalizeIdentifier(second) };
}

function splitQualifiedIdentifier(value: string): [string, string?] {
  const match = value.match(/^("(?:[^"]|"")*"|[^.]+)(?:\.("(?:[^"]|"")*"|[^.@]+))?/);
  return [match?.[1] ?? value, match?.[2]];
}

function normalizeIdentifier(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/""/g, '"') : value.toUpperCase();
}

function assertAllowedSchemas(lineage: OracleLineage[], allowedSchemas?: string[]): void {
  if (!allowedSchemas?.length) return;
  const allowed = new Set(allowedSchemas.map(normalizeIdentifier));
  const denied = lineage.find((item) => item.schema && !allowed.has(item.schema));
  if (denied) {
    throw new OracleAdapterError("schema_denied", `Oracle schema ${denied.schema} is not allowed.`);
  }
}
