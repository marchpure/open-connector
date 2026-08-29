import type { ProviderResourceCandidate } from "../../providers/provider-loader.ts";
import type { ProviderRuntimeHandler } from "../../providers/provider-runtime.ts";
import type { CredentialValidationResult, ExecutionContext, ProviderExecutors } from "../types.ts";
import type { ErpCapability, ErpNativeEntity, ErpPage } from "./types.ts";

import {
  createProviderFetch,
  defineProviderExecutors,
  ProviderRequestError,
} from "../../providers/provider-runtime.ts";
import { optionalRecord, optionalString } from "../cast.ts";
import { isPrivateNetworkAccessAllowed } from "../request.ts";
import {
  boundedErpFetch,
  discoverErpCapabilities,
  erpActionOutput,
  normalizeErpBaseUrl,
  projectErpFields,
  readErpInput,
  requireErpCompanyField,
  resolveErpCompanyId,
} from "./runtime.ts";

export type ErpAuthStyle = "bearer" | "basic" | "api-key-header" | "odoo-json2" | "kingdee" | "access-token-header";

export interface ErpRestVendor {
  service: string;
  displayName: string;
  apiVersion: string;
  entities: readonly ErpNativeEntity[];
  authStyle: ErpAuthStyle;
  privateRunner?: boolean;
  validationPath: string;
  validationMethod?: "GET" | "POST";
  validationBody?: (values: Record<string, string>) => Record<string, unknown>;
  buildReadRequest(input: {
    baseUrl: string;
    entity: ErpNativeEntity;
    pageSize: number;
    cursor?: string;
    fields?: string[];
    modifiedFrom?: string;
    modifiedTo?: string;
    companyId?: string;
    values: Record<string, string>;
  }): { url: URL; method?: "GET" | "POST"; body?: Record<string, unknown>; headers?: Record<string, string> };
  parsePage(payload: unknown, pageSize: number, cursor: string | undefined, fields: readonly string[]): ErpPage;
}

interface ErpVendorContext {
  values: Record<string, string>;
  baseUrl: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

export function defineErpVendorExecutors(vendor: ErpRestVendor): {
  executors: ProviderExecutors;
  credentialValidators: {
    customCredential: (
      input: { values: Record<string, string> },
      context: { fetcher: typeof fetch; signal?: AbortSignal },
    ) => Promise<CredentialValidationResult>;
  };
  discoverResources: (context: ExecutionContext, fetcher: typeof fetch) => Promise<ProviderResourceCandidate[]>;
} {
  const handlers: Record<string, ProviderRuntimeHandler<ErpVendorContext>> = {
    async validate_connection(_input, context) {
      await validate(vendor, context);
      return {
        accountId: accountId(context.values),
        apiVersion: vendor.apiVersion,
      };
    },
    async discover_capabilities(_input, context) {
      await validate(vendor, context);
      const capabilities = [];
      for (const entity of vendor.entities) {
        try {
          const request = vendor.buildReadRequest({
            baseUrl: context.baseUrl,
            entity,
            pageSize: 1,
            fields: [...entity.fields],
            companyId: optionalString(context.values.companyId),
            values: context.values,
          });
          await boundedErpFetch(
            context.fetcher,
            request.url,
            {
              method: request.method ?? "GET",
              headers: buildHeaders(vendor, context.values, request.headers, request.body !== undefined),
              body: request.body ? JSON.stringify(request.body) : undefined,
            },
            vendor.displayName,
            context.signal,
          );
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
      const { input, entity } = readErpInput(rawInput, vendor.entities);
      const request = vendor.buildReadRequest({
        ...input,
        companyId: resolveErpCompanyId(input.companyId, context.values.companyId),
        entity,
        baseUrl: context.baseUrl,
        values: context.values,
      });
      const payload = await boundedErpFetch(
        context.fetcher,
        request.url,
        {
          method: request.method ?? "GET",
          headers: buildHeaders(vendor, context.values, request.headers, request.body !== undefined),
          body: request.body ? JSON.stringify(request.body) : undefined,
        },
        vendor.displayName,
        context.signal,
      );
      const page = vendor.parsePage(payload, input.pageSize, input.cursor, input.fields);
      page.items = page.items.map((item) => projectErpFields(item, input.fields));
      return erpActionOutput(entity, page, input.pageNumber);
    },
  };

  return {
    executors: defineProviderExecutors<ErpVendorContext>({
      service: vendor.service,
      handlers,
      allowPrivateNetwork: vendor.privateRunner ? isPrivateNetworkAccessAllowed : undefined,
      async createContext(context: ExecutionContext, fetcher): Promise<ErpVendorContext> {
        const credential = await context.getCredential(vendor.service);
        if (credential?.authType !== "custom_credential") {
          throw new ProviderRequestError(401, `Configure ${vendor.service} custom credentials first.`);
        }
        const privateRunner = vendor.privateRunner && credential.values.privateRunner === "true";
        return {
          values: credential.values,
          baseUrl: normalizeErpBaseUrl(credential.values.baseUrl ?? credential.metadata.baseUrl, {
            privateRunner,
          }),
          fetcher: createProviderFetch({
            fetch: fetcher,
            allowPrivateNetwork: () => privateRunner === true && isPrivateNetworkAccessAllowed(),
          }),
          signal: context.signal,
        };
      },
    }),
    credentialValidators: {
      async customCredential(input, context): Promise<CredentialValidationResult> {
        const privateRunner = vendor.privateRunner && input.values.privateRunner === "true";
        const baseUrl = normalizeErpBaseUrl(input.values.baseUrl, {
          privateRunner,
        });
        await validate(vendor, {
          values: input.values,
          baseUrl,
          signal: context.signal,
          fetcher: createProviderFetch({
            fetch: context.fetcher,
            allowPrivateNetwork: () => privateRunner === true && isPrivateNetworkAccessAllowed(),
          }),
        });
        return {
          profile: {
            accountId: accountId(input.values),
            displayName: `${vendor.displayName} ${accountId(input.values)}`,
          },
          grantedScopes: ["read"],
          metadata: {
            baseUrl,
            apiVersion: vendor.apiVersion,
            privateRunner: vendor.privateRunner && input.values.privateRunner === "true",
          },
        };
      },
    },
    async discoverResources(context, fetcher): Promise<ProviderResourceCandidate[]> {
      const credential = await context.getCredential(vendor.service);
      if (credential?.authType !== "custom_credential") {
        throw new ProviderRequestError(401, `Configure ${vendor.service} custom credentials first.`);
      }
      const actionContext: ErpVendorContext = {
        values: credential.values,
        baseUrl: normalizeErpBaseUrl(credential.values.baseUrl ?? credential.metadata.baseUrl, {
          privateRunner: vendor.privateRunner && credential.values.privateRunner === "true",
        }),
        fetcher: createProviderFetch({
          fetch: fetcher,
          allowPrivateNetwork: () =>
            vendor.privateRunner === true &&
            credential.values.privateRunner === "true" &&
            isPrivateNetworkAccessAllowed(),
        }),
        signal: context.signal,
      };
      const result = (await handlers.discover_capabilities!({}, actionContext)) as {
        capabilities: ErpCapability[];
      };
      return result.capabilities.map((capability) => ({
        sourceType: vendor.service as ProviderResourceCandidate["sourceType"],
        resourceId: capability.domain,
        title: `${vendor.displayName}: ${capability.domain}`,
        mimeType: `application/vnd.oomol.erp.${capability.domain}`,
        schema: {
          domain: capability.domain,
          nativeEntity: capability.nativeEntity,
          fields: capability.fields,
          readable: true,
          writable: false,
        },
      }));
    },
  };
}

async function validate(vendor: ErpRestVendor, context: ErpVendorContext): Promise<void> {
  const url = new URL(vendor.validationPath.replace(/^\//u, ""), `${context.baseUrl}/`);
  await boundedErpFetch(
    context.fetcher,
    url,
    {
      method: vendor.validationMethod ?? "GET",
      headers: buildHeaders(vendor, context.values, {}, vendor.validationMethod === "POST"),
      body: vendor.validationBody ? JSON.stringify(vendor.validationBody(context.values)) : undefined,
    },
    vendor.displayName,
    context.signal,
  );
}

function buildHeaders(
  vendor: ErpRestVendor,
  values: Record<string, string>,
  extra: Record<string, string> = {},
  hasBody = false,
): Headers {
  const headers = new Headers({ accept: "application/json", ...extra });
  if (hasBody) headers.set("content-type", "application/json");
  if (vendor.authStyle === "bearer" || vendor.authStyle === "odoo-json2") {
    headers.set("authorization", `Bearer ${required(values.accessToken, "accessToken")}`);
  } else if (vendor.authStyle === "basic") {
    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${required(values.username, "username")}:${required(values.password, "password")}`).toString("base64")}`,
    );
  } else if (vendor.authStyle === "api-key-header") {
    headers.set(required(values.apiKeyHeader, "apiKeyHeader"), required(values.apiKey, "apiKey"));
  } else if (vendor.authStyle === "access-token-header") {
    headers.set("access_token", required(values.accessToken, "accessToken"));
  } else {
    headers.set("x-kdapi-acctid", required(values.accountId, "accountId"));
    headers.set("x-kdapi-appid", required(values.appId, "appId"));
    headers.set("x-kdapi-appsec", required(values.appSecret, "appSecret"));
    headers.set("x-kdapi-username", required(values.username, "username"));
    headers.set("x-kdapi-lcid", optionalString(values.localeId) ?? "2052");
  }
  if (vendor.authStyle === "odoo-json2") {
    headers.set("x-odoo-database", required(values.database, "database"));
  }
  return headers;
}

function accountId(values: Record<string, string>): string {
  return (
    optionalString(values.accountId) ?? optionalString(values.tenantId) ?? optionalString(values.database) ?? "default"
  );
}

function required(value: unknown, field: string): string {
  const result = optionalString(value);
  if (!result) throw new ProviderRequestError(400, `${field} is required`);
  return result;
}

export function parseODataPage(payload: unknown): ErpPage {
  const record = optionalRecord(payload);
  const v2 = optionalRecord(record?.d);
  const source = Array.isArray(record?.value) ? record.value : Array.isArray(v2?.results) ? v2.results : [];
  const items = records(source);
  return {
    items,
    nextCursor: optionalString(record?.["@odata.nextLink"]) ?? optionalString(v2?.__next),
    native: {
      count: items.length,
      context: optionalString(record?.["@odata.context"]),
    },
  };
}

export function parseOraclePage(payload: unknown): ErpPage {
  const record = optionalRecord(payload);
  const items = Array.isArray(record?.items) ? records(record.items) : [];
  const offset = typeof record?.offset === "number" ? record.offset : 0;
  return {
    items,
    nextCursor: record?.hasMore === true ? String(offset + items.length) : undefined,
    native: { count: items.length, hasMore: record?.hasMore === true, offset },
  };
}

export function parseOdooPage(payload: unknown, pageSize: number): ErpPage {
  const items = Array.isArray(payload) ? records(payload) : [];
  return {
    items,
    nextCursor: items.length === pageSize ? String(pageSize) : undefined,
    native: { count: items.length, protocol: "JSON-2" },
  };
}

export function odataReadRequest(input: Parameters<ErpRestVendor["buildReadRequest"]>[0]): {
  url: URL;
  headers?: Record<string, string>;
} {
  const entityUrl = new URL(input.entity.entity.replace(/^\//u, ""), `${input.baseUrl}/`);
  const next = decodeCursorUrl(input.cursor, input.baseUrl);
  if (next && next.pathname !== entityUrl.pathname) {
    throw new ProviderRequestError(400, "cursor must target the selected ERP entity");
  }
  const url = entityUrl;
  for (const parameter of ["$skip", "$skiptoken"]) {
    const value = next?.searchParams.get(parameter);
    if (value !== null && value !== undefined) url.searchParams.set(parameter, value);
  }
  url.searchParams.set("$top", String(input.pageSize));
  if (input.fields) url.searchParams.set("$select", input.fields.join(","));
  const filters: string[] = [];
  if ((input.modifiedFrom || input.modifiedTo) && !input.entity.modifiedField) {
    throw new ProviderRequestError(422, `Incremental reads are unsupported for ERP domain ${input.entity.domain}`, {
      code: "unsupported",
      domain: input.entity.domain,
      feature: "modifiedRange",
    });
  }
  requireErpCompanyField(input.entity, input.companyId);
  if (input.modifiedFrom) filters.push(`${input.entity.modifiedField} ge ${odataLiteral(input.modifiedFrom)}`);
  if (input.modifiedTo) filters.push(`${input.entity.modifiedField} lt ${odataLiteral(input.modifiedTo)}`);
  if (input.companyId) filters.push(`${input.entity.companyField} eq ${odataLiteral(input.companyId)}`);
  if (filters.length) url.searchParams.set("$filter", filters.join(" and "));
  return { url };
}

function decodeCursorUrl(cursor: string | undefined, baseUrl: string): URL | undefined {
  if (!cursor) return undefined;
  let url: URL;
  try {
    url = new URL(cursor, `${baseUrl}/`);
  } catch {
    throw new ProviderRequestError(400, "cursor is invalid");
  }
  if (url.origin !== new URL(baseUrl).origin) {
    throw new ProviderRequestError(400, "cursor must stay on the configured ERP origin");
  }
  return url;
}

function odataLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function records(values: unknown[]): Array<Record<string, unknown>> {
  return values.map((value) => {
    const record = optionalRecord(value);
    if (!record) throw new ProviderRequestError(502, "ERP response contained a non-object record");
    return record;
  });
}
