declare module "oracledb" {
  export interface PoolAttributes {
    user: string;
    password: string;
    connectString: string;
    poolMin: number;
    poolMax: number;
    poolIncrement: number;
    homogeneous: boolean;
    walletLocation?: string;
    sslServerDNMatch?: boolean;
  }

  export interface ExecuteResult {
    rows?: unknown[];
  }

  export interface Connection {
    execute(
      sql: string,
      binds: Record<string, unknown>,
      options: { outFormat: number; maxRows: number },
    ): Promise<ExecuteResult>;
    close(): Promise<void>;
  }

  export interface Pool {
    getConnection(): Promise<Connection>;
    close(drainTime?: number): Promise<void>;
  }

  export function createPool(attributes: PoolAttributes): Promise<Pool>;

  export const OUT_FORMAT_OBJECT: number;

  const oracledb: {
    createPool: typeof createPool;
    OUT_FORMAT_OBJECT: typeof OUT_FORMAT_OBJECT;
  };

  export default oracledb;
}
