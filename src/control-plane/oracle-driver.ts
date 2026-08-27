import "../oracledb.d.ts";
import type { OracleConnectionConfig, OracleQueryDriver, OracleQueryResult } from "./oracle-adapter.ts";
import type { Connection, Pool, PoolAttributes } from "oracledb";

import oracledb from "oracledb";

export interface OracleDriverOptions {
  user: string;
  password: string;
  poolMin?: number;
  poolMax?: number;
  poolIncrement?: number;
}

export class OracleThinDriver implements OracleQueryDriver {
  private readonly poolPromise: Promise<Pool>;

  constructor(config: OracleConnectionConfig, credentials: OracleDriverOptions) {
    const poolAttributes: PoolAttributes = {
      user: credentials.user,
      password: credentials.password,
      connectString: buildConnectString(config),
      poolMin: credentials.poolMin ?? 1,
      poolMax: credentials.poolMax ?? 4,
      poolIncrement: credentials.poolIncrement ?? 1,
      homogeneous: true,
      ...(config.tls?.walletPath
        ? {
            walletLocation: config.tls.walletPath,
            sslServerDNMatch: config.tls.rejectUnauthorized,
          }
        : {}),
    };
    this.poolPromise = oracledb.createPool(poolAttributes);
  }

  async query(
    sql: string,
    binds: Record<string, unknown>,
    options: { maxRows: number; timeoutMs: number },
  ): Promise<OracleQueryResult> {
    const pool = await this.poolPromise;
    let connection: Connection | undefined;
    try {
      connection = await pool.getConnection();
      await connection.execute("SET TRANSACTION READ ONLY");
      const result = await withTimeout(
        connection.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: options.maxRows }),
        options.timeoutMs,
      );
      const rows = (result.rows ?? []) as unknown[];
      return {
        rows,
        columns: result.metaData?.map(({ name, dbTypeName, nullable }) => ({
          name,
          dbTypeName,
          nullable,
        })),
        bytes: Buffer.byteLength(JSON.stringify(rows)),
      };
    } finally {
      await connection?.rollback().catch(() => undefined);
      await connection?.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const pool = await this.poolPromise.catch(() => undefined);
    await pool?.close(0).catch(() => undefined);
  }
}

function buildConnectString(config: OracleConnectionConfig): string {
  const service = config.serviceName ?? config.sid;
  if (!service) throw new Error("Oracle service_name or SID is required.");
  return `${config.host}:${config.port}/${service}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Oracle query timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
