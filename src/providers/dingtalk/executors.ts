import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
} from "../../core/types.ts";
import type { OAuthProviderContext, ProviderActionHandlers } from "../provider-runtime.ts";

import { compactObject, optionalInteger, optionalRecord, optionalString } from "../../core/cast.ts";
import {
  boundedProviderResourceSchema,
  defineOAuthProviderExecutors,
  ProviderRequestError,
  readProviderJsonBody,
} from "../provider-runtime.ts";

const service = "dingtalk";
type DingTalkHandler = (input: Record<string, unknown>, context: OAuthProviderContext) => Promise<unknown>;

export const dingtalkActionHandlers: ProviderActionHandlers<"dingtalk", DingTalkHandler> = {
  get_current_user: (_input, context) => request(context, "/v1.0/contact/users/me"),
  get_user: (input, context) =>
    request(context, `/v1.0/contact/users/${encodeURIComponent(required(input.userId, "userId"))}`),
  search_users: async (input, context) => {
    const payload = await request(
      context,
      "/v1.0/contact/users/search",
      "POST",
      compactObject({
        queryWord: optionalString(input.query),
        offset: optionalInteger(input.offset) ?? 0,
        size: bounded(input.size, 50),
      }),
    );
    const record = optionalRecord(payload);
    return {
      items: Array.isArray(record?.users) ? record.users : Array.isArray(record?.list) ? record.list : [],
      nextCursor: optionalString(record?.nextCursor),
      hasMore: record?.hasMore === true,
    };
  },
  list_departments: async (input, context) => {
    const query = new URLSearchParams();
    const parentId = optionalString(input.parentId);
    if (parentId) query.set("parent_id", parentId);
    query.set("max_results", String(bounded(input.maxResults, 50)));
    const payload = await request(context, `/v1.0/contact/departments?${query}`);
    const record = optionalRecord(payload);
    return {
      items: Array.isArray(record?.departments) ? record.departments : Array.isArray(record?.list) ? record.list : [],
      nextCursor: optionalString(record?.nextCursor),
      hasMore: record?.hasMore === true,
    };
  },
};

export const executors: ProviderExecutors = defineOAuthProviderExecutors(service, dingtalkActionHandlers);

export async function discoverResources(
  context: ExecutionContext,
  fetcher: typeof fetch,
): Promise<
  Array<{
    sourceType: "dingtalk";
    resourceId: string;
    title?: string;
    mimeType?: string;
    schema?: Record<string, unknown>;
  }>
> {
  const credential = await context.getCredential(service);
  if (credential?.authType !== "oauth2") throw new ProviderRequestError(401, "Configure DingTalk OAuth first.");
  const resources: Array<{
    sourceType: "dingtalk";
    resourceId: string;
    title?: string;
    mimeType?: string;
    schema?: Record<string, unknown>;
  }> = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 3 && resources.length < 500; page += 1) {
    const query = new URLSearchParams({
      max_results: "100",
      ...(cursor ? { cursor } : {}),
    });
    const data = optionalRecord(
      await request(
        { accessToken: credential.accessToken, tokenType: credential.tokenType, fetcher, signal: context.signal },
        `/v1.0/contact/departments?${query}`,
      ),
    );
    const items = Array.isArray(data?.departments) ? data.departments : Array.isArray(data?.list) ? data.list : [];
    for (const item of items.slice(0, 100)) {
      const record = optionalRecord(item);
      if (!record) continue;
      const resourceId =
        optionalString(record.deptId) ??
        optionalString(record.dept_id) ??
        optionalString(record.id) ??
        optionalString(record.departmentId);
      if (!resourceId || seen.has(resourceId)) continue;
      seen.add(resourceId);
      resources.push({
        sourceType: "dingtalk",
        resourceId,
        title: optionalString(record.name) ?? optionalString(record.nameEn),
        mimeType: "application/vnd.dingtalk.department",
        schema: boundedProviderResourceSchema(record),
      });
    }
    if (data?.hasMore !== true && data?.has_more !== true) break;
    const next = optionalString(data?.nextCursor) ?? optionalString(data?.next_cursor) ?? optionalString(data?.cursor);
    if (!next || next === cursor) break;
    cursor = next;
  }
  return resources;
}

export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher, signal }): Promise<CredentialValidationResult> {
    const data = await request(
      { accessToken: input.accessToken, tokenType: input.tokenType, fetcher, signal },
      "/v1.0/contact/users/me",
    );
    const record = optionalRecord(data);
    const accountId = optionalString(record?.unionId) ?? optionalString(record?.userId) ?? "dingtalk-user";
    return {
      profile: { accountId, displayName: optionalString(record?.nick) ?? accountId, grantedScopes: [] },
      metadata: { ...input.metadata, identityType: "user_access_token", userId: accountId },
    };
  },
};

async function request(
  context: Pick<OAuthProviderContext, "accessToken" | "tokenType" | "fetcher" | "signal">,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>,
): Promise<unknown> {
  const response = await context.fetcher(`https://api.dingtalk.com${path}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `${context.tokenType ?? "Bearer"} ${context.accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: context.signal,
  });
  const payload = await readProviderJsonBody(response, {
    emptyBody: {},
    invalidJsonMessage: "invalid DingTalk JSON response",
  });
  if (!response.ok) throw new ProviderRequestError(response.status, "DingTalk request failed");
  return payload;
}

function required(value: unknown, field: string): string {
  const result = optionalString(value);
  if (!result) throw new ProviderRequestError(400, `${field} is required`);
  return result;
}

function bounded(value: unknown, fallback: number): number {
  const result = optionalInteger(value);
  return result === undefined ? fallback : Math.min(Math.max(result, 1), 100);
}
