import type { ErpCapability, ErpDomain, ErpNativeEntity, ErpPage } from "./types.ts";

import { Buffer } from "node:buffer";
import { createProviderTimeout, ProviderRequestError } from "../../providers/provider-runtime.ts";
import { optionalString } from "../cast.ts";
import {
  assertPublicHttpUrl,
  isPrivateNetworkAccessAllowed,
  parsePrivateNetworkAccessFlag,
  readBoundedResponseBytes,
} from "../request.ts";
import { erpDomains } from "./types.ts";

export const erpRequestTimeoutMs: number = 30_000;
export const erpMaxResponseBytes: number = 4 * 1024 * 1024;
export const erpMaxPageSize: number = 200;
export const erpMaxPages: number = 100;
export const erpMaxConcurrency: number = 8;
let activeErpRequests = 0;

export interface ErpReadInput {
  domain: ErpDomain;
  fields: string[];
  pageSize: number;
  cursor?: string;
  pageNumber: number;
  modifiedFrom?: string;
  modifiedTo?: string;
  companyId?: string;
}

export function discoverErpCapabilities(entities: readonly ErpNativeEntity[]): ErpCapability[] {
  return entities.map((entry) => ({
    domain: entry.domain,
    nativeEntity: entry.entity,
    fields: [...entry.fields],
    readable: true,
    writable: false,
  }));
}

export function readErpInput(
  input: Record<string, unknown>,
  entities: readonly ErpNativeEntity[],
): {
  input: ErpReadInput;
  entity: ErpNativeEntity;
} {
  const domain = optionalString(input.domain);
  if (!domain || !erpDomains.includes(domain as ErpDomain)) {
    throw new ProviderRequestError(400, "domain must be a supported ERP business domain", {
      code: "unsupported",
      supportedDomains: [...new Set(entities.map((entry) => entry.domain))],
    });
  }
  const entity = entities.find((entry) => entry.domain === domain);
  if (!entity) {
    throw new ProviderRequestError(422, `The connection does not support ERP domain ${domain}.`, {
      code: "unsupported",
      domain,
      supportedDomains: [...new Set(entities.map((entry) => entry.domain))],
    });
  }
  const pageSize = input.pageSize === undefined ? 100 : Number(input.pageSize);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > erpMaxPageSize) {
    throw new ProviderRequestError(400, `pageSize must be between 1 and ${erpMaxPageSize}`);
  }
  const fields = readFields(input.fields, entity) ?? [...entity.fields];
  const modifiedFrom = readDate(input.modifiedFrom, "modifiedFrom");
  const modifiedTo = readDate(input.modifiedTo, "modifiedTo");
  if ((modifiedFrom === undefined) !== (modifiedTo === undefined)) {
    throw new ProviderRequestError(400, "modifiedFrom and modifiedTo must be provided together");
  }
  if (modifiedFrom && modifiedTo && modifiedFrom >= modifiedTo) {
    throw new ProviderRequestError(400, "modifiedFrom must precede modifiedTo");
  }
  if (modifiedFrom && modifiedTo && Date.parse(modifiedTo) - Date.parse(modifiedFrom) > 366 * 86_400_000) {
    throw new ProviderRequestError(400, "The requested date range must not exceed 366 days");
  }
  return {
    entity,
    input: {
      domain: domain as ErpDomain,
      fields,
      pageSize,
      ...readCursor(input.cursor),
      modifiedFrom,
      modifiedTo,
      companyId: optionalString(input.companyId),
    },
  };
}

/**
 * Bind a caller-supplied company selector to the connection's configured
 * legal-entity boundary.
 */
export function resolveErpCompanyId(requested: string | undefined, configured: unknown): string | undefined {
  const allowed = optionalString(configured);
  if (requested && !allowed) {
    throw new ProviderRequestError(403, "companyId is not allowlisted by this ERP connection");
  }
  if (requested && requested !== allowed) {
    throw new ProviderRequestError(403, "companyId is outside this ERP connection's boundary");
  }
  return allowed;
}

export function requireErpCompanyField(entity: ErpNativeEntity, companyId: string | undefined): string | undefined {
  if (!companyId) return undefined;
  if (!entity.companyField) {
    throw new ProviderRequestError(422, `Company-scoped reads are unsupported for ERP domain ${entity.domain}`, {
      code: "unsupported",
      domain: entity.domain,
      feature: "companyId",
    });
  }
  return entity.companyField;
}

export function normalizeErpBaseUrl(
  value: unknown,
  options: { privateRunner?: boolean; fieldName?: string } = {},
): string {
  const raw = optionalString(value);
  if (!raw) throw new ProviderRequestError(400, `${options.fieldName ?? "baseUrl"} is required`);
  const privateRunner = options.privateRunner === true;
  if (privateRunner && !parsePrivateNetworkAccessFlag(process.env.CONNECTION_ERP_PRIVATE_RUNNER)) {
    throw new ProviderRequestError(400, "Private ERP access requires CONNECTION_ERP_PRIVATE_RUNNER=true");
  }
  if (privateRunner && !isPrivateNetworkAccessAllowed()) {
    throw new ProviderRequestError(400, "Private ERP access requires OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK=true");
  }
  const url = assertPublicHttpUrl(raw, {
    fieldName: options.fieldName ?? "baseUrl",
    allowPrivateNetwork: privateRunner && isPrivateNetworkAccessAllowed(),
    createError: (message) => new ProviderRequestError(400, message),
  });
  if (url.protocol !== "https:" && !privateRunner) {
    throw new ProviderRequestError(400, "Public ERP endpoints must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderRequestError(400, "ERP base URL must not contain credentials, query, or fragment");
  }
  assertErpHostAllowlisted(url.hostname, privateRunner);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

export function assertErpHostAllowlisted(hostname: string, privateRunner: boolean): void {
  if (!privateRunner) return;
  const allowlist = (process.env.CONNECTION_ERP_EGRESS_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  if (allowlist.length === 0) {
    throw new ProviderRequestError(400, "Private ERP access requires CONNECTION_ERP_EGRESS_ALLOWLIST");
  }
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!allowlist.some((entry) => host === entry || (entry.startsWith(".") && host.endsWith(entry)))) {
    throw new ProviderRequestError(400, "ERP host is not in CONNECTION_ERP_EGRESS_ALLOWLIST");
  }
}

export async function readErpJson(response: Response, provider: string, signal?: AbortSignal): Promise<unknown> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: erpMaxResponseBytes,
    fieldName: `${provider} response`,
    signal,
    createError: (message) => new ProviderRequestError(413, message),
  });
  const text = new TextDecoder().decode(bytes);
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderRequestError(502, `${provider} returned invalid JSON`);
  }
  if (!response.ok) {
    throw mapErpHttpError(response.status, provider);
  }
  return payload;
}

export function mapErpHttpError(status: number, provider: string): ProviderRequestError {
  if (status === 401) return new ProviderRequestError(401, `${provider} authentication failed`);
  if (status === 403) return new ProviderRequestError(403, `${provider} role or scope is insufficient`);
  if (status === 404) return new ProviderRequestError(404, `${provider} API resource or version was not found`);
  if (status === 429) return new ProviderRequestError(429, `${provider} rate limit exceeded`);
  if (status >= 500) return new ProviderRequestError(502, `${provider} upstream request failed`);
  return new ProviderRequestError(status, `${provider} rejected the request`);
}

export async function boundedErpFetch(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit,
  provider: string,
  parentSignal?: AbortSignal,
): Promise<unknown> {
  return withErpConcurrency(async () => {
    const timeout = createProviderTimeout(parentSignal, erpRequestTimeoutMs);
    try {
      const response = await fetcher(url, { ...init, signal: timeout.signal, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        throw new ProviderRequestError(502, `${provider} redirects are disabled`);
      }
      return await readErpJson(response, provider, timeout.signal);
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError(timeout.didTimeout() ? 504 : 502, `${provider} request failed`);
    } finally {
      timeout.cleanup();
    }
  });
}

export async function withErpConcurrency<T>(operation: () => Promise<T>): Promise<T> {
  if (activeErpRequests >= erpMaxConcurrency) {
    throw new ProviderRequestError(429, "ERP connector concurrency limit exceeded");
  }
  activeErpRequests += 1;
  try {
    return await operation();
  } finally {
    activeErpRequests -= 1;
  }
}

export function erpActionOutput(entity: ErpNativeEntity, page: ErpPage, pageNumber: number): Record<string, unknown> {
  if (page.items.length > erpMaxPageSize) {
    throw new ProviderRequestError(502, "ERP provider exceeded the maximum page size");
  }
  return {
    domain: entity.domain,
    nativeEntity: entity.entity,
    items: page.items,
    nextCursor: page.nextCursor && pageNumber < erpMaxPages ? encodeCursor(page.nextCursor, pageNumber + 1) : null,
    native: {
      ...page.native,
      pageNumber,
      ...(page.nextCursor && pageNumber >= erpMaxPages ? { pageBudgetExhausted: true } : {}),
    },
  };
}

export function projectErpFields(item: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(item, field)).map((field) => [field, item[field]]));
}

function readCursor(value: unknown): Pick<ErpReadInput, "cursor" | "pageNumber"> {
  const encoded = optionalString(value);
  if (!encoded) return { pageNumber: 1 };
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("invalid cursor");
    const record = parsed as Record<string, unknown>;
    if (
      record.v !== 1 ||
      !Number.isSafeInteger(record.page) ||
      Number(record.page) < 2 ||
      Number(record.page) > erpMaxPages ||
      typeof record.native !== "string" ||
      !record.native
    ) {
      throw new Error("invalid cursor");
    }
    return { cursor: record.native, pageNumber: Number(record.page) };
  } catch {
    throw new ProviderRequestError(400, `cursor must be an ERP continuation cursor with at most ${erpMaxPages} pages`);
  }
}

function encodeCursor(native: string, pageNumber: number): string {
  return Buffer.from(JSON.stringify({ v: 1, page: pageNumber, native }), "utf8").toString("base64url");
}

export function assertReadOnlySuiteql(query: string): string {
  const normalized = query.trim().replace(/;\s*$/u, "");
  if (
    !/^(?:select|with)\b/iu.test(normalized) ||
    /;\s*\S/u.test(normalized) ||
    /\b(?:insert|update|delete|merge|drop|alter|create|grant|revoke|call|execute|truncate)\b/iu.test(normalized)
  ) {
    throw new ProviderRequestError(400, "Only one read-only SuiteQL SELECT/CTE statement is allowed");
  }
  return normalized;
}

function readFields(value: unknown, entity: ErpNativeEntity): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 50 ||
    value.some((field) => typeof field !== "string")
  ) {
    throw new ProviderRequestError(400, "fields must contain between 1 and 50 field names");
  }
  const fields = [...new Set(value.map((field) => String(field).trim()))];
  const denied = fields.filter((field) => !entity.fields.includes(field));
  if (denied.length > 0) {
    throw new ProviderRequestError(400, `Unsupported field projection: ${denied.join(", ")}`, {
      code: "unsupported",
      supportedFields: entity.fields,
    });
  }
  return fields;
}

function readDate(value: unknown, field: string): string | undefined {
  const date = optionalString(value);
  if (!date) return undefined;
  if (!Number.isFinite(Date.parse(date))) throw new ProviderRequestError(400, `${field} must be an ISO timestamp`);
  return new Date(date).toISOString();
}
