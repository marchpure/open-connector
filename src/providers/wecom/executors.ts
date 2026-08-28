import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
} from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";

import { optionalBoolean, optionalRecord, optionalString } from "../../core/cast.ts";
import {
  boundedProviderResourceSchema,
  boundedProviderActionResult,
  defineProviderExecutors,
  ProviderRequestError,
  readProviderJsonBody,
} from "../provider-runtime.ts";

const service = "wecom";
interface WeComContext {
  values: Record<string, string>;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}
type WeComHandler = (input: Record<string, unknown>, context: WeComContext) => Promise<unknown>;

export const wecomActionHandlers: ProviderActionHandlers<"wecom", WeComHandler> = {
  get_application_identity: async (_input, context) => {
    await getToken(context);
    return { corpId: mask(context.values.corpId), agentId: context.values.agentId };
  },
  list_departments: async (_input, context) => {
    const payload = await api(context, "/cgi-bin/department/list");
    return boundedProviderItems(payload.department, 500);
  },
  list_users: async (input, context) => {
    const departmentId = optionalString(input.departmentId) ?? optionalString(context.values.departmentId) ?? "1";
    const payload = await api(context, "/cgi-bin/user/list", {
      department_id: departmentId,
      fetch_child: optionalBoolean(input.fetchChild) === true ? "1" : "0",
    });
    const items = boundedProviderItems(payload.userlist, 1000);
    return { items, total: items.length };
  },
  get_group_chat: async (input, context) => {
    const chatId = required(input.chatId, "chatId");
    return boundedProviderActionResult(await api(context, "/cgi-bin/appchat/get", { chatid: chatId }));
  },
};

export const executors: ProviderExecutors = defineProviderExecutors<WeComContext>({
  service,
  handlers: wecomActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<WeComContext> {
    const credential = await context.getCredential(service);
    if (credential?.authType !== "custom_credential")
      throw new ProviderRequestError(401, "Configure wecom credentials first.");
    return { values: credential.values, fetcher, signal: context.signal };
  },
});

function boundedProviderItems(value: unknown, maxItems: number): Array<Record<string, unknown>> {
  return (Array.isArray(value) ? value : [])
    .slice(0, maxItems)
    .map((item) => optionalRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .map((item) => boundedProviderResourceSchema(item));
}

export const credentialValidators: CredentialValidators = {
  async customCredential(input, { fetcher, signal }): Promise<CredentialValidationResult> {
    const context = { values: input.values, fetcher, signal };
    const token = await getToken(context);
    return {
      profile: {
        accountId: input.values.corpId,
        displayName: `WeCom enterprise app ${input.values.agentId}`,
        grantedScopes: [],
      },
      grantedScopes: [],
      metadata: {
        identityType: "enterprise_application",
        agentId: input.values.agentId,
        tokenKind: "access_token",
        tokenValidated: Boolean(token),
      },
    };
  },
};

export async function discoverResources(
  context: ExecutionContext,
  fetcher: typeof fetch,
): Promise<
  Array<{
    sourceType: "wecom";
    resourceId: string;
    title?: string;
    mimeType?: string;
    schema?: Record<string, unknown>;
  }>
> {
  const credential = await context.getCredential(service);
  if (credential?.authType !== "custom_credential")
    throw new ProviderRequestError(401, "Configure WeCom credentials first.");
  const response = await api(
    { values: credential.values, fetcher, signal: context.signal },
    "/cgi-bin/department/list",
  );
  const resources: Array<{
    sourceType: "wecom";
    resourceId: string;
    title?: string;
    mimeType?: string;
    schema?: Record<string, unknown>;
  }> = [];
  const seen = new Set<string>();
  for (const item of (Array.isArray(response.department) ? response.department : []).slice(0, 500)) {
    const record = optionalRecord(item);
    if (!record) continue;
    const resourceId =
      optionalString(record.id) ??
      (typeof record.id === "number" && Number.isSafeInteger(record.id) ? String(record.id) : undefined) ??
      optionalString(record.department_id);
    if (!resourceId || seen.has(resourceId)) continue;
    seen.add(resourceId);
    resources.push({
      sourceType: "wecom",
      resourceId,
      title: optionalString(record.name) ?? optionalString(record.name_en),
      mimeType: "application/vnd.wecom.department",
      schema: boundedProviderResourceSchema(record),
    });
  }
  return resources;
}

async function getToken(context: WeComContext): Promise<string> {
  const url = new URL("https://qyapi.weixin.qq.com/cgi-bin/gettoken");
  url.searchParams.set("corpid", context.values.corpId);
  url.searchParams.set("corpsecret", context.values.secret);
  const payload = await json(context, url);
  if (Number(payload.errcode) !== 0 || typeof payload.access_token !== "string")
    throw new ProviderRequestError(401, "WeCom credentials were rejected");
  return payload.access_token;
}

async function api(
  context: WeComContext,
  path: string,
  query: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const token = await getToken(context);
  const url = new URL(`https://qyapi.weixin.qq.com${path}`);
  url.searchParams.set("access_token", token);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const payload = await json(context, url);
  if (Number(payload.errcode) !== 0) throw new ProviderRequestError(403, "WeCom API authorization failed");
  return payload;
}

async function json(context: WeComContext, url: URL): Promise<Record<string, unknown>> {
  const response = await context.fetcher(url, { headers: { accept: "application/json" }, signal: context.signal });
  const payload = await readProviderJsonBody(response, {
    emptyBody: {},
    invalidJsonMessage: "invalid WeCom JSON response",
  });
  if (!response.ok || !payload || typeof payload !== "object" || Array.isArray(payload))
    throw new ProviderRequestError(response.status, "invalid WeCom response");
  return payload as Record<string, unknown>;
}

function required(value: unknown, name: string): string {
  const result = optionalString(value);
  if (!result) throw new ProviderRequestError(400, `${name} is required`);
  return result;
}

function mask(value: string): string {
  return value.length <= 6 ? "***" : `${value.slice(0, 3)}***${value.slice(-3)}`;
}
