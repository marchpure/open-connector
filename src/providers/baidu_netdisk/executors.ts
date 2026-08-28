import type { CredentialValidators, ProviderExecutors, TransitFileWriter } from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";

import { optionalString, requiredString } from "../../core/cast.ts";
import {
  boundedProviderResourceSchema,
  boundedProviderActionResult,
  defineProviderExecutors,
  mapProviderActionHandlers,
  requireOAuthCredential,
} from "../provider-runtime.ts";
import { baiduNetdiskActions } from "./actions.ts";
import { executeBaiduNetdiskMcpAction, verifyBaiduNetdiskMcpConnection } from "./runtime-mcp.ts";
import {
  createBaiduNetdiskFolder,
  downloadBaiduNetdiskFile,
  fetchBaiduNetdiskAccount,
  getBaiduNetdiskQuota,
} from "./runtime.ts";

interface BaiduNetdiskContext {
  accessToken: string;
  fetcher: typeof fetch;
  transitFiles?: TransitFileWriter;
  signal?: AbortSignal;
}

type BaiduNetdiskHandler = (input: Record<string, unknown>, context: BaiduNetdiskContext) => Promise<unknown>;

const handlers: ProviderActionHandlers<"baidu_netdisk", BaiduNetdiskHandler> = mapProviderActionHandlers(
  "baidu_netdisk",
  baiduNetdiskActions,
  (_action, name): BaiduNetdiskHandler => {
    switch (name) {
      case "get_current_account":
        return async (_input, context) => {
          const account = await fetchBaiduNetdiskAccount(context.accessToken, context.fetcher);
          return {
            accountId: account.accountId,
            accountLabel: account.accountLabel,
            avatarUrl: account.avatarUrl,
            membership: account.membership,
          };
        };
      case "get_quota":
        return (_input, context) => getBaiduNetdiskQuota(context);
      case "download_file":
        return downloadBaiduNetdiskFile;
      case "create_folder":
        return createBaiduNetdiskFolder;
      default:
        return async (input, context) =>
          boundedProviderActionResult(await executeBaiduNetdiskMcpAction(name, input, context));
    }
  },
);

export const executors: ProviderExecutors = defineProviderExecutors({
  service: "baidu_netdisk",
  handlers,
  async createContext(context, fetcher) {
    const credential = await requireOAuthCredential(context, "baidu_netdisk");
    return {
      accessToken: credential.accessToken,
      fetcher,
      transitFiles: context.transitFiles,
      signal: context.signal,
    };
  },
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher }) {
    const [account] = await Promise.all([
      fetchBaiduNetdiskAccount(input.accessToken, fetcher),
      verifyBaiduNetdiskMcpConnection(input.accessToken, fetcher),
    ]);
    return {
      profile: {
        accountId: requiredString(account.accountId, "baidu_netdisk account id"),
        displayName: optionalString(account.accountLabel) ?? account.accountId,
      },
      metadata: account.providerMetadata,
    };
  },
};

export async function discoverResources(
  context: import("../../core/types.ts").ExecutionContext,
  fetcher: typeof fetch,
): Promise<
  Array<{
    sourceType: "baidu_netdisk";
    resourceId: string;
    resourceToken?: string;
    title?: string;
    mimeType?: string;
    version?: string;
    etag?: string;
    schema?: Record<string, unknown>;
    url?: string;
  }>
> {
  const credential = await requireOAuthCredential(context, "baidu_netdisk");
  const output = (await executeBaiduNetdiskMcpAction(
    "list_files",
    { path: "/", page: 1, type: "all" },
    { accessToken: credential.accessToken, fetcher, signal: context.signal },
  )) as { items?: unknown[] };
  return (output.items ?? []).slice(0, 100).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const resourceId = optionalString(item.id);
    if (!resourceId) return [];
    const kind = optionalString(item.kind) ?? "file";
    return [
      {
        sourceType: "baidu_netdisk" as const,
        resourceId,
        resourceToken: optionalString(item.path),
        title: optionalString(item.name),
        mimeType: `application/vnd.baidu-netdisk.${kind}`,
        version: optionalString(item.modifiedAt),
        etag: optionalString(item.cloudMd5),
        schema: boundedProviderResourceSchema(item),
        url: `https://pan.baidu.com/disk/main#/index?path=${encodeURIComponent(optionalString(item.path) ?? "/")}`,
      },
    ];
  });
}
