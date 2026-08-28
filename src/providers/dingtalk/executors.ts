import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
} from "../../core/types.ts";
import type { OAuthProviderContext, ProviderActionHandlers } from "../provider-runtime.ts";

import { compactObject, optionalInteger, optionalRecord, optionalString } from "../../core/cast.ts";
import { defineOAuthProviderExecutors, ProviderRequestError, readProviderJsonBody } from "../provider-runtime.ts";

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
  _context: ExecutionContext,
  _fetcher: typeof fetch,
): Promise<Array<{ sourceType: "dingtalk"; resourceId: string; title?: string; schema?: Record<string, unknown> }>> {
  // The current DingTalk action surface is identity and directory-only. A
  // user or department is not a knowledge resource, so discovery stays empty
  // until a document/knowledge API is added with an upstream visibility check.
  return [];
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
