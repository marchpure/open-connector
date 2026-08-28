import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
} from "../types.ts";
import type { Page, QueryResult } from "./runtime.ts";

import { defineProviderExecutors, requireCustomCredential } from "../../providers/provider-runtime.ts";
import {
  mapDatabaseError,
  pageResult,
  providerRequestError,
  readLimits,
  readPage,
  readParameters,
  requiredInputString,
  validationResult,
} from "./runtime.ts";

export interface DatabaseIdentity {
  engine: string;
  version: string;
  database: string;
}

export interface DatabaseBackend {
  readonly config: {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    tls: "disable" | "require" | "verify-full";
    caCertificate?: string;
  };
  validate(): Promise<DatabaseIdentity>;
  listDatabases(page: Page): Promise<Array<{ name: string }>>;
  listSchemas(database: string | undefined, page: Page): Promise<Array<{ database: string; name: string }>>;
  listTables(
    database: string | undefined,
    schema: string | undefined,
    page: Page,
  ): Promise<Array<{ database: string; schema: string; name: string; type: "table" | "view" }>>;
  describeTable(
    database: string | undefined,
    schema: string | undefined,
    table: string,
  ): Promise<{
    database: string;
    schema: string;
    table: string;
    columns: Array<{
      name: string;
      dataType: string;
      nullable: boolean;
      ordinal: number;
      defaultValue: string | null;
    }>;
  }>;
  previewTable(
    database: string | undefined,
    schema: string | undefined,
    table: string,
    page: Page,
  ): Promise<QueryResult>;
  executeReadQuery(
    query: string,
    parameters: Array<string | number | boolean | null>,
    limits: { maxRows: number; timeoutMs: number; maxBytes: number },
  ): Promise<QueryResult>;
}

export type DatabaseBackendFactory = (
  values: Record<string, string>,
  signal?: AbortSignal,
) => Promise<DatabaseBackend> | DatabaseBackend;

type DatabaseHandler = (input: Record<string, unknown>, backend: DatabaseBackend) => Promise<unknown>;

export function createDatabaseProviderRuntime(
  service: string,
  createBackend: DatabaseBackendFactory,
): { executors: ProviderExecutors; credentialValidators: CredentialValidators } {
  const handlers: Record<string, DatabaseHandler> = {
    async validate_connection(_input, backend) {
      const identity = await backend.validate();
      return { ok: true, ...identity };
    },
    async list_databases(input, backend) {
      const page = readPage(input);
      const result = pageResult(await backend.listDatabases({ ...page, pageSize: page.pageSize + 1 }), page);
      return { databases: result.items, nextCursor: result.nextCursor, truncated: result.truncated };
    },
    async list_schemas(input, backend) {
      const page = readPage(input);
      const result = pageResult(
        await backend.listSchemas(optionalString(input.database), { ...page, pageSize: page.pageSize + 1 }),
        page,
      );
      return { schemas: result.items, nextCursor: result.nextCursor, truncated: result.truncated };
    },
    async list_tables(input, backend) {
      const page = readPage(input);
      const result = pageResult(
        await backend.listTables(optionalString(input.database), optionalString(input.schema), {
          ...page,
          pageSize: page.pageSize + 1,
        }),
        page,
      );
      return { tables: result.items, nextCursor: result.nextCursor, truncated: result.truncated };
    },
    describe_table(input, backend) {
      return backend.describeTable(
        optionalString(input.database),
        optionalString(input.schema),
        requiredInputString(input.table, "table"),
      );
    },
    async preview_table(input, backend) {
      const page = readPage(input);
      const result = await backend.previewTable(
        optionalString(input.database),
        optionalString(input.schema),
        requiredInputString(input.table, "table"),
        page,
      );
      return {
        result,
        nextCursor: result.truncated ? Buffer.from(String(page.offset + result.rowCount)).toString("base64url") : null,
        truncated: result.truncated,
      };
    },
    execute_read_query(input, backend) {
      return backend.executeReadQuery(
        requiredInputString(input.query, "query"),
        readParameters(input.parameters),
        readLimits(input),
      );
    },
  };

  return {
    executors: defineProviderExecutors<DatabaseBackend>({
      service,
      handlers,
      async createContext(context: ExecutionContext): Promise<DatabaseBackend> {
        const credential = await requireCustomCredential(context, service);
        return createBackend(credential.values, context.signal);
      },
      mapError: mapDatabaseError,
      fallbackMessage: `${service} database request failed`,
    }),
    credentialValidators: {
      async customCredential(input, { signal }): Promise<CredentialValidationResult> {
        try {
          const backend = await createBackend(input.values, signal);
          const identity = await backend.validate();
          return validationResult(identity.engine, identity.version, backend.config);
        } catch (error) {
          throw providerRequestError(error);
        }
      },
    },
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
