import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ExecutionResult,
  ProviderExecutors,
  ProviderProxyExecutor,
} from "../../core/types.ts";

import { optionalRecord, optionalString } from "../../core/cast.ts";
import {
  boundedProviderResourceSchema,
  boundedProviderActionResult,
  createProviderFetch,
  createProviderProxyUrl,
  normalizeProviderProxyHeaders,
  ProviderRequestError,
  providerUserAgent,
  readProviderProxyErrorMessage,
  readProviderProxyResponse,
  requireOAuthCredential,
  toProviderExecutionError,
  toProviderProxyError,
} from "../provider-runtime.ts";
import { tencentDocsActionHandlers, tencentDocsApiBaseUrl } from "./runtime.ts";

const service = "tencent_docs";

const tencentDocsFetch = createProviderFetch({ skipDnsValidation: true });

export const executors: ProviderExecutors = Object.fromEntries(
  Object.entries(tencentDocsActionHandlers).map(([name, handler]) => [
    `${service}.${name}`,
    async (input: unknown, context: ExecutionContext): Promise<ExecutionResult> => {
      try {
        const credential = await context.getCredential(service);
        if (credential?.authType !== "oauth2") {
          throw new ProviderRequestError(401, "Connect tencent_docs with OAuth first.");
        }
        const clientId =
          optionalString(credential.metadata.clientId) ??
          optionalString(credential.metadata.client_id) ??
          optionalString(credential.metadata.clientID);
        const openID =
          optionalString(credential.metadata.openID) ??
          optionalString(credential.metadata.openId) ??
          optionalString(credential.metadata.user_id);
        if (!clientId && name !== "get_current_user") {
          throw new ProviderRequestError(400, "tencent_docs OpenAPI actions require clientId in OAuth metadata.");
        }
        if (!openID && name !== "get_current_user") {
          throw new ProviderRequestError(400, "tencent_docs OpenAPI actions require openID in OAuth metadata.");
        }

        return {
          ok: true,
          output: boundedProviderActionResult(
            await handler(input as Record<string, unknown>, {
              accessToken: credential.accessToken,
              clientId: clientId ?? "",
              openID: openID ?? "",
              fetcher: tencentDocsFetch,
              signal: context.signal,
            }),
          ),
        };
      } catch (error) {
        return toProviderExecutionError(error, "tencent_docs request failed");
      }
    },
  ]),
);

export const proxy: ProviderProxyExecutor = async (input, context) => {
  try {
    const credential = await requireOAuthCredential(context, service);
    const clientId =
      optionalString(credential.metadata.clientId) ??
      optionalString(credential.metadata.client_id) ??
      optionalString(credential.metadata.clientID);
    const openID =
      optionalString(credential.metadata.openID) ??
      optionalString(credential.metadata.openId) ??
      optionalString(credential.metadata.user_id);
    if (!clientId) {
      throw new ProviderRequestError(400, "tencent_docs OpenAPI proxy requires clientId in OAuth metadata.");
    }
    if (!openID) {
      throw new ProviderRequestError(400, "tencent_docs OpenAPI proxy requires openID in OAuth metadata.");
    }

    const url = createProviderProxyUrl(tencentDocsApiBaseUrl, input.endpoint, input.query);
    const headers = normalizeProviderProxyHeaders(input.headers);
    headers.set("access-token", credential.accessToken);
    headers.set("client-id", clientId);
    headers.set("open-id", openID);
    headers.set("user-agent", providerUserAgent);

    const init: RequestInit = {
      method: input.method,
      headers,
      signal: context.signal,
    };
    if (input.body !== undefined) {
      init.body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
      if (!headers.has("content-type") && typeof input.body !== "string") {
        headers.set("content-type", "application/json");
      }
    }

    const response = await tencentDocsFetch(url, init);
    if (!response.ok) {
      const text = await readProviderProxyErrorMessage(response, "");
      throw new ProviderRequestError(
        response.status,
        text || `tencent_docs request failed with HTTP ${response.status}`,
      );
    }
    return { ok: true, response: await readProviderProxyResponse(response) };
  } catch (error) {
    return toProviderProxyError(error, "tencent_docs request failed");
  }
};

export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher }): Promise<CredentialValidationResult> {
    const url = new URL("https://docs.qq.com/oauth/v2/userinfo");
    url.searchParams.set("access_token", input.accessToken);
    const response = await fetcher(url.toString());
    const envelope = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || envelope.ret !== 0) {
      throw new ProviderRequestError(
        response.status || 502,
        optionalString(envelope.msg) ?? "Tencent Docs userinfo failed.",
      );
    }

    const data = optionalRecord(envelope.data) ?? {};
    const openID = optionalString(data.openID) ?? optionalString(data.openId);
    if (!openID) {
      throw new ProviderRequestError(502, "tencent_docs userinfo response is missing openID.");
    }
    const nick = optionalString(data.nick);

    return {
      profile: {
        accountId: openID,
        displayName: nick ?? openID,
      },
      metadata: {
        ...input.metadata,
        clientId: optionalString(input.metadata.oauthClientId) ?? optionalString(input.metadata.clientId),
        openID,
        nick,
      },
    };
  },
};

export async function discoverResources(
  context: ExecutionContext,
  fetcher: typeof fetch,
): Promise<
  Array<{
    sourceType: "tencent_docs";
    resourceId: string;
    title?: string;
    mimeType?: string;
    version?: string;
    schema?: Record<string, unknown>;
    owner?: { id: string; displayName?: string };
    aclSummary?: { visibility: "private" | "shared" };
    url?: string;
  }>
> {
  const credential = await requireOAuthCredential(context, service);
  const clientId =
    optionalString(credential.metadata.clientId) ??
    optionalString(credential.metadata.client_id) ??
    optionalString(credential.metadata.oauthClientId);
  const openID =
    optionalString(credential.metadata.openID) ??
    optionalString(credential.metadata.openId) ??
    optionalString(credential.metadata.user_id);
  if (!clientId || !openID) {
    throw new ProviderRequestError(400, "tencent_docs discovery requires clientId and openID OAuth metadata.");
  }
  const output = (await tencentDocsActionHandlers.list_folder(
    { start: 0, limit: 100 },
    { accessToken: credential.accessToken, clientId, openID, fetcher, signal: context.signal },
  )) as { items?: unknown[] };
  return (output.items ?? []).slice(0, 100).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const resourceId = optionalString(item.ID);
    if (!resourceId) return [];
    const type = optionalString(item.type) ?? "file";
    const ownerId = optionalString(item.ownerID);
    return [
      {
        sourceType: "tencent_docs" as const,
        resourceId,
        title: optionalString(item.title),
        mimeType: tencentDocsMimeType(type),
        version:
          optionalString(item.lastModifyTime) ??
          (typeof item.lastModifyTime === "number" ? String(item.lastModifyTime) : undefined),
        schema: boundedProviderResourceSchema(item),
        owner: ownerId ? { id: ownerId, displayName: optionalString(item.ownerName) } : undefined,
        aclSummary: { visibility: item.isOwner === true ? ("private" as const) : ("shared" as const) },
        url: optionalString(item.url),
      },
    ];
  });
}

function tencentDocsMimeType(type: string): string {
  if (type === "doc") return "application/vnd.tencent-docs.doc";
  if (type === "sheet") return "application/vnd.tencent-docs.sheet";
  if (type === "smartsheet") return "application/vnd.tencent-docs.smartsheet";
  if (type === "folder") return "application/vnd.tencent-docs.folder";
  return `application/vnd.tencent-docs.${type.replace(/[^a-z0-9-]/giu, "") || "file"}`;
}
