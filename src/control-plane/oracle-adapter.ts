export interface OracleConnectionConfig {
  host: string;
  port: number;
  serviceName?: string;
  sid?: string;
  tls?: { walletPath?: string; rejectUnauthorized: boolean };
  ssh?: { host: string; port: number; user: string };
}

export interface OracleQueryDriver {
  query(sql: string, binds: Record<string, unknown>, options: { maxRows: number; timeoutMs: number }): Promise<{ rows: unknown[]; bytes: number }>;
}

export interface OracleQueryLimits {
  maxRows: number;
  maxBytes: number;
  timeoutMs: number;
  maxConcurrent: number;
}

export class OracleAdapterError extends Error {
  readonly code: "invalid_config" | "write_query" | "query_limit" | "query_failed";

  constructor(code: OracleAdapterError["code"], message: string) {
    super(message);
    this.name = "OracleAdapterError";
    this.code = code;
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
    if (!config.serviceName && !config.sid) {
      throw new OracleAdapterError("invalid_config", "Oracle requires service_name or SID.");
    }
    if (config.serviceName && config.sid) {
      throw new OracleAdapterError("invalid_config", "Oracle service_name and SID are mutually exclusive.");
    }
  }

  async query(sql: string, binds: Record<string, unknown> = {}): Promise<{ rows: unknown[]; bytes: number }> {
    assertReadOnly(sql);
    if (this.active >= this.limits.maxConcurrent) {
      throw new OracleAdapterError("query_limit", "Oracle concurrency limit exceeded.");
    }
    this.active += 1;
    try {
      const result = await this.driver.query(sql, binds, {
        maxRows: this.limits.maxRows,
        timeoutMs: this.limits.timeoutMs,
      });
      if (result.rows.length > this.limits.maxRows || result.bytes > this.limits.maxBytes) {
        throw new OracleAdapterError("query_limit", "Oracle result limit exceeded.");
      }
      return result;
    } catch (error) {
      if (error instanceof OracleAdapterError) throw error;
      throw new OracleAdapterError("query_failed", "Oracle query failed.");
    } finally {
      this.active -= 1;
    }
  }
}

function assertReadOnly(sql: string): void {
  const normalized = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "").trim().toLowerCase();
  if (!/^(select|with)\b/.test(normalized) || /\b(insert|update|delete|merge|alter|drop|truncate|grant|revoke|begin|execute|call)\b/.test(normalized)) {
    throw new OracleAdapterError("write_query", "Only parameterized read-only SELECT/WITH queries are allowed.");
  }
}
