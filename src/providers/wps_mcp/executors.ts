import type { CredentialValidators, ProviderExecutors, ProviderProxyExecutor } from "../../core/types.ts";
import type { ProviderResourceCandidate } from "../provider-loader.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";
import type { ApiKeyProviderContext, ProviderRuntimeHandler } from "../provider-runtime.ts";
import type { Client } from "@modelcontextprotocol/client";

import { createHash } from "node:crypto";
import { withMcpClient } from "../mcp-client.ts";
import {
  boundedProviderActionResult,
  boundedProviderResourceSchema,
  defineApiKeyProviderExecutors,
  defineProviderProxy,
  mapProviderActionHandlers,
  ProviderRequestError,
  providerUserAgent,
} from "../provider-runtime.ts";
import { wpsMcpActions } from "./actions.ts";

export const wpsMcpEndpoint = "https://mcp-center.wps.cn/skill_hub/mcp";
const requestTimeoutMs = 55_000;
const requiredReadTools = ["search_files", "list_my_files", "list_files", "get_file_info", "read_file"];

const handlers: ProviderActionHandlers<
  "wps_mcp",
  ProviderRuntimeHandler<ApiKeyProviderContext>
> = mapProviderActionHandlers(
  "wps_mcp",
  wpsMcpActions,
  (_action, name) => (input, context) => executeWpsAction(name, input, context),
);

export const executors: ProviderExecutors = defineApiKeyProviderExecutors("wps_mcp", handlers, {
  skipDnsValidation: true,
});

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service: "wps_mcp",
  baseUrl: wpsMcpEndpoint,
  auth: { type: "bearer" },
  customizeRequest({ headers }) {
    headers.set("accept", "application/json, text/event-stream");
    headers.set("user-agent", providerUserAgent);
  },
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher, signal }) {
    const tools = await listTools(input.apiKey, fetcher, signal);
    if (tools.length === 0) throw new ProviderRequestError(400, "WPS MCP did not expose any tools for this token");
    const toolNames = new Set(tools.map((tool) => tool.name));
    const missingReadTool = requiredReadTools.find((toolName) => !toolNames.has(toolName));
    if (missingReadTool) {
      throw new ProviderRequestError(403, `WPS MCP token is missing required read capability: ${missingReadTool}`);
    }
    const grantedScopes = [
      ...(wpsMcpActions.some(
        (action) => action.requiredScopes.includes("wps_mcp.files.read") && toolNames.has(action.name),
      )
        ? ["wps_mcp.files.read"]
        : []),
      ...(wpsMcpActions.some(
        (action) => action.requiredScopes.includes("wps_mcp.files.write") && toolNames.has(action.name),
      )
        ? ["wps_mcp.files.write"]
        : []),
      "wps_mcp.tools.inspect",
      "wps_mcp.tools.invoke",
    ];
    const tokenHash = createHash("sha256").update(input.apiKey).digest("hex").slice(0, 16);
    return {
      profile: {
        accountId: `wps-mcp:${tokenHash}`,
        displayName: `WPS MCP ${tokenHash.slice(-6)}`,
        grantedScopes,
      },
      metadata: { mcpEndpoint: wpsMcpEndpoint, discoveredToolCount: tools.length },
    };
  },
};

async function executeWpsAction(
  actionName: string,
  input: Record<string, unknown>,
  context: ApiKeyProviderContext,
): Promise<unknown> {
  if (actionName === "list_tools") return { tools: await listTools(context.apiKey, context.fetcher, context.signal) };
  const toolName = actionName === "call_tool" ? requireString(input.toolName, "toolName") : actionName;
  const args = actionName === "call_tool" ? readArguments(input.arguments) : input;
  const output = await withWpsClient(context.apiKey, context.fetcher, context.signal, async (client) => {
    const result = await client.callTool(
      { name: toolName, arguments: args },
      { timeout: requestTimeoutMs, signal: context.signal },
    );
    if (result.isError) throw new ProviderRequestError(502, `WPS MCP tool ${toolName} returned an error`);
    if (result.structuredContent) return result.structuredContent;
    const text = result.content.find((item) => item.type === "text");
    if (!text || text.type !== "text") return result;
    try {
      return JSON.parse(text.text) as unknown;
    } catch {
      return text.text;
    }
  });
  const bounded = boundedProviderActionResult(output);
  return actionName === "call_tool" ? { result: bounded } : bounded;
}

async function listTools(apiKey: string, fetcher: typeof fetch, signal?: AbortSignal) {
  return withWpsClient(apiKey, fetcher, signal, async (client) => {
    const result = await client.listTools({}, { timeout: requestTimeoutMs, signal });
    return result.tools;
  });
}

function withWpsClient<T>(
  apiKey: string,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  return withMcpClient(
    {
      endpoint: new URL(wpsMcpEndpoint),
      transport: "streamable_http",
      fetcher,
      headers: { authorization: `Bearer ${apiKey}`, "user-agent": providerUserAgent },
      signal,
      protocolVersion: "legacy",
    },
    run,
  );
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new ProviderRequestError(400, `${name} is required`);
}

function readArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function discoverResources(
  context: import("../../core/types.ts").ExecutionContext,
  fetcher: typeof fetch,
): Promise<
  Array<{
    sourceType: "wps_mcp";
    resourceId: string;
    title?: string;
    mimeType?: string;
    version?: string;
    schema?: Record<string, unknown>;
    url?: string;
  }>
> {
  const credential = await context.getCredential("wps_mcp");
  if (credential?.authType !== "api_key") {
    throw new ProviderRequestError(401, "Connect wps_mcp with an official MCP token first.");
  }
  const output = await executeWpsAction(
    "list_my_files",
    { page_size: 100, with_permission: true, with_ext_attrs: true },
    { apiKey: credential.apiKey, fetcher, signal: context.signal },
  );
  return findWpsRecords(output)
    .slice(0, 100)
    .flatMap((record) => {
      const resourceId = readFirstString(record, ["file_id", "fileId", "id"]);
      if (!resourceId) return [];
      const fileType = readFirstString(record, ["type", "file_type", "fileType"]) ?? "file";
      return [
        {
          sourceType: "wps_mcp" as const,
          resourceId,
          title: readFirstString(record, ["name", "file_name", "fname"]),
          mimeType: `application/vnd.wps.${fileType.replace(/[^a-z0-9-]/giu, "") || "file"}`,
          version: readFirstString(record, ["version", "etag", "mtime"]),
          schema: boundedProviderResourceSchema(record),
          url: safeWpsTraceUrl(readFirstString(record, ["url", "web_url", "link"])),
        },
      ];
    });
}

export function observeActionResources(actionId: string, output: unknown): ProviderResourceCandidate[] {
  if (!["wps_mcp.search_files", "wps_mcp.list_my_files", "wps_mcp.list_files"].includes(actionId)) return [];
  return findWpsRecords(output)
    .slice(0, 100)
    .flatMap((record) => {
      const resourceId = readFirstString(record, ["file_id", "fileId", "id"]);
      if (!resourceId) return [];
      const fileType = readFirstString(record, ["type", "file_type", "fileType"]) ?? "file";
      return [
        {
          sourceType: "wps_mcp",
          resourceId,
          title: readFirstString(record, ["name", "file_name", "fname"]),
          mimeType: `application/vnd.wps.${fileType.replace(/[^a-z0-9-]/giu, "") || "file"}`,
          version: readFirstString(record, ["version", "etag", "mtime"]),
          schema: boundedProviderResourceSchema(record),
          url: safeWpsTraceUrl(readFirstString(record, ["url", "web_url", "link"])),
        },
      ];
    });
}

function findWpsRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item),
    );
  }
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["items", "files", "list", "data"]) {
    const records = findWpsRecords(record[key]);
    if (records.length > 0) return records;
  }
  return [];
}

function readFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function safeWpsTraceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !(
        hostname === "wps.cn" ||
        hostname.endsWith(".wps.cn") ||
        hostname === "kdocs.cn" ||
        hostname.endsWith(".kdocs.cn")
      )
    ) {
      return undefined;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
