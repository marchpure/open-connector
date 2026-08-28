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
  boundedProviderActionResult,
  defineOAuthProviderExecutors,
  ProviderRequestError,
  readProviderJsonBody,
} from "../provider-runtime.ts";

const service = "dingtalk";
const maxPageSize = 100;
const maxCalendarWindowMs = 31 * 24 * 60 * 60 * 1_000;
const maxTodoWindowMs = 366 * 24 * 60 * 60 * 1_000;
type DingTalkHandler = (input: Record<string, unknown>, context: OAuthProviderContext) => Promise<unknown>;

export const dingtalkActionHandlers: ProviderActionHandlers<"dingtalk", DingTalkHandler> = {
  get_current_user: async (_input, context) =>
    boundedProviderActionResult(await request(context, "/v1.0/contact/users/me")),
  get_user: async (input, context) =>
    boundedProviderActionResult(
      await request(context, `/v1.0/contact/users/${encodeURIComponent(required(input.userId, "userId"))}`),
    ),
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
      items: boundedProviderItems(
        Array.isArray(record?.users) ? record.users : Array.isArray(record?.list) ? record.list : [],
        100,
      ),
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
      items: boundedProviderItems(
        Array.isArray(record?.departments) ? record.departments : Array.isArray(record?.list) ? record.list : [],
        100,
      ),
      nextCursor: optionalString(record?.nextCursor),
      hasMore: record?.hasMore === true,
    };
  },
  list_calendars: async (_input, context) => {
    const userId = await currentUnionId(context);
    return calendarPage(
      await request(context, `/v1.0/calendar/users/${encodeURIComponent(userId)}/calendars`, "GET", undefined, true),
    );
  },
  list_calendar_events: async (input, context) => {
    const userId = await currentUnionId(context);
    const calendarId = required(input.calendarId, "calendarId");
    const timeMin = requiredTimestamp(input.timeMin, "timeMin");
    const timeMax = requiredTimestamp(input.timeMax, "timeMax");
    requireWindow(timeMin, timeMax, maxCalendarWindowMs, "calendar");
    const query = new URLSearchParams({
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      maxResults: String(bounded(input.maxResults, 50)),
    });
    const cursor = optionalString(input.cursor);
    if (cursor) query.set("nextToken", cursor);
    return eventPage(
      await request(
        context,
        `/v1.0/calendar/users/${encodeURIComponent(userId)}/calendars/${encodeURIComponent(calendarId)}/events?${query}`,
        "GET",
        undefined,
        true,
      ),
      calendarId,
    );
  },
  list_todo_tasks: async (input, context) => {
    const unionId = await currentUnionId(context);
    const fromDueTime = optionalInteger(input.fromDueTime);
    const toDueTime = optionalInteger(input.toDueTime);
    if ((fromDueTime === undefined) !== (toDueTime === undefined)) {
      throw new ProviderRequestError(400, "todo due-time bounds must be provided together");
    }
    if (fromDueTime !== undefined && toDueTime !== undefined)
      requireWindow(fromDueTime, toDueTime, maxTodoWindowMs, "todo");
    return todoPage(
      await request(
        context,
        `/v1.0/todo/users/${encodeURIComponent(unionId)}/tasks/list`,
        "POST",
        compactObject({
          nextToken: optionalString(input.cursor),
          fromDueTime,
          toDueTime,
          isDone: typeof input.isDone === "boolean" ? input.isDone : undefined,
        }),
        true,
      ),
    );
  },
  get_todo_task: async (input, context) => {
    const unionId = await currentUnionId(context);
    return boundedProviderActionResult(
      await request(
        context,
        `/v1.0/todo/users/${encodeURIComponent(unionId)}/tasks/${encodeURIComponent(required(input.taskId, "taskId"))}`,
        "GET",
        undefined,
        true,
      ),
    );
  },
};

export const executors: ProviderExecutors = defineOAuthProviderExecutors(service, dingtalkActionHandlers);

function boundedProviderItems(value: unknown[], maxItems: number): Array<Record<string, unknown>> {
  return value
    .slice(0, maxItems)
    .map((item) => optionalRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .map((item) => boundedProviderResourceSchema(item));
}

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
    version?: string;
    etag?: string;
    owner?: { id: string; displayName?: string };
    aclSummary?: { visibility: "private" | "shared" | "team"; subjectCount?: number };
    url?: string;
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
    version?: string;
    etag?: string;
    owner?: { id: string; displayName?: string };
    aclSummary?: { visibility: "private" | "shared" | "team"; subjectCount?: number };
    url?: string;
  }> = [];
  const seen = new Set<string>();
  try {
    const currentUser = optionalRecord(
      await request(
        { accessToken: credential.accessToken, tokenType: credential.tokenType, fetcher, signal: context.signal },
        "/v1.0/contact/users/me",
      ),
    );
    if (currentUser) {
      const resourceId =
        optionalString(currentUser.unionId) ?? optionalString(currentUser.userId) ?? optionalString(currentUser.userid);
      if (resourceId) {
        resources.push({
          sourceType: "dingtalk",
          resourceId,
          title: optionalString(currentUser.nick) ?? optionalString(currentUser.name),
          mimeType: "application/vnd.dingtalk.user",
          schema: boundedProviderResourceSchema(currentUser),
        });
      }
    }
  } catch (error) {
    if (!(error instanceof ProviderRequestError) || (error.status !== 403 && error.status !== 404)) throw error;
  }
  try {
    const data = optionalRecord(
      await request(
        { accessToken: credential.accessToken, tokenType: credential.tokenType, fetcher, signal: context.signal },
        "/v1.0/contact/users/search",
        "POST",
        { offset: 0, size: 100 },
      ),
    );
    const users = Array.isArray(data?.users) ? data.users : Array.isArray(data?.list) ? data.list : [];
    for (const item of users.slice(0, 100)) {
      const record = optionalRecord(item);
      if (!record) continue;
      const resourceId =
        optionalString(record.unionId) ??
        optionalString(record.userId) ??
        optionalString(record.userid) ??
        optionalString(record.id);
      if (!resourceId || seen.has(resourceId)) continue;
      seen.add(resourceId);
      resources.push({
        sourceType: "dingtalk",
        resourceId,
        title: optionalString(record.name) ?? optionalString(record.nick),
        mimeType: "application/vnd.dingtalk.user",
        schema: boundedProviderResourceSchema(record),
      });
    }
  } catch (error) {
    if (!(error instanceof ProviderRequestError) || (error.status !== 403 && error.status !== 404)) throw error;
  }
  const identityContext = {
    accessToken: credential.accessToken,
    tokenType: credential.tokenType,
    fetcher,
    signal: context.signal,
  };
  try {
    const userId = await currentUnionId(identityContext);
    const calendars = calendarPage(
      await request(
        identityContext,
        `/v1.0/calendar/users/${encodeURIComponent(userId)}/calendars`,
        "GET",
        undefined,
        true,
      ),
    ).items;
    for (const calendar of calendars) {
      const calendarId = resourceId(calendar, ["id", "calendarId", "calendar_id"]);
      if (!calendarId || seen.has(`calendar:${calendarId}`)) continue;
      seen.add(`calendar:${calendarId}`);
      resources.push({
        sourceType: "dingtalk",
        resourceId: calendarId,
        title: optionalString(calendar.summary) ?? optionalString(calendar.name),
        mimeType: "application/vnd.dingtalk.calendar",
        schema: withResourceMetadata(calendar, "calendar", calendarId),
        version: optionalString(calendar.version) ?? optionalString(calendar.updated),
        etag: optionalString(calendar.etag),
        owner: { id: userId },
        aclSummary: { visibility: "private", subjectCount: 1 },
        url: safeSourceUrl(calendar),
      });
    }
  } catch (error) {
    if (!isOptionalDomainDenied(error)) throw error;
  }
  try {
    const unionId = await currentUnionId(identityContext);
    const tasks = todoPage(
      await request(identityContext, `/v1.0/todo/users/${encodeURIComponent(unionId)}/tasks/list`, "POST", {}, true),
    ).items;
    for (const task of tasks) {
      const taskId = resourceId(task, ["taskId", "id"]);
      if (!taskId || seen.has(`todo:${taskId}`)) continue;
      seen.add(`todo:${taskId}`);
      resources.push({
        sourceType: "dingtalk",
        resourceId: taskId,
        title: optionalString(task.subject) ?? optionalString(task.title),
        mimeType: "application/vnd.dingtalk.todo-task",
        schema: withResourceMetadata(task, "todo", taskId),
        version: optionalString(task.modifiedTime) ?? optionalString(task.updateTime),
        etag: optionalString(task.etag),
        owner: { id: unionId },
        aclSummary: { visibility: "private", subjectCount: 1 },
        url: safeSourceUrl(task),
      });
    }
  } catch (error) {
    if (!isOptionalDomainDenied(error)) throw error;
  }
  let cursor: string | undefined;
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
  useDingTalkTokenHeader = false,
): Promise<unknown> {
  const response = await context.fetcher(`https://api.dingtalk.com${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(useDingTalkTokenHeader
        ? { "x-acs-dingtalk-access-token": context.accessToken }
        : { authorization: `${context.tokenType ?? "Bearer"} ${context.accessToken}` }),
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

async function currentUnionId(
  context: Pick<OAuthProviderContext, "accessToken" | "tokenType" | "fetcher" | "signal">,
): Promise<string> {
  const identity = optionalRecord(await request(context, "/v1.0/contact/users/me"));
  const id = optionalString(identity?.unionId) ?? optionalString(identity?.userId) ?? optionalString(identity?.userid);
  if (!id) throw new ProviderRequestError(502, "DingTalk identity response did not include a user ID");
  return id;
}

function calendarPage(payload: unknown): {
  items: Array<Record<string, unknown>>;
  nextCursor: string | null;
  hasMore: boolean;
} {
  const record = optionalRecord(payload);
  const response = optionalRecord(record?.response) ?? record;
  const rawItems = Array.isArray(response?.calendars)
    ? response.calendars
    : Array.isArray(response?.items)
      ? response.items
      : [];
  return normalizedPage(
    rawItems.map((item) => enrichVisibleResource(item, "calendar")),
    response,
  );
}

function eventPage(
  payload: unknown,
  calendarId: string,
): {
  items: Array<Record<string, unknown>>;
  nextCursor: string | null;
  hasMore: boolean;
} {
  const record = optionalRecord(payload);
  const rawItems = Array.isArray(record?.events) ? record.events : Array.isArray(record?.items) ? record.items : [];
  return normalizedPage(
    rawItems.map((item) => enrichVisibleResource(item, "calendar-event", calendarId)),
    record,
  );
}

function todoPage(payload: unknown): {
  items: Array<Record<string, unknown>>;
  nextCursor: string | null;
  hasMore: boolean;
} {
  const record = optionalRecord(payload);
  const rawItems = Array.isArray(record?.todoCards)
    ? record.todoCards
    : Array.isArray(record?.items)
      ? record.items
      : [];
  return normalizedPage(
    rawItems.map((item) => enrichVisibleResource(item, "todo")),
    record,
  );
}

function normalizedPage(
  items: unknown[],
  envelope: Record<string, unknown> | undefined,
): { items: Array<Record<string, unknown>>; nextCursor: string | null; hasMore: boolean } {
  const nextCursor =
    optionalString(envelope?.nextToken) ??
    optionalString(envelope?.nextCursor) ??
    optionalString(envelope?.next_cursor);
  return {
    items: boundedProviderItems(items, maxPageSize),
    nextCursor: nextCursor ?? null,
    hasMore: envelope?.hasMore === true || envelope?.has_more === true || nextCursor !== undefined,
  };
}

function requiredTimestamp(value: unknown, field: string): number {
  const text = required(value, field);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new ProviderRequestError(400, `${field} must be an ISO 8601 timestamp`);
  return timestamp;
}

function requireWindow(from: number, to: number, maximum: number, kind: string): void {
  if (to <= from) throw new ProviderRequestError(400, `${kind} window end must be after its start`);
  if (to - from > maximum) throw new ProviderRequestError(400, `${kind} window exceeds the allowed maximum`);
}

function resourceId(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = optionalString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function withResourceMetadata(
  record: Record<string, unknown>,
  kind: "calendar" | "todo",
  id: string,
): Record<string, unknown> {
  return boundedProviderResourceSchema({
    ...record,
    ...(safeSourceUrl(record) ? { sourceUrl: safeSourceUrl(record) } : {}),
    identityType: "user_access_token",
    access: "authorizing-user-visible",
    resourceKind: kind,
    resourceId: id,
  });
}

function enrichVisibleResource(
  value: unknown,
  kind: "calendar" | "calendar-event" | "todo",
  parentId?: string,
): Record<string, unknown> {
  const record = optionalRecord(value) ?? {};
  return {
    ...record,
    ...(safeSourceUrl(record) ? { sourceUrl: safeSourceUrl(record) } : {}),
    identityType: "user_access_token",
    access: "authorizing-user-visible",
    resourceKind: kind,
    mimeType: `application/vnd.dingtalk.${kind}`,
    ...(parentId ? { parentResourceId: parentId } : {}),
  };
}

function isOptionalDomainDenied(error: unknown): boolean {
  return error instanceof ProviderRequestError && (error.status === 403 || error.status === 404);
}

function safeSourceUrl(record: Record<string, unknown>): string | undefined {
  const candidate = optionalString(record.htmlLink) ?? optionalString(record.detailUrl);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".dingtalk.com")) return undefined;
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
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
