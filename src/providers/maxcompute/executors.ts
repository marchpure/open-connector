import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
} from "../../core/types.ts";

import {
  GetProjectRequest,
  GetTableInfoResponseBodyDataNativeColumns,
  GetTableInfoResponseBodyDataPartitionColumns,
  GetTableInfoRequest,
  ListProjectsRequest,
  ListProjectsResponseBodyDataProjects,
  ListTablesRequest,
  ListTablesResponseBodyDataTables,
} from "@alicloud/maxcompute20220104";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import { createRequire } from "node:module";
import { assertGuardedEgressUrl } from "../../core/guarded-fetch.ts";
import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import {
  defineProviderExecutors,
  ProviderRequestError,
  requireCustomCredential,
  toProviderProxyError,
} from "../provider-runtime.ts";

interface MaxComputeContext {
  client: MaxComputeSdkClient;
  project: string;
  regionId: string;
}

interface MaxComputeSdkClient {
  getProject(
    project: string,
    request: GetProjectRequest,
  ): Promise<{
    body?: { data?: unknown };
  }>;
  listProjects(request: ListProjectsRequest): Promise<{
    body?: {
      data?: {
        projects?: ListProjectsResponseBodyDataProjects[];
        marker?: string;
      };
    };
  }>;
  listTables(
    project: string,
    request: ListTablesRequest,
  ): Promise<{
    body?: {
      data?: {
        tables?: ListTablesResponseBodyDataTables[];
        marker?: string;
      };
    };
  }>;
  getTableInfo(
    project: string,
    table: string,
    request: GetTableInfoRequest,
  ): Promise<{
    body?: {
      data?: {
        nativeColumns?: GetTableInfoResponseBodyDataNativeColumns[];
        partitionColumns?: GetTableInfoResponseBodyDataPartitionColumns[];
        type?: string;
        comment?: string;
        lifecycle?: string;
      };
    };
  }>;
}

interface MaxComputeSdkConstructor {
  new (config: $OpenApiUtil.Config): MaxComputeSdkClient;
}

const require = createRequire(import.meta.url);
const maxComputeModule = require("@alicloud/maxcompute20220104") as {
  default: MaxComputeSdkConstructor;
};

const handlers = {
  async validate_connection(_input: Record<string, unknown>, context: MaxComputeContext) {
    await context.client.getProject(context.project, new GetProjectRequest({ verbose: false }));
    return { ok: true, project: context.project, region: context.regionId };
  },
  async list_projects(input: Record<string, unknown>, context: MaxComputeContext) {
    const response = await context.client.listProjects(
      new ListProjectsRequest({
        region: context.regionId,
        marker: optionalString(input.cursor),
        maxItem: boundedPageSize(input.pageSize),
      }),
    );
    const projects = (response.body?.data?.projects ?? []).map((project: ListProjectsResponseBodyDataProjects) => ({
      name: String(project.name ?? ""),
    }));
    const nextCursor = response.body?.data?.marker ?? null;
    return { projects, nextCursor, truncated: nextCursor !== null };
  },
  async list_tables(input: Record<string, unknown>, context: MaxComputeContext) {
    const project = optionalString(input.project) ?? context.project;
    assertMaxComputeProjectScope(project, context.project);
    const schema = optionalString(input.schema) ?? "default";
    const response = await context.client.listTables(
      project,
      new ListTablesRequest({
        schemaName: schema,
        marker: optionalString(input.cursor),
        maxItem: boundedPageSize(input.pageSize),
      }),
    );
    const tables = (response.body?.data?.tables ?? []).map((table: ListTablesResponseBodyDataTables) => ({
      project,
      schema: table.schema ?? schema,
      name: String(table.name ?? ""),
      type: table.type ?? "unknown",
    }));
    const nextCursor = response.body?.data?.marker ?? null;
    return { tables, nextCursor, truncated: nextCursor !== null };
  },
  async describe_table(input: Record<string, unknown>, context: MaxComputeContext) {
    const project = optionalString(input.project) ?? context.project;
    assertMaxComputeProjectScope(project, context.project);
    const schema = optionalString(input.schema) ?? "default";
    const table = requiredString(input.table, "table");
    const response = await context.client.getTableInfo(project, table, new GetTableInfoRequest({ schemaName: schema }));
    const data = response.body?.data;
    return {
      project,
      schema,
      table,
      columns: [
        ...(data?.nativeColumns ?? []).map((column: GetTableInfoResponseBodyDataNativeColumns) => ({
          name: String(column.name ?? ""),
          dataType: String(column.type ?? ""),
          partition: false,
        })),
        ...(data?.partitionColumns ?? []).map((column: GetTableInfoResponseBodyDataPartitionColumns) => ({
          name: String(column.name ?? ""),
          dataType: String(column.type ?? ""),
          partition: true,
        })),
      ],
      type: data?.type,
      comment: data?.comment,
      lifecycle: data?.lifecycle,
    };
  },
};

export const executors: ProviderExecutors = defineProviderExecutors<MaxComputeContext>({
  service: "maxcompute",
  handlers,
  async createContext(context: ExecutionContext): Promise<MaxComputeContext> {
    const credential = await requireCustomCredential(context, "maxcompute");
    return createContext(credential.values);
  },
  mapError: (error) => toProviderProxyError(error, "MaxCompute request failed"),
});

export const credentialValidators: CredentialValidators = {
  async customCredential(input): Promise<CredentialValidationResult> {
    const context = await createContext(input.values);
    await context.client.getProject(context.project, new GetProjectRequest({ verbose: false }));
    return {
      profile: {
        accountId: `maxcompute:${context.regionId}:${context.project}`,
        displayName: `MaxCompute - ${context.project}`,
      },
      grantedScopes: ["metadata:read"],
      metadata: { regionId: context.regionId, project: context.project },
    };
  },
};

async function createContext(values: Record<string, string>): Promise<MaxComputeContext> {
  const endpoint = requiredHttpsEndpoint(values.endpoint);
  await assertGuardedEgressUrl(endpoint.toString(), {
    fieldName: "MaxCompute endpoint",
    allowPrivateNetwork: isPrivateNetworkAccessAllowed(),
    createError: (message) => new ProviderRequestError(400, message),
  });
  const regionId = requiredString(values.regionId, "regionId");
  const project = requiredString(values.project, "project");
  const config = new $OpenApiUtil.Config({
    accessKeyId: requiredString(values.accessKeyId, "accessKeyId"),
    accessKeySecret: requiredString(values.accessKeySecret, "accessKeySecret"),
    securityToken: optionalString(values.securityToken),
    endpoint: endpoint.host,
    protocol: "https",
    regionId,
    connectTimeout: 10_000,
    readTimeout: 30_000,
  });
  return { client: new maxComputeModule.default(config), project, regionId };
}

function requiredHttpsEndpoint(value: unknown): URL {
  const text = requiredString(value, "endpoint");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ProviderRequestError(400, "MaxCompute endpoint must be an absolute HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") {
    throw new ProviderRequestError(400, "MaxCompute endpoint must be an origin-only HTTPS URL without credentials.");
  }
  if (url.hostname !== "aliyuncs.com" && !url.hostname.endsWith(".aliyuncs.com")) {
    throw new ProviderRequestError(400, "MaxCompute endpoint must use an official aliyuncs.com hostname.");
  }
  return url;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ProviderRequestError(400, `${field} is required.`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedPageSize(value: unknown): number {
  const number = value === undefined ? 100 : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 100) {
    throw new ProviderRequestError(400, "pageSize must be an integer from 1 to 100.");
  }
  return number;
}

export function assertMaxComputeProjectScope(project: string, configuredProject: string): void {
  if (project !== configuredProject) {
    throw new ProviderRequestError(
      403,
      "MaxCompute table operations are restricted to the configured project.",
    );
  }
}
