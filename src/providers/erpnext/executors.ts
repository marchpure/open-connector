import type {
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
  ProxyExecutionResult,
} from "../../core/types.ts";
import type { ProviderResourceCandidate } from "../provider-loader.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";

import { compactObject, optionalRecord, optionalString } from "../../core/cast.ts";
import {
  discoverErpCapabilities,
  erpActionOutput,
  projectErpFields,
  readErpInput,
  requireErpCompanyField,
  resolveErpCompanyId,
} from "../../core/erp/runtime.ts";
import { erpMaxPages, erpMaxResponseBytes, erpRequestTimeoutMs } from "../../core/erp/runtime.ts";
import { normalizeErpBaseUrl } from "../../core/erp/runtime.ts";
import { withErpConcurrency } from "../../core/erp/runtime.ts";
import { readBoundedResponseBytes } from "../../core/request.ts";
import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import {
  createProviderFetch,
  createProviderTimeout,
  createProviderProxyUrl,
  defineProviderExecutors,
  normalizeProviderProxyHeaders,
  ProviderRequestError,
  providerUserAgent,
  readProviderProxyErrorMessage,
  readProviderProxyResponse,
  requireApiKeyCredential,
  toProviderProxyError,
} from "../provider-runtime.ts";
import { erpnextEntities } from "./erp.ts";

const service = "erpnext";
const proxyFetch = createProviderFetch({ allowPrivateNetwork: isPrivateNetworkAccessAllowed });
const erpnextLoggedUserMethod = "frappe.auth.get_logged_user";
const erpnextGetCountMethod = "frappe.client.get_count";
const erpnextGetValueMethod = "frappe.client.get_value";
const erpnextSetValueMethod = "frappe.client.set_value";

type ErpnextRequestPhase = "validate" | "execute";

interface ErpnextActionContext {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  companyId?: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

interface ErpnextRequestOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  fetcher: typeof fetch;
  phase: ErpnextRequestPhase;
  signal?: AbortSignal;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

type ErpnextActionHandler = (input: Record<string, unknown>, context: ErpnextActionContext) => Promise<unknown>;

const erpnextActionHandlers: ProviderActionHandlers<"erpnext", ErpnextActionHandler> = {
  async validate_connection(_input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildMethodPath(erpnextLoggedUserMethod),
      method: "GET",
      phase: "execute",
    });
    return {
      accountId: readRequiredMessageString(payload, "ERPNext validation response"),
      apiVersion: "Frappe REST API v1",
    };
  },
  async discover_capabilities(_input, context) {
    await requestErpnext({
      ...context,
      path: buildMethodPath(erpnextLoggedUserMethod),
      method: "GET",
      phase: "execute",
    });
    const capabilities = [];
    for (const entity of erpnextEntities) {
      try {
        const companyField = requireErpCompanyField(entity, context.companyId);
        await requestErpnext({
          ...context,
          path: buildResourcePath(entity.entity),
          method: "GET",
          query: {
            fields: JSON.stringify(entity.fields),
            filters: companyField ? JSON.stringify([[companyField, "=", context.companyId]]) : undefined,
            limit_page_length: "1",
          },
          phase: "execute",
        });
        capabilities.push(...discoverErpCapabilities([entity]));
      } catch (error) {
        if (error instanceof ProviderRequestError && [400, 403, 404, 422].includes(error.status)) continue;
        throw error;
      }
    }
    if (capabilities.length === 0) {
      throw new ProviderRequestError(422, "No supported ERP entities are visible to this connection", {
        code: "unsupported",
        supportedDomains: [],
      });
    }
    return { capabilities };
  },
  async list_entities(rawInput, context) {
    const { input, entity } = readErpInput(rawInput, erpnextEntities);
    const companyId = resolveErpCompanyId(input.companyId, context.companyId);
    const companyField = requireErpCompanyField(entity, companyId);
    const start = readOffsetCursor(input.cursor);
    const filters: unknown[] = [];
    if (input.modifiedFrom) filters.push(["modified", ">=", input.modifiedFrom]);
    if (input.modifiedTo) filters.push(["modified", "<", input.modifiedTo]);
    if (companyId && companyField) filters.push([companyField, "=", companyId]);
    const payload = await requestErpnext({
      ...context,
      path: buildResourcePath(entity.entity),
      method: "GET",
      query: compactObject({
        fields: JSON.stringify(input.fields ?? entity.fields),
        filters: filters.length ? JSON.stringify(filters) : undefined,
        order_by: "modified asc",
        limit_start: String(start),
        limit_page_length: String(input.pageSize),
      }),
      phase: "execute",
    });
    const items = readRequiredDataArray(payload, "ERPNext list_entities response").map((item) =>
      projectErpFields(item, input.fields),
    );
    return erpActionOutput(
      entity,
      {
        items,
        nextCursor: items.length === input.pageSize ? String(start + items.length) : undefined,
        native: { limitStart: start, count: items.length, orderBy: "modified asc" },
      },
      input.pageNumber,
    );
  },
  async get_logged_user(_input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildMethodPath(erpnextLoggedUserMethod),
      method: "GET",
      phase: "execute",
    });

    return {
      user: readRequiredMessageString(payload, "ERPNext get_logged_user response"),
    };
  },
  async list_documents(input, context) {
    const pageLength = readBoundedPageLength(input.page_length);
    const payload = await requestErpnext({
      ...context,
      path: buildResourcePath(readRequiredString(input.doctype, "doctype")),
      method: "GET",
      query: compactObject({
        fields: encodeOptionalJson(input.fields),
        filters: encodeOptionalJson(input.filters),
        order_by: optionalString(input.order_by),
        limit_start: readBoundedOffset(input.start, Number(pageLength)),
        limit_page_length: pageLength,
      }),
      phase: "execute",
    });

    return {
      documents: readRequiredDataArray(payload, "ERPNext list_documents response"),
    };
  },
  async get_document(input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildDocumentPath(readRequiredString(input.doctype, "doctype"), readRequiredString(input.name, "name")),
      method: "GET",
      phase: "execute",
    });

    return {
      document: readRequiredDataObject(payload, "ERPNext get_document response"),
    };
  },
  async create_document(input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildResourcePath(readRequiredString(input.doctype, "doctype")),
      method: "POST",
      body: readRequiredInputObject(input.data, "data"),
      phase: "execute",
    });

    return {
      document: readRequiredDataObject(payload, "ERPNext create_document response"),
    };
  },
  async update_document(input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildDocumentPath(readRequiredString(input.doctype, "doctype"), readRequiredString(input.name, "name")),
      method: "PUT",
      body: readRequiredInputObject(input.fields, "fields"),
      phase: "execute",
    });

    return {
      document: readRequiredDataObject(payload, "ERPNext update_document response"),
    };
  },
  async delete_document(input, context) {
    await requestErpnext({
      ...context,
      path: buildDocumentPath(readRequiredString(input.doctype, "doctype"), readRequiredString(input.name, "name")),
      method: "DELETE",
      phase: "execute",
    });

    return {
      ok: true,
    };
  },
  async get_document_count(input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildMethodPath(erpnextGetCountMethod),
      method: "GET",
      query: compactObject({
        doctype: readRequiredString(input.doctype, "doctype"),
        filters: encodeOptionalJson(input.filters),
      }),
      phase: "execute",
    });

    return {
      count: readRequiredMessageInteger(payload, "ERPNext get_document_count response"),
    };
  },
  async get_document_value(input, context) {
    assertExactlyOneNameOrFilters(input);
    const payload = await requestErpnext({
      ...context,
      path: buildMethodPath(erpnextGetValueMethod),
      method: "GET",
      query: compactObject({
        doctype: readRequiredString(input.doctype, "doctype"),
        name: optionalString(input.name),
        filters: encodeOptionalJson(input.filters),
        fieldname: encodeFieldNames(input.fieldname),
      }),
      phase: "execute",
    });

    return {
      value: readRequiredMessageValue(payload, "ERPNext get_document_value response"),
    };
  },
  async set_document_value(input, context) {
    const payload = await requestErpnext({
      ...context,
      path: buildMethodPath(erpnextSetValueMethod),
      method: "POST",
      body: {
        doctype: readRequiredString(input.doctype, "doctype"),
        name: readRequiredString(input.name, "name"),
        fieldname: readRequiredString(input.fieldname, "fieldname"),
        value: input.value,
      },
      phase: "execute",
    });

    return {
      document: readRequiredDocumentFromMethodResult(payload, "ERPNext set_document_value response"),
    };
  },
};

export const executors: ProviderExecutors = defineProviderExecutors<ErpnextActionContext>({
  service,
  handlers: erpnextActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<ErpnextActionContext> {
    const credential = await requireApiKeyCredential(context, service);
    const privateRunner = credential.values.privateRunner === "true";
    return {
      apiKey: credential.apiKey,
      apiSecret: readRequiredString(credential.values.apiSecret, "apiSecret"),
      baseUrl: normalizeBaseUrl(
        optionalString(credential.values.baseUrl) ?? optionalString(credential.metadata.baseUrl),
        privateRunner,
      ),
      companyId: optionalString(credential.values.companyId),
      fetcher: createProviderFetch({
        fetch: fetcher,
        allowPrivateNetwork: () => privateRunner && isPrivateNetworkAccessAllowed(),
      }),
      signal: context.signal,
    };
  },
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
});

export const proxy: ProviderProxyExecutor = async (input, context): Promise<ProxyExecutionResult> => {
  try {
    if (input.method !== "GET") {
      throw new ProviderRequestError(403, "ERPNext proxy is read-only");
    }
    if (!isAllowedErpnextReadEndpoint(input.endpoint)) {
      throw new ProviderRequestError(403, "ERPNext proxy endpoint is outside the read-only allowlist");
    }
    assertErpnextProxyQuery(input.query);
    const credential = await requireApiKeyCredential(context, service);
    if (optionalString(credential.values.companyId)) {
      throw new ProviderRequestError(403, "ERPNext proxy is disabled for company-scoped connections");
    }
    const privateRunner = credential.values.privateRunner === "true";
    const baseUrl = normalizeBaseUrl(
      optionalString(credential.values.baseUrl) ?? optionalString(credential.metadata.baseUrl),
      privateRunner,
    );
    const apiSecret = readRequiredString(credential.values.apiSecret, "apiSecret");
    const url = createProviderProxyUrl(baseUrl, input.endpoint, input.query);
    const headers = normalizeProviderProxyHeaders(input.headers);
    headers.set("authorization", `token ${credential.apiKey}:${apiSecret}`);
    headers.set("user-agent", providerUserAgent);
    if (input.body !== undefined && !headers.has("content-type") && typeof input.body !== "string") {
      headers.set("content-type", "application/json");
    }

    return await withErpConcurrency(async () => {
      const timeout = createProviderTimeout(context.signal, erpRequestTimeoutMs);
      try {
        const response = await createProviderFetch({
          fetch: proxyFetch,
          allowPrivateNetwork: () => privateRunner && isPrivateNetworkAccessAllowed(),
        })(url, {
          method: input.method,
          headers,
          body:
            input.body === undefined
              ? undefined
              : typeof input.body === "string"
                ? input.body
                : JSON.stringify(input.body),
          signal: timeout.signal,
          redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) {
          throw new ProviderRequestError(502, "ERPNext redirects are disabled");
        }
        if (!response.ok) {
          await readProviderProxyErrorMessage(response, "");
          throw new ProviderRequestError(response.status, `ERPNext proxy request failed with HTTP ${response.status}`);
        }
        return {
          ok: true,
          response: await readProviderProxyResponse(response, { maxBytes: erpMaxResponseBytes }),
        };
      } catch (error) {
        if (error instanceof ProviderRequestError) throw error;
        throw new ProviderRequestError(timeout.didTimeout() ? 504 : 502, "ERPNext proxy request failed");
      } finally {
        timeout.cleanup();
      }
    });
  } catch (error) {
    return toProviderProxyError(error, "provider request failed");
  }
};

export const credentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher, signal }) {
    const privateRunner = input.values.privateRunner === "true";
    const guardedFetcher = createProviderFetch({
      fetch: fetcher,
      allowPrivateNetwork: () => privateRunner && isPrivateNetworkAccessAllowed(),
    });
    const baseUrl = normalizeBaseUrl(input.values.baseUrl, privateRunner);
    const apiSecret = readRequiredString(input.values.apiSecret, "apiSecret");
    const payload = await requestErpnext({
      baseUrl,
      apiKey: input.apiKey,
      apiSecret,
      path: buildMethodPath(erpnextLoggedUserMethod),
      method: "GET",
      fetcher: guardedFetcher,
      signal,
      phase: "validate",
    });
    const user = readRequiredMessageString(payload, "ERPNext validation response");

    return {
      profile: {
        accountId: user,
        displayName: user,
      },
      grantedScopes: [],
      metadata: {
        baseUrl,
        validationEndpoint: buildMethodPath(erpnextLoggedUserMethod),
        user,
      },
    };
  },
};

export async function discoverResources(
  context: ExecutionContext,
  fetcher: typeof fetch,
): Promise<ProviderResourceCandidate[]> {
  const credential = await requireApiKeyCredential(context, service);
  const actionContext: ErpnextActionContext = {
    apiKey: credential.apiKey,
    apiSecret: readRequiredString(credential.values.apiSecret, "apiSecret"),
    baseUrl: normalizeBaseUrl(
      optionalString(credential.values.baseUrl) ?? optionalString(credential.metadata.baseUrl),
      credential.values.privateRunner === "true",
    ),
    companyId: optionalString(credential.values.companyId),
    fetcher: createProviderFetch({
      fetch: fetcher,
      allowPrivateNetwork: () => credential.values.privateRunner === "true" && isPrivateNetworkAccessAllowed(),
    }),
    signal: context.signal,
  };
  const result = (await erpnextActionHandlers.discover_capabilities({}, actionContext)) as {
    capabilities: Array<{ domain: string; nativeEntity: string; fields: string[] }>;
  };
  return result.capabilities.map((capability) => ({
    sourceType: "erpnext",
    resourceId: capability.domain,
    title: `ERPNext: ${capability.domain}`,
    mimeType: `application/vnd.oomol.erp.${capability.domain}`,
    schema: { ...capability, readable: true, writable: false },
  }));
}

async function requestErpnext(input: ErpnextRequestOptions): Promise<unknown> {
  return withErpConcurrency(async () => {
    const url = buildUrl(input.baseUrl, input.path, input.query);
    const timeout = createProviderTimeout(input.signal, erpRequestTimeoutMs);
    try {
      const response = await input.fetcher(url, {
        method: input.method,
        headers: buildHeaders(input.apiKey, input.apiSecret, input.body !== undefined),
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: timeout.signal,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        throw new ProviderRequestError(502, "ERPNext redirects are disabled");
      }
      const payload = await readErpnextPayload(response, timeout.signal);
      if (!response.ok) throw createErpnextError(response.status, payload, input.phase);
      return payload;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError(timeout.didTimeout() ? 504 : 502, "ERPNext request failed");
    } finally {
      timeout.cleanup();
    }
  });
}

function normalizeBaseUrl(value: unknown, privateRunner = false): string {
  return normalizeErpBaseUrl(value, { privateRunner });
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(path.startsWith("/") ? path.slice(1) : path, `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function buildHeaders(apiKey: string, apiSecret: string, hasBody: boolean): Headers {
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `token ${apiKey}:${apiSecret}`,
    "User-Agent": providerUserAgent,
  });
  if (hasBody) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

function buildResourcePath(doctype: string): string {
  return `/api/resource/${encodeURIComponent(doctype)}`;
}

function buildDocumentPath(doctype: string, name: string): string {
  return `${buildResourcePath(doctype)}/${encodeURIComponent(name)}`;
}

function buildMethodPath(methodName: string): string {
  return `/api/method/${methodName}`;
}

function isAllowedErpnextReadEndpoint(endpoint: string): boolean {
  if (endpoint === buildMethodPath(erpnextLoggedUserMethod)) {
    return true;
  }
  return erpnextEntities.some((entity) => {
    const root = buildResourcePath(entity.entity);
    return endpoint === root || endpoint.startsWith(`${root}/`);
  });
}

function assertErpnextProxyQuery(query: Record<string, unknown> | undefined): void {
  const pageLength = query?.limit_page_length;
  const normalizedPageLength = pageLength === undefined ? 100 : Number(pageLength);
  if (pageLength !== undefined) {
    if (!Number.isInteger(normalizedPageLength) || normalizedPageLength < 1 || normalizedPageLength > 200) {
      throw new ProviderRequestError(400, "limit_page_length must be between 1 and 200");
    }
  }
  readBoundedOffset(query?.limit_start, normalizedPageLength);
  const fields = query?.fields;
  if (fields !== undefined) {
    let parsed: unknown;
    try {
      parsed = typeof fields === "string" ? JSON.parse(fields) : fields;
    } catch {
      throw new ProviderRequestError(400, "fields must be a JSON array");
    }
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50) {
      throw new ProviderRequestError(400, "fields must contain between 1 and 50 field names");
    }
  }
}

async function readErpnextPayload(response: Response, signal?: AbortSignal): Promise<unknown> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: erpMaxResponseBytes,
    fieldName: "ERPNext response",
    signal,
    createError: (message) => new ProviderRequestError(413, message),
  });
  const text = new TextDecoder().decode(bytes);
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      message: text,
    };
  }
}

function createErpnextError(status: number, payload: unknown, phase: ErpnextRequestPhase): ProviderRequestError {
  if (status === 429) {
    return new ProviderRequestError(429, "ERPNext rate limit exceeded");
  }
  if (status === 401 || status === 403) {
    return new ProviderRequestError(phase === "validate" ? 400 : status, "ERPNext authentication or role denied");
  }
  if (status === 400 || status === 404 || status === 409 || status === 417 || status === 422) {
    return new ProviderRequestError(status, "ERPNext rejected the request");
  }
  return new ProviderRequestError(status >= 500 ? 502 : status, "ERPNext upstream request failed");
}

function readRequiredDataArray(payload: unknown, context: string): Array<Record<string, unknown>> {
  const data = optionalRecord(payload)?.data;
  if (!Array.isArray(data)) {
    throw new ProviderRequestError(502, `${context} did not include a data array`);
  }
  return data.map((item) => {
    const record = optionalRecord(item);
    if (!record) {
      throw new ProviderRequestError(502, `${context} contained a non-object document`);
    }
    return record;
  });
}

function readRequiredDataObject(payload: unknown, context: string): Record<string, unknown> {
  const record = optionalRecord(optionalRecord(payload)?.data);
  if (!record) {
    throw new ProviderRequestError(502, `${context} did not include a data object`);
  }
  return record;
}

function readRequiredMessageString(payload: unknown, context: string): string {
  const message = optionalRecord(payload)?.message;
  if (typeof message !== "string" || !message.trim()) {
    throw new ProviderRequestError(502, `${context} did not include a message string`);
  }
  return message;
}

function readRequiredMessageInteger(payload: unknown, context: string): number {
  const message = optionalRecord(payload)?.message;
  if (!Number.isInteger(message)) {
    throw new ProviderRequestError(502, `${context} did not include an integer message`);
  }
  return message as number;
}

function readRequiredMessageValue(payload: unknown, context: string): unknown {
  const record = optionalRecord(payload);
  if (!record || !Object.hasOwn(record, "message")) {
    throw new ProviderRequestError(502, `${context} did not include a message value`);
  }
  return record.message;
}

function readRequiredDocumentFromMethodResult(payload: unknown, context: string): Record<string, unknown> {
  const record = optionalRecord(payload);
  if (!record) {
    throw new ProviderRequestError(502, `${context} did not include an object payload`);
  }

  const docs = record.docs;
  if (Array.isArray(docs) && docs.length > 0) {
    const firstDocument = optionalRecord(docs[0]);
    if (firstDocument) {
      return firstDocument;
    }
  }

  const messageDocument = optionalRecord(record.message);
  if (messageDocument) {
    return messageDocument;
  }

  throw new ProviderRequestError(502, `${context} did not include a document`);
}

function encodeOptionalJson(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return JSON.stringify(value);
}

function encodeFieldNames(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  throw new ProviderRequestError(400, "fieldname must be a string or string array");
}

function assertExactlyOneNameOrFilters(input: Record<string, unknown>): void {
  const hasName = optionalString(input.name) !== undefined;
  const hasFilters = input.filters !== undefined;
  if (hasName === hasFilters) {
    throw new ProviderRequestError(400, "Provide exactly one of name or filters");
  }
}

function readRequiredString(value: unknown, fieldName: string): string {
  const stringValue = optionalString(value);
  if (!stringValue) {
    throw new ProviderRequestError(400, `${fieldName} is required`);
  }
  return stringValue;
}

function readRequiredInputObject(value: unknown, fieldName: string): Record<string, unknown> {
  const record = optionalRecord(value);
  if (!record) {
    throw new ProviderRequestError(400, `${fieldName} must be an object`);
  }
  return record;
}

function readBoundedOffset(value: unknown, pageSize: number): string | undefined {
  if (value === undefined) return undefined;
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > pageSize * (erpMaxPages - 1)) {
    throw new ProviderRequestError(400, `offset must stay within ${erpMaxPages} pages`);
  }
  return String(offset);
}

function readBoundedPageLength(value: unknown): string {
  if (value === undefined) return "100";
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 200) {
    throw new ProviderRequestError(400, "page_length must be between 1 and 200");
  }
  return String(value);
}

function readOffsetCursor(value: string | undefined): number {
  if (!value) return 0;
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ProviderRequestError(400, "cursor must be a non-negative integer offset");
  }
  return offset;
}
