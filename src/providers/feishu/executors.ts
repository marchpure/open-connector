import type { CredentialValidationResult, CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { OAuthProviderContext } from "../provider-runtime.ts";
import type { FeishuActionRuntimeContext } from "./shared/client.ts";

import { optionalNumber, optionalRecord, optionalString } from "../../core/cast.ts";
import {
  defineOAuthProviderExecutors,
  getProviderActionHandler,
  mapProviderActionHandlers,
  ProviderRequestError,
  boundedProviderResourceSchema,
} from "../provider-runtime.ts";
import { feishuActions } from "./actions.ts";
import { feishuActionHandlers, fetchFeishuUserInfo } from "./runtime.ts";
import { createFeishuApplicationActionHandlers } from "./shared/application-runtime.ts";
import { createFeishuApprovalActionHandlers } from "./shared/approval-runtime.ts";
import { createFeishuAttendanceActionHandlers } from "./shared/attendance-runtime.ts";
import { createFeishuBaseAdvancedActionHandlers } from "./shared/base-advanced-runtime.ts";
import { createFeishuBaseActionHandlers } from "./shared/base-runtime.ts";
import { createFeishuCalendarActionHandlers } from "./shared/calendar-runtime.ts";
import { createFeishuJsonRequest } from "./shared/client.ts";
import { createFeishuContactActionHandlers } from "./shared/contact-runtime.ts";
import { createFeishuDocsActionHandlers } from "./shared/docs-runtime.ts";
import { createFeishuDomainMediaActionHandlers } from "./shared/domain-media-runtime.ts";
import { createFeishuDriveAdvancedActionHandlers } from "./shared/drive-advanced-runtime.ts";
import { createFeishuDriveActionHandlers } from "./shared/drive-runtime.ts";
import { createFeishuFileActionHandlers } from "./shared/file-runtime.ts";
import { createFeishuImOrganizeActionHandlers } from "./shared/im-organize-runtime.ts";
import { createFeishuImActionHandlers } from "./shared/im-runtime.ts";
import { createFeishuImUserActionHandlers } from "./shared/im-user-runtime.ts";
import { createFeishuMailAdvancedActionHandlers } from "./shared/mail-advanced-runtime.ts";
import { createFeishuMailActionHandlers } from "./shared/mail-runtime.ts";
import { createFeishuMarkdownRuntimeContext } from "./shared/markdown-feishu-runtime.ts";
import { createFeishuMarkdownActionHandlers } from "./shared/markdown-runtime.ts";
import { createFeishuMinutesActionHandlers } from "./shared/minutes-runtime.ts";
import { createFeishuNoteActionHandlers } from "./shared/note-runtime.ts";
import { createFeishuOkrActionHandlers } from "./shared/okr-runtime.ts";
import { createFeishuSheetsAdvancedActionHandlers } from "./shared/sheets-advanced-runtime.ts";
import { createFeishuSheetsActionHandlers } from "./shared/sheets-runtime.ts";
import { createFeishuSlidesActionHandlers } from "./shared/slides-runtime.ts";
import { createFeishuTaskActionHandlers } from "./shared/task-runtime.ts";
import { createFeishuVcActionHandlers } from "./shared/vc-runtime.ts";
import { createFeishuWhiteboardActionHandlers } from "./shared/whiteboard-runtime.ts";
import { createFeishuWikiActionHandlers } from "./shared/wiki-runtime.ts";

const service = "feishu";

interface FeishuHandler {
  (input: Record<string, unknown>, context: OAuthProviderContext): Promise<unknown>;
}

const allFeishuActionHandlers = mapProviderActionHandlers(
  service,
  feishuActions,
  (action): FeishuHandler =>
    async (input, context) => {
      const nativeHandler = getProviderActionHandler(feishuActionHandlers, action.name);
      if (nativeHandler) {
        return nativeHandler(input, context);
      }
      const sharedHandlers = createFeishuSharedHandlers(context);
      const sharedHandler = sharedHandlers[action.name];
      if (!sharedHandler) {
        throw new ProviderRequestError(400, `unknown feishu action: ${action.name}`);
      }
      return sharedHandler(input);
    },
);

export const executors: ProviderExecutors = defineOAuthProviderExecutors(service, allFeishuActionHandlers);

export async function discoverResources(
  context: import("../../core/types.ts").ExecutionContext,
  fetcher: typeof fetch,
): Promise<
  Array<{
    sourceType: "feishu";
    resourceId: string;
    resourceToken?: string;
    version?: string;
    etag?: string;
    title?: string;
    mimeType?: string;
    schema?: Record<string, unknown>;
    owner?: { id: string; displayName?: string };
    aclSummary?: { visibility: "private" | "shared" | "team"; subjectCount?: number };
    url?: string;
  }>
> {
  const credential = await context.getCredential(service);
  if (credential?.authType !== "oauth2") throw new ProviderRequestError(401, "Configure feishu OAuth first.");
  const request = createFeishuJsonRequest({
    accessToken: credential.accessToken,
    fetcher,
    signal: context.signal,
    phase: "execute",
  });
  const resources: Array<{
    sourceType: "feishu";
    resourceId: string;
    resourceToken?: string;
    version?: string;
    etag?: string;
    title?: string;
    mimeType?: string;
    schema?: Record<string, unknown>;
    owner?: { id: string; displayName?: string };
    aclSummary?: { visibility: "private" | "shared" | "team"; subjectCount?: number };
    url?: string;
  }> = [];
  const seen = new Set<string>();
  const addResource = (
    resourceId: string,
    options: {
      resourceToken?: string;
      title?: string;
      mimeType?: string;
      record?: Record<string, unknown>;
    } = {},
  ) => {
    if (resources.length >= 500 || seen.has(resourceId)) return;
    seen.add(resourceId);
    const record = options.record;
    resources.push({
      sourceType: "feishu",
      resourceId,
      resourceToken: options.resourceToken,
      title: options.title,
      mimeType: options.mimeType,
      schema: record ? boundedProviderResourceSchema(record) : undefined,
      version: record ? (optionalString(record.version) ?? optionalString(record.revision_id)) : undefined,
      etag: record ? optionalString(record.etag) : undefined,
      owner:
        record && optionalString(record.owner_id)
          ? { id: optionalString(record.owner_id)!, displayName: optionalString(record.owner_name) }
          : undefined,
      aclSummary: record
        ? (() => {
            const visibility = optionalString(record.visibility);
            return visibility
              ? {
                  visibility: normalizeFeishuVisibility(visibility),
                  subjectCount: optionalNumber(record.subject_count),
                }
              : undefined;
          })()
        : undefined,
      url: record ? safeFeishuResourceUrl(record.url) : undefined,
    });
  };
  const add = (record: Record<string, unknown>, defaults: { mimeType?: string } = {}) => {
    const resourceId =
      optionalString(record.document_id) ??
      optionalString(record.obj_token) ??
      optionalString(record.node_token) ??
      optionalString(record.file_token) ??
      optionalString(record.chat_id) ??
      optionalString(record.minute_token) ??
      optionalString(record.app_token) ??
      optionalString(record.base_token) ??
      optionalString(record.spreadsheet_token) ??
      optionalString(record.token) ??
      optionalString(record.id) ??
      optionalString(record.space_id);
    if (!resourceId || seen.has(resourceId)) return;
    addResource(resourceId, {
      resourceToken:
        optionalString(record.obj_token) ??
        optionalString(record.node_token) ??
        optionalString(record.file_token) ??
        optionalString(record.chat_id) ??
        optionalString(record.minute_token) ??
        optionalString(record.token),
      title: optionalString(record.title) ?? optionalString(record.name) ?? optionalString(record.topic),
      mimeType: normalizeFeishuMimeType(
        optionalString(record.mime_type) ??
          optionalString(record.mimeType) ??
          optionalString(record.obj_type) ??
          defaults.mimeType ??
          optionalString(record.type),
      ),
      record,
    });
    addKnownResources(record, addResource);
  };

  // Search is Feishu's visibility-aware cross-product index. It returns
  // documents, Wiki nodes, Drive files, Sheets, Bases, and Slides according
  // to the authorized user's current visibility and granted scopes.
  await optionalDiscovery(async () => {
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const data = await request({
        method: "POST",
        path: "/search/v2/doc_wiki/search",
        body: {
          query: "",
          doc_filter: {},
          wiki_filter: {},
          page_size: 20,
          page_token: pageToken,
        },
      });
      for (const item of Array.isArray(data.res_units) ? data.res_units : []) {
        const record = optionalRecord(item);
        if (record) add(record);
      }
      if (data.has_more !== true) break;
      const next = optionalString(data.page_token);
      if (!next || next === pageToken) break;
      pageToken = next;
    }
  });

  // Drive listing covers files and folders which are not returned by the
  // cross-product search index. Only the caller's root is listed and the
  // continuation budget is intentionally small.
  await optionalDiscovery(async () => {
    let pageToken: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const data = await request({
        path: "/drive/v1/files",
        query: { page_size: 100, page_token: pageToken },
      });
      for (const item of Array.isArray(data.files) ? data.files : Array.isArray(data.items) ? data.items : []) {
        const record = optionalRecord(item);
        if (record) add(record, { mimeType: "application/vnd.feishu.drive-resource" });
      }
      if (data.has_more !== true) break;
      const next = optionalString(data.page_token) ?? optionalString(data.next_page_token);
      if (!next || next === pageToken) break;
      pageToken = next;
    }
  });

  // Wiki spaces and nodes have a dedicated visibility-aware API. The nested
  // traversal is bounded so a large knowledge base cannot become an agent
  // context dump.
  await optionalDiscovery(async () => {
    let spacePageToken: string | undefined;
    for (let page = 0; page < 2; page += 1) {
      const data = await request({
        path: "/wiki/v2/spaces",
        query: { page_size: 50, page_token: spacePageToken },
      });
      const spaces = Array.isArray(data.items) ? data.items : [];
      for (const item of spaces.slice(0, 20)) {
        const space = optionalRecord(item);
        if (!space) continue;
        add(space, { mimeType: "application/vnd.feishu.wiki-space" });
        const spaceId = optionalString(space.space_id) ?? optionalString(space.id);
        if (!spaceId) continue;
        await collectFeishuWikiNodes(request, spaceId, add);
      }
      if (data.has_more !== true) break;
      const next = optionalString(data.page_token);
      if (!next || next === spacePageToken) break;
      spacePageToken = next;
    }
  });

  // Chat listing is the official user-visible group discovery surface. The
  // message history itself is never fetched during discovery.
  await optionalDiscovery(async () => {
    let pageToken: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const data = await request({
        path: "/im/v1/chats",
        query: { page_size: 100, page_token: pageToken },
      });
      for (const item of Array.isArray(data.items) ? data.items : []) {
        const record = optionalRecord(item);
        if (record) add(record, { mimeType: "application/vnd.feishu.chat" });
      }
      if (data.has_more !== true) break;
      const next = optionalString(data.page_token);
      if (!next || next === pageToken) break;
      pageToken = next;
    }
  });

  // Minutes search requires a query or owner filter. Restrict it to the
  // authorized user's own records, which is an explicit upstream visibility
  // boundary rather than an unbounded guessed-token read.
  await optionalDiscovery(async () => {
    const user = await fetchFeishuUserInfo({
      accessToken: credential.accessToken,
      fetcher,
      signal: context.signal,
    });
    const openId = optionalString(user.open_id);
    if (!openId) return;
    let pageToken: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const data = await request({
        method: "POST",
        path: "/minutes/v1/minutes/search",
        query: { page_size: 50, page_token: pageToken },
        body: { filter: { owner_ids: [openId] } },
      });
      for (const item of Array.isArray(data.items) ? data.items : []) {
        const record = optionalRecord(item);
        if (record) add(record, { mimeType: "application/vnd.feishu.minutes" });
      }
      if (data.has_more !== true) break;
      const next = optionalString(data.page_token);
      if (!next || next === pageToken) break;
      pageToken = next;
    }
  });

  // Expand only visibility-approved Base apps into bounded child resources.
  await optionalDiscovery(async () => {
    const apps = resources
      .filter((resource) => resource.mimeType === "application/vnd.feishu.bitable")
      .map((resource) => resource.resourceToken ?? resource.resourceId)
      .slice(0, 10);
    for (const appToken of apps) {
      await collectFeishuBaseResources(request, appToken, addResource);
    }
  });
  return resources;
}

function addKnownResources(
  record: Record<string, unknown>,
  addResource: (
    resourceId: string,
    options?: { resourceToken?: string; title?: string; mimeType?: string; record?: Record<string, unknown> },
  ) => void,
): void {
  const add = (key: string, mimeType: string, resourceToken?: string) => {
    const resourceId = optionalString(record[key]);
    if (resourceId) {
      addResource(resourceId, {
        resourceToken: resourceToken ? optionalString(record[resourceToken]) : undefined,
        title: optionalString(record.title) ?? optionalString(record.name),
        mimeType,
        record,
      });
    }
  };
  add("app_token", "application/vnd.feishu.bitable");
  add("base_token", "application/vnd.feishu.bitable");
  add("spreadsheet_token", "application/vnd.feishu.sheet");
  add("table_id", "application/vnd.feishu.bitable.table", "app_token");
  add("field_id", "application/vnd.feishu.bitable.field", "table_id");
  add("view_id", "application/vnd.feishu.bitable.view", "table_id");
  add("record_id", "application/vnd.feishu.bitable.record", "table_id");
  add("sheet_id", "application/vnd.feishu.sheet", "spreadsheet_token");
}

async function collectFeishuBaseResources(
  request: ReturnType<typeof createFeishuJsonRequest>,
  appToken: string,
  addResource: (
    resourceId: string,
    options?: { resourceToken?: string; title?: string; mimeType?: string; record?: Record<string, unknown> },
  ) => void,
): Promise<void> {
  addResource(appToken, { mimeType: "application/vnd.feishu.bitable" });
  const data = await request({
    path: `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`,
    query: { page_size: 50 },
  });
  const tables = Array.isArray(data.items) ? data.items : Array.isArray(data.tables) ? data.tables : [];
  for (const itemValue of tables.slice(0, 50)) {
    const table = optionalRecord(itemValue);
    const tableId = table && (optionalString(table.table_id) ?? optionalString(table.id));
    if (!table || !tableId) continue;
    addResource(tableId, {
      resourceToken: appToken,
      title: optionalString(table.name) ?? optionalString(table.title),
      mimeType: "application/vnd.feishu.bitable.table",
      record: table,
    });
    const tablePath = `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}`;
    const [fields, views, records] = await Promise.all([
      request({ path: `${tablePath}/fields`, query: { page_size: 100 } }),
      request({ path: `${tablePath}/views`, query: { page_size: 100 } }),
      request({ path: `${tablePath}/records`, query: { page_size: 100 } }),
    ]);
    for (const [payload, key, mimeType, idKey] of [
      [fields, "items", "application/vnd.feishu.bitable.field", "field_id"],
      [views, "items", "application/vnd.feishu.bitable.view", "view_id"],
      [records, "items", "application/vnd.feishu.bitable.record", "record_id"],
    ] as const) {
      const items = Array.isArray(payload[key]) ? payload[key] : [];
      for (const value of items.slice(0, 100)) {
        const item = optionalRecord(value);
        const id = item && optionalString(item[idKey]);
        if (item && id) addResource(id, { resourceToken: tableId, mimeType, record: item });
      }
    }
  }
}

async function collectFeishuWikiNodes(
  request: ReturnType<typeof createFeishuJsonRequest>,
  spaceId: string,
  add: (record: Record<string, unknown>, defaults?: { mimeType?: string }) => void,
): Promise<void> {
  let pageToken: string | undefined;
  for (let page = 0; page < 2; page += 1) {
    const data = await request({
      path: `/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`,
      query: { page_size: 100, page_token: pageToken },
    });
    for (const item of Array.isArray(data.items) ? data.items : []) {
      const record = optionalRecord(item);
      if (record) add(record, { mimeType: "application/vnd.feishu.wiki-node" });
    }
    if (data.has_more !== true) break;
    const next = optionalString(data.page_token);
    if (!next || next === pageToken) break;
    pageToken = next;
  }
}

async function optionalDiscovery(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    // A user token may legitimately omit one product scope. Preserve the
    // visibility of the other products, while expired/invalid credentials
    // still fail the complete discovery operation.
    if (error instanceof ProviderRequestError && (error.status === 403 || error.status === 404)) return;
    throw error;
  }
}

function safeFeishuResourceUrl(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeFeishuVisibility(value: string): "private" | "shared" | "team" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "private") return "private";
  if (normalized === "team" || normalized === "organization" || normalized === "org") return "team";
  return "shared";
}

function normalizeFeishuMimeType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "base" || normalized === "bitable") return "application/vnd.feishu.bitable";
  if (normalized === "sheet" || normalized === "spreadsheet") return "application/vnd.feishu.sheet";
  if (normalized === "doc" || normalized === "docx") return "application/vnd.feishu.document";
  return value;
}

function createFeishuSharedHandlers(
  context: OAuthProviderContext,
): Record<string, (input: Record<string, unknown>) => Promise<unknown>> {
  const runtimeContext: FeishuActionRuntimeContext = {
    identity: "user",
    accessToken: context.accessToken,
    fetcher: context.fetcher,
    transitFiles: context.transitFiles,
    signal: context.signal,
  };
  const request = createFeishuJsonRequest(runtimeContext);
  return {
    ...createFeishuContactActionHandlers({ identity: "user", request }),
    ...createFeishuImActionHandlers({ identity: "user", request, context: runtimeContext }),
    ...createFeishuImUserActionHandlers(request),
    ...createFeishuImOrganizeActionHandlers(request),
    ...createFeishuBaseActionHandlers(request),
    ...createFeishuBaseAdvancedActionHandlers(request),
    ...createFeishuCalendarActionHandlers(request),
    ...createFeishuTaskActionHandlers(request),
    ...createFeishuWikiActionHandlers(request),
    ...createFeishuDocsActionHandlers(request),
    ...createFeishuDriveActionHandlers(request),
    ...createFeishuDriveAdvancedActionHandlers({
      request,
      accessToken: context.accessToken,
      fetcher: context.fetcher,
      transitFiles: context.transitFiles,
      signal: context.signal,
    }),
    ...createFeishuSlidesActionHandlers(request),
    ...createFeishuWhiteboardActionHandlers(request),
    ...createFeishuAttendanceActionHandlers(request),
    ...createFeishuSheetsActionHandlers(request),
    ...createFeishuSheetsAdvancedActionHandlers(request),
    ...createFeishuApprovalActionHandlers(request),
    ...createFeishuMailActionHandlers(request, context.fetcher),
    ...createFeishuMailAdvancedActionHandlers(request),
    ...createFeishuMinutesActionHandlers(request),
    ...createFeishuNoteActionHandlers({
      request,
      transitFiles: context.transitFiles,
      signal: context.signal,
    }),
    ...createFeishuOkrActionHandlers(request),
    ...createFeishuFileActionHandlers({
      request,
      accessToken: context.accessToken,
      fetcher: context.fetcher,
      transitFiles: context.transitFiles,
      signal: context.signal,
    }),
    ...createFeishuVcActionHandlers({ identity: "user", request }),
    ...createFeishuApplicationActionHandlers(request),
    ...createFeishuMarkdownActionHandlers(createFeishuMarkdownRuntimeContext({ request, context: runtimeContext })),
    ...createFeishuDomainMediaActionHandlers({
      request,
      accessToken: context.accessToken,
      fetcher: context.fetcher,
      transitFiles: context.transitFiles,
      signal: context.signal,
    }),
  };
}

export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher, signal }): Promise<CredentialValidationResult> {
    const data = await fetchFeishuUserInfo({ accessToken: input.accessToken, fetcher, signal });
    const openId = optionalString(data.open_id);
    if (!openId) {
      throw new ProviderRequestError(502, "feishu user_info response is missing open_id.");
    }

    return {
      profile: {
        accountId: openId,
        displayName: optionalString(data.name) ?? openId,
      },
      metadata: {
        ...input.metadata,
        openId,
        unionId: optionalString(data.union_id),
        tenantKey: optionalString(data.tenant_key),
      },
    };
  },
};
