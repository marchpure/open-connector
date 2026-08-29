import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  TransitFileWriter,
} from "../../core/types.ts";
import type { ProviderResourceCandidate } from "../provider-loader.ts";

import { createHmac } from "node:crypto";
import { posix } from "node:path";
import { compactObject, optionalInteger, optionalRecord, optionalString } from "../../core/cast.ts";
import { assertPublicHttpUrl, assertSafeObjectResponse, readBoundedResponseBytes } from "../../core/request.ts";
import {
  createProviderFetch,
  createProviderTimeout,
  ProviderRequestError,
  toProviderExecutionError,
} from "../provider-runtime.ts";

interface KodoContext {
  values: Record<string, string>;
  fetcher: typeof fetch;
  transitFiles?: TransitFileWriter;
  signal?: AbortSignal;
}

const service = "qiniu_kodo";
const displayName = "Qiniu Kodo";
const maxMetadataBytes = 4 * 1024 * 1024;
const requestTimeoutMs = 30_000;

const handlers: Record<string, (input: Record<string, unknown>, context: KodoContext) => Promise<unknown>> = {
  async list_buckets(_input, context) {
    await listObjects({}, context);
    return {
      buckets: [
        {
          name: required(context.values.bucket, "bucket"),
          region: context.values.region,
          creationDate: "",
          storageClass: null,
        },
      ],
      owner: null,
      isTruncated: false,
      nextMarker: null,
    };
  },
  list_objects: listObjects,
  async head_object(input, context) {
    rejectVersion(input);
    const bucket = resolveBucket(input, context);
    const objectKey = allowedObjectKey(input, context);
    const result = await managementJson(context, "rs", `/stat/${urlSafeBase64(`${bucket}:${objectKey}`)}`);
    return { object: metadata(result, bucket, objectKey) };
  },
  async download_object(input, context) {
    rejectVersion(input);
    if (!context.transitFiles) {
      throw new ProviderRequestError(400, "qiniu_kodo download_object requires local transit file storage");
    }
    const bucket = resolveBucket(input, context);
    const objectKey = allowedObjectKey(input, context);
    const expected = await managementJson(context, "rs", `/stat/${urlSafeBase64(`${bucket}:${objectKey}`)}`);
    const expectedEtag = optionalString(expected.hash);
    if (!expectedEtag) {
      throw new ProviderRequestError(502, "Qiniu Kodo stat response is missing the object hash");
    }
    const ifMatch = optionalString(input.ifMatch);
    if (ifMatch && expectedEtag !== ifMatch.replace(/^"|"$/gu, "")) {
      throw new ProviderRequestError(412, "Qiniu Kodo object ETag no longer matches");
    }
    const url = buildDownloadUrl(context.values, objectKey);
    const requestHeaders = new Headers();
    if (expectedEtag) requestHeaders.set("if-match", expectedEtag);
    const response = await context.fetcher(url, {
      method: "GET",
      headers: requestHeaders,
      redirect: "error",
      signal: context.signal,
    });
    if (!response.ok) throw await kodoError(response, context.signal);
    const downloadedEtag = response.headers.get("etag")?.replace(/^"|"$/gu, "");
    if (expectedEtag && downloadedEtag !== expectedEtag) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderRequestError(412, "Qiniu Kodo object changed between metadata and download");
    }
    try {
      assertSafeObjectResponse(response, {
        fieldName: "Qiniu Kodo download",
        createError: (message) => new ProviderRequestError(415, message),
      });
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    const bytes = await readBoundedResponseBytes(response, {
      maxBytes: context.transitFiles.maxBytes,
      fieldName: "Qiniu Kodo download",
      createError: (message) => new ProviderRequestError(413, message),
      signal: context.signal,
    });
    const mimeType =
      response.headers.get("content-type") ?? optionalString(expected.mimeType) ?? "application/octet-stream";
    const name = optionalString(input.fileName) ?? (posix.basename(objectKey) || "object");
    const file = await context.transitFiles.create(new File([Uint8Array.from(bytes)], name, { type: mimeType }));
    return {
      objectKey,
      name,
      mimeType,
      sizeBytes: file.sizeBytes,
      etag: downloadedEtag ?? expectedEtag ?? null,
      versionId: null,
      file,
    };
  },
};

export const executors: ProviderExecutors = Object.fromEntries(
  Object.entries(handlers).map(([name, handler]) => [
    `${service}.${name}`,
    async (input: unknown, executionContext: ExecutionContext) => {
      const timeout = createProviderTimeout(executionContext.signal, requestTimeoutMs);
      try {
        const credential = await executionContext.getCredential(service);
        if (credential?.authType !== "custom_credential") {
          throw new ProviderRequestError(401, "Configure qiniu_kodo custom credentials first.");
        }
        return {
          ok: true,
          output: await handler(input as Record<string, unknown>, {
            values: credential.values,
            fetcher: createProviderFetch(),
            transitFiles: executionContext.transitFiles,
            signal: timeout.signal,
          }),
        };
      } catch (error) {
        if (timeout.didTimeout()) {
          return toProviderExecutionError(
            new ProviderRequestError(504, "Qiniu Kodo request timed out"),
            "Qiniu Kodo request failed",
          );
        }
        return toProviderExecutionError(error, "Qiniu Kodo request failed");
      } finally {
        timeout.cleanup();
      }
    },
  ]),
);

export const credentialValidators: CredentialValidators = {
  async customCredential(input, options): Promise<CredentialValidationResult> {
    const timeout = createProviderTimeout(options.signal, requestTimeoutMs);
    try {
      const context = {
        values: input.values,
        fetcher: createProviderFetch({ fetch: options.fetcher }),
        signal: timeout.signal,
      };
      await listObjects({ maxKeys: 1 }, context);
      const bucket = required(input.values.bucket, "bucket");
      return {
        profile: { accountId: `${service}:${input.values.accessKeyId}`, displayName: `${displayName} - ${bucket}` },
        metadata: {
          region: input.values.region,
          endpoint: managementEndpoint(input.values, "rsf").origin,
          downloadDomain: downloadOrigin(input.values).origin,
          bucket,
          prefix: input.values.prefix,
          credentialKind: "aksk",
          signing: "qiniu-v2",
        },
      };
    } catch (error) {
      if (timeout.didTimeout()) throw new ProviderRequestError(504, "Qiniu Kodo credential validation timed out");
      throw error;
    } finally {
      timeout.cleanup();
    }
  },
};

export async function discoverResources(
  context: ExecutionContext,
  fetcher: typeof fetch,
): Promise<ProviderResourceCandidate[]> {
  const credential = await context.getCredential(service);
  if (credential?.authType !== "custom_credential") {
    throw new ProviderRequestError(401, "Configure qiniu_kodo custom credentials first.");
  }
  const timeout = createProviderTimeout(context.signal, requestTimeoutMs);
  try {
    const runtime = { values: credential.values, fetcher, signal: timeout.signal };
    await listObjects({ maxKeys: 1 }, runtime);
    const bucket = required(credential.values.bucket, "bucket");
    return [
      {
        sourceType: service,
        resourceId: bucket,
        title: `${displayName} bucket ${bucket}`,
        mimeType: "application/vnd.qiniu.kodo.bucket",
        schema: compactObject({
          name: bucket,
          region: credential.values.region,
          endpoint: managementEndpoint(credential.values, "rsf").origin,
          prefix: credential.values.prefix,
          allowlisted: true,
        }),
        url: `qiniu://${bucket}`,
      },
    ];
  } catch (error) {
    if (timeout.didTimeout()) throw new ProviderRequestError(504, "Qiniu Kodo discovery timed out");
    throw error;
  } finally {
    timeout.cleanup();
  }
}

async function listObjects(input: Record<string, unknown>, context: KodoContext): Promise<Record<string, unknown>> {
  const bucket = resolveBucket(input, context);
  const prefix = allowedPrefix(input, context);
  const url = managementEndpoint(context.values, "rsf");
  url.pathname = "/list";
  url.searchParams.set("bucket", bucket);
  if (prefix) url.searchParams.set("prefix", prefix);
  const delimiter = optionalString(input.delimiter);
  if (delimiter) url.searchParams.set("delimiter", delimiter);
  const marker = optionalString(input.continuationToken);
  if (marker) url.searchParams.set("marker", marker);
  url.searchParams.set("limit", String(Math.min(Math.max(optionalInteger(input.maxKeys) ?? 100, 1), 1000)));
  const result = await signedJson(context, url, "POST");
  const objects = array(result.items).flatMap((entry) => {
    const item = optionalRecord(entry);
    const key = optionalString(item?.key);
    if (!key) return [];
    return [
      {
        name: key,
        url: `qiniu://${bucket}/${key}`,
        lastModified: qiniuTimestamp(item?.putTime),
        etag: optionalString(item?.hash) ?? "",
        type: optionalString(item?.mimeType) ?? "object",
        size: optionalInteger(item?.fsize) ?? 0,
        storageClass: item?.type == null ? null : String(item.type),
        owner: null,
        region: context.values.region,
      },
    ];
  });
  const next = optionalString(result.marker) ?? null;
  return {
    objects,
    prefixes: array(result.commonPrefixes).flatMap((value) => (typeof value === "string" ? [value] : [])),
    isTruncated: next !== null,
    keyCount: objects.length,
    continuationToken: marker ?? null,
    nextContinuationToken: next,
  };
}

async function managementJson(
  context: KodoContext,
  kind: "rs" | "rsf",
  path: string,
): Promise<Record<string, unknown>> {
  const url = managementEndpoint(context.values, kind);
  url.pathname = path;
  return signedJson(context, url);
}

async function signedJson(
  context: KodoContext,
  url: URL,
  method: "GET" | "POST" = "GET",
): Promise<Record<string, unknown>> {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    "x-qiniu-date": formatQiniuDate(new Date()),
  });
  headers.set("authorization", qiniuAuthorization(url, method, headers, context.values));
  const response = await context.fetcher(url, { method, headers, redirect: "error", signal: context.signal });
  if (!response.ok) throw await kodoError(response, context.signal);
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: maxMetadataBytes,
    fieldName: "Qiniu Kodo response",
    createError: (message) => new ProviderRequestError(413, message),
    signal: context.signal,
  });
  try {
    return optionalRecord(JSON.parse(new TextDecoder().decode(bytes))) ?? {};
  } catch {
    throw new ProviderRequestError(502, "Qiniu Kodo returned invalid JSON");
  }
}

export function qiniuAuthorization(url: URL, method: string, headers: Headers, values: Record<string, string>): string {
  const canonical = `${method} ${url.pathname}${url.search}\nHost: ${url.host}\nContent-Type: application/x-www-form-urlencoded\nX-Qiniu-Date: ${headers.get("x-qiniu-date")}\n\n`;
  return `Qiniu ${required(values.accessKeyId, "accessKeyId")}:${hmacUrl(required(values.secretAccessKey, "secretAccessKey"), canonical)}`;
}

function buildDownloadUrl(values: Record<string, string>, objectKey: string): URL {
  const url = downloadOrigin(values);
  url.pathname = `/${encodeKey(objectKey)}`;
  url.searchParams.set("e", String(Math.floor(Date.now() / 1000) + 300));
  const token = `${required(values.accessKeyId, "accessKeyId")}:${hmacUrl(required(values.secretAccessKey, "secretAccessKey"), url.toString())}`;
  url.searchParams.set("token", token);
  return url;
}

function managementEndpoint(values: Record<string, string>, kind: "rs" | "rsf"): URL {
  const configured = required(values.endpoint, "endpoint");
  const url = strictHttpsOrigin(configured, ["qiniu.com", "qbox.me", "qiniuapi.com"]);
  if (kind === "rs" && url.hostname.startsWith("rsf")) url.hostname = url.hostname.replace(/^rsf/u, "rs");
  if (kind === "rsf" && url.hostname.startsWith("rs") && !url.hostname.startsWith("rsf")) {
    url.hostname = url.hostname.replace(/^rs/u, "rsf");
  }
  if (!url.hostname.startsWith(`${kind}.`) && !url.hostname.startsWith(`${kind}-`)) {
    throw new ProviderRequestError(400, `endpoint must be an official Qiniu ${kind.toUpperCase()} origin`);
  }
  return url;
}

function downloadOrigin(values: Record<string, string>): URL {
  return strictHttpsOrigin(required(values.downloadDomain, "downloadDomain"));
}

function strictHttpsOrigin(value: string, suffixes?: string[]): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new ProviderRequestError(400, "endpoint must be an HTTPS origin");
  }
  if (suffixes && !suffixes.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))) {
    throw new ProviderRequestError(400, "endpoint is outside the official Qiniu domain allowlist");
  }
  assertPublicHttpUrl(url.toString(), {
    fieldName: "endpoint",
    createError: (message) => new ProviderRequestError(400, message),
  });
  return url;
}

function metadata(item: Record<string, unknown>, bucket: string, objectKey: string): Record<string, unknown> {
  return {
    bucket,
    objectKey,
    etag: optionalString(item.hash) ?? null,
    contentLength: optionalInteger(item.fsize) ?? null,
    contentType: optionalString(item.mimeType) ?? null,
    lastModified: qiniuTimestamp(item.putTime),
    cacheControl: null,
    contentDisposition: null,
    contentEncoding: null,
    storageClass: item.type == null ? null : String(item.type),
    versionId: null,
    metadata: Object.fromEntries(
      Object.entries(optionalRecord(item.metaData) ?? {}).map(([key, value]) => [key, String(value)]),
    ),
    headers: {},
  };
}

async function kodoError(response: Response, signal?: AbortSignal): Promise<ProviderRequestError> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: 1024 * 1024,
    fieldName: "Qiniu Kodo error",
    createError: (message) => new ProviderRequestError(413, message),
    signal,
  }).catch(() => new Uint8Array());
  let providerCode: string | undefined;
  try {
    const payload = optionalRecord(JSON.parse(new TextDecoder().decode(bytes)));
    const rawCode = typeof payload?.code === "number" || typeof payload?.code === "string" ? String(payload.code) : "";
    providerCode = /^-?\d{1,12}$/u.test(rawCode) ? rawCode : undefined;
  } catch {}
  const status =
    response.status === 401 || response.status === 403 || response.status === 404 || response.status === 429
      ? response.status
      : response.status >= 500
        ? 502
        : response.status;
  return new ProviderRequestError(
    status,
    `${response.status === 401 || response.status === 403 ? "Qiniu Kodo authorization failed" : "Qiniu Kodo request failed"}${providerCode ? ` (${providerCode})` : ""}`,
  );
}

function resolveBucket(input: Record<string, unknown>, context: KodoContext): string {
  const configured = required(context.values.bucket, "bucket");
  if (!/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/iu.test(configured) || configured.length > 255) {
    throw new ProviderRequestError(400, "bucket must be a valid Qiniu bucket name");
  }
  const requested = optionalString(input.bucket) ?? configured;
  if (requested !== configured) throw new ProviderRequestError(403, "bucket is outside the connection allowlist");
  return requested;
}

function allowedPrefix(input: Record<string, unknown>, context: KodoContext): string {
  const allowed = context.values.prefix ?? "";
  const requested = optionalString(input.prefix) ?? allowed;
  if (allowed && !requested.startsWith(allowed))
    throw new ProviderRequestError(403, "prefix is outside the connection allowlist");
  return requested;
}

function allowedObjectKey(input: Record<string, unknown>, context: KodoContext): string {
  const key = required(input.objectKey, "objectKey");
  const allowed = context.values.prefix ?? "";
  if (allowed && !key.startsWith(allowed))
    throw new ProviderRequestError(403, "objectKey is outside the connection allowlist");
  if (key.split("/").some((part) => part === "." || part === "..")) {
    throw new ProviderRequestError(400, "objectKey must not contain . or .. path segments");
  }
  return key;
}

function rejectVersion(input: Record<string, unknown>): void {
  if (optionalString(input.versionId)) {
    throw new ProviderRequestError(400, "Qiniu Kodo does not expose S3 versionId semantics");
  }
}

function required(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new ProviderRequestError(400, `${name} is required`);
}

function array(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function qiniuTimestamp(value: unknown): string {
  const ticks = optionalInteger(value);
  if (ticks == null) return "";
  const date = new Date(Math.floor(ticks / 10_000));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function formatQiniuDate(value: Date): string {
  return value
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
}

function urlSafeBase64(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function hmacUrl(secret: string, value: string): string {
  return createHmac("sha1", secret).update(value).digest("base64url");
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
