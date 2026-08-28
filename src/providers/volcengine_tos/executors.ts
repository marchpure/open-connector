import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  TransitFileWriter,
} from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";

import { createHash, createHmac } from "node:crypto";
import { compactObject, optionalInteger, optionalString } from "../../core/cast.ts";
import { assertGuardedEgressUrl } from "../../core/guarded-fetch.ts";
import { assertPublicHttpUrl, assertSafeObjectResponse, readBoundedResponseBytes } from "../../core/request.ts";
import { defineProviderExecutors, ProviderRequestError, providerUserAgent } from "../provider-runtime.ts";

const service = "volcengine_tos";
const tosService = "tos";
const requestTimeoutMs = 30_000;

interface TosContext {
  values: Record<string, string>;
  metadata: Record<string, unknown>;
  fetcher: typeof fetch;
  transitFiles?: TransitFileWriter;
  signal?: AbortSignal;
}

type TosHandler = (input: Record<string, unknown>, context: TosContext) => Promise<unknown>;

export const volcengineTosActionHandlers: ProviderActionHandlers<"volcengine_tos", TosHandler> = {
  validate_connection: (_input, context) => validateConnection(context),
  list_buckets: (_input, context) => listBuckets(context),
  list_objects: (input, context) => listObjects(input, context),
  head_object: (input, context) => headObject(input, context),
  download_object: (input, context) => downloadObject(input, context),
};

export const executors: ProviderExecutors = defineProviderExecutors<TosContext>({
  service,
  handlers: volcengineTosActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<TosContext> {
    const credential = await context.getCredential(service);
    if (credential?.authType !== "custom_credential") {
      throw new ProviderRequestError(401, "Configure volcengine_tos custom credentials first.");
    }
    return {
      values: credential.values,
      metadata: credential.metadata,
      fetcher,
      transitFiles: context.transitFiles,
      signal: context.signal,
    };
  },
});

export const credentialValidators: CredentialValidators = {
  async customCredential(input, { fetcher, signal }): Promise<CredentialValidationResult> {
    const values = input.values;
    const config = readConfig(values);
    const response = await tosRequest(config, { method: "HEAD", path: "/" }, fetcher, signal);
    if (!response.ok) {
      throw await tosError(response, "validate");
    }
    return {
      profile: {
        accountId: config.accessKeyId,
        displayName: `Volcengine TOS - ${config.bucket}`,
      },
      grantedScopes: [],
      metadata: compactObject({
        region: config.region,
        endpoint: config.endpoint,
        bucket: config.bucket,
        prefix: config.prefix,
        credentialKind: config.sessionToken ? "sts" : "aksk",
      }),
    };
  },
};

interface TosConfig {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  endpoint: string;
  bucket: string;
  prefix: string;
}

function readConfig(values: Record<string, string>): TosConfig {
  const endpoint = normalizeEndpoint(requireField(values.endpoint, "endpoint"));
  const bucket = requireField(values.bucket, "bucket");
  assertValidBucketName(bucket);
  const prefix = optionalString(values.prefix) ?? "";
  return {
    accessKeyId: requireField(values.accessKeyId, "accessKeyId"),
    secretAccessKey: requireField(values.secretAccessKey, "secretAccessKey"),
    sessionToken: optionalString(values.sessionToken),
    region: requireField(values.region, "region"),
    endpoint,
    bucket,
    prefix,
  };
}

async function validateConnection(context: TosContext): Promise<Record<string, unknown>> {
  const config = readConfig(context.values);
  const response = await tosRequest(config, { method: "HEAD", path: "/" }, context.fetcher, context.signal);
  if (!response.ok) throw await tosError(response, "validate");
  return { bucket: config.bucket, region: config.region, endpoint: config.endpoint };
}

async function listBuckets(context: TosContext): Promise<Record<string, unknown>> {
  const config = readConfig(context.values);
  const response = await tosRequest(config, { method: "HEAD", path: "/" }, context.fetcher, context.signal);
  if (!response.ok) throw await tosError(response, "list_buckets");
  return {
    buckets: [{ name: config.bucket, region: config.region, endpoint: config.endpoint, allowlisted: true }],
    isTruncated: false,
  };
}

async function listObjects(input: Record<string, unknown>, context: TosContext): Promise<Record<string, unknown>> {
  const config = readConfig(context.values);
  const bucket = assertBucket(input.bucket, config);
  const requestedPrefix = assertPrefix(optionalString(input.prefix) ?? config.prefix, config.prefix);
  const query = compactObject({
    "list-type": "2",
    prefix: requestedPrefix,
    delimiter: optionalString(input.delimiter),
    "continuation-token": optionalString(input.continuationToken),
    "start-after": optionalString(input.startAfter),
    "max-keys": boundedInteger(input.maxKeys, 1000),
  });
  const response = await tosRequest(
    config,
    { method: "GET", bucket, path: "/", query },
    context.fetcher,
    context.signal,
  );
  const xml = await readBodyText(response, "TOS list_objects", context.signal);
  if (!response.ok) throw tosErrorFromText(response, xml, "list_objects");
  return parseListObjects(xml, config);
}

async function headObject(input: Record<string, unknown>, context: TosContext): Promise<Record<string, unknown>> {
  const config = readConfig(context.values);
  const bucket = assertBucket(input.bucket, config);
  const key = assertObjectKey(input.objectKey, config.prefix);
  const response = await tosRequest(
    config,
    {
      method: "HEAD",
      bucket,
      path: `/${encodeKey(key)}`,
      query: compactObject({ versionId: optionalString(input.versionId) }),
      headers: optionalHeader("if-match", input.ifMatch),
    },
    context.fetcher,
    context.signal,
  );
  if (!response.ok) throw await tosError(response, "head_object");
  return { object: normalizeMetadata(bucket, key, response.headers) };
}

async function downloadObject(input: Record<string, unknown>, context: TosContext): Promise<Record<string, unknown>> {
  if (!context.transitFiles)
    throw new ProviderRequestError(400, "volcengine_tos download_object requires transit storage");
  const config = readConfig(context.values);
  const bucket = assertBucket(input.bucket, config);
  const key = assertObjectKey(input.objectKey, config.prefix);
  const response = await tosRequest(
    config,
    {
      method: "GET",
      bucket,
      path: `/${encodeKey(key)}`,
      query: compactObject({ versionId: optionalString(input.versionId) }),
      headers: optionalHeader("if-match", input.ifMatch),
    },
    context.fetcher,
    context.signal,
  );
  if (!response.ok) throw await tosError(response, "download_object");
  const name = optionalString(input.fileName) ?? key.split("/").findLast(Boolean) ?? "tos-object";
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream";
  assertSafeObjectResponse(response, {
    fieldName: "Volcengine TOS download",
    createError: (message) => new ProviderRequestError(415, message),
  });
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: context.transitFiles.maxBytes,
    fieldName: "Volcengine TOS download",
    createError: (message) => new ProviderRequestError(413, message),
    signal: context.signal,
  });
  const file = await context.transitFiles.create(new File([Uint8Array.from(bytes)], name, { type: mimeType }));
  return {
    objectKey: key,
    name,
    mimeType,
    sizeBytes: file.sizeBytes,
    etag: response.headers.get("etag"),
    versionId: response.headers.get("x-tos-version-id"),
    file,
  };
}

async function tosRequest(
  config: TosConfig,
  input: {
    method: "GET" | "HEAD";
    bucket?: string;
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    headers?: Record<string, string>;
  },
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  const bucket = input.bucket ?? config.bucket;
  const url = new URL(config.endpoint);
  url.hostname = `${bucket}.${url.hostname}`;
  url.pathname = input.path;
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  url.search = canonicalQuery(url.searchParams);
  const headers = new Headers(input.headers);
  headers.set("host", url.host);
  headers.set("user-agent", providerUserAgent);
  const payloadHash = sha256Hex("");
  headers.set("x-tos-content-sha256", payloadHash);
  const now = new Date();
  const date = formatDate(now);
  headers.set("x-tos-date", date);
  if (config.sessionToken) headers.set("x-tos-security-token", config.sessionToken);
  const authorization = signRequest(config, input.method, url, headers, payloadHash, date);
  headers.set("authorization", authorization);
  const timeout = createTimeout(signal, requestTimeoutMs);
  try {
    await assertGuardedEgressUrl(url.toString(), {
      fieldName: "TOS request URL",
      createError: (message) => new ProviderRequestError(400, message),
    });
    return await fetcher(url, { method: input.method, headers, signal: timeout.signal });
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    throw new ProviderRequestError(502, error instanceof Error ? error.message : "TOS request failed");
  } finally {
    timeout.cleanup();
  }
}

function signRequest(
  config: TosConfig,
  method: string,
  url: URL,
  headers: Headers,
  payloadHash: string,
  date: string,
): string {
  const signed = new Map<string, string>();
  for (const [name, value] of headers.entries()) signed.set(name.toLowerCase(), collapse(value));
  const signedHeaders = [...signed.keys()].sort().join(";");
  const canonicalHeaders =
    [...signed.keys()]
      .sort()
      .map((name) => `${name}:${signed.get(name)}`)
      .join("\n") + "\n";
  const canonicalRequest = [
    method,
    url.pathname || "/",
    url.search.slice(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const shortDate = date.slice(0, 8);
  const scope = `${shortDate}/${config.region}/${tosService}/request`;
  const stringToSign = `TOS4-HMAC-SHA256\n${date}\n${scope}\n${sha256Hex(canonicalRequest)}`;
  const signingKey = hmac(
    hmac(hmac(hmac(`TOS4${config.secretAccessKey}`, shortDate), config.region), tosService),
    "request",
  );
  return `TOS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey, stringToSign)}`;
}

function parseListObjects(xml: string, config: TosConfig): Record<string, unknown> {
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => {
    const block = match[1] ?? "";
    const key = xmlTag(block, "Key") ?? "";
    return {
      name: key,
      url: objectUrl(config, key),
      lastModified: xmlTag(block, "LastModified") ?? "",
      etag: xmlTag(block, "ETag") ?? "",
      type: "object",
      size: Number(xmlTag(block, "Size") ?? 0),
      storageClass: xmlTag(block, "StorageClass"),
      owner: null,
    };
  });
  return {
    objects,
    prefixes: [...xml.matchAll(/<CommonPrefixes><Prefix>([\s\S]*?)<\/Prefix><\/CommonPrefixes>/g)].map((match) =>
      decodeXml(match[1] ?? ""),
    ),
    isTruncated: xmlTag(xml, "IsTruncated") === "true",
    nextContinuationToken: xmlTag(xml, "NextContinuationToken"),
  };
}

function normalizeMetadata(bucket: string, key: string, headers: Headers): Record<string, unknown> {
  const values = Object.fromEntries(headers.entries());
  return {
    bucket,
    objectKey: key,
    etag: headers.get("etag"),
    contentLength: numberOrNull(headers.get("content-length")),
    contentType: headers.get("content-type"),
    lastModified: headers.get("last-modified"),
    contentEncoding: headers.get("content-encoding"),
    storageClass: headers.get("x-tos-storage-class"),
    versionId: headers.get("x-tos-version-id"),
    metadata: Object.fromEntries(Object.entries(values).filter(([name]) => name.startsWith("x-tos-meta-"))),
    headers: Object.fromEntries(
      Object.entries(values).filter(([name]) => !/(authorization|token|secret|cookie)/i.test(name)),
    ),
  };
}

function assertBucket(value: unknown, config: TosConfig): string {
  const bucket = optionalString(value) ?? config.bucket;
  assertValidBucketName(bucket);
  if (bucket !== config.bucket) throw new ProviderRequestError(403, "bucket is outside the TOS connection allowlist");
  return bucket;
}

function assertValidBucketName(bucket: string): void {
  if (!/^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$/u.test(bucket) || bucket.includes("..")) {
    throw new ProviderRequestError(400, "bucket must be a valid TOS bucket name");
  }
}

function assertPrefix(value: string, allowed: string): string {
  if (allowed && !value.startsWith(allowed))
    throw new ProviderRequestError(403, "prefix is outside the TOS connection allowlist");
  return value;
}

function assertObjectKey(value: unknown, allowedPrefix: string): string {
  const key = optionalString(value);
  if (!key) throw new ProviderRequestError(400, "objectKey is required");
  if (
    [...key].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new ProviderRequestError(400, "objectKey contains an unsafe control character");
  }
  if (key.split("/").some((part) => part === "." || part === ".."))
    throw new ProviderRequestError(400, "objectKey must not contain dot segments");
  if (allowedPrefix && !key.startsWith(allowedPrefix))
    throw new ProviderRequestError(403, "objectKey is outside the TOS connection allowlist");
  return key;
}

function normalizeEndpoint(value: string): string {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new ProviderRequestError(400, "endpoint must be an HTTPS origin without credentials or a path");
  }
  assertPublicHttpUrl(url.toString(), {
    fieldName: "endpoint",
    createError: (message) => new ProviderRequestError(400, message),
  });
  return `${url.protocol}//${url.host}`;
}

function encodeKey(value: string): string {
  return value
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function objectUrl(config: TosConfig, key: string): string {
  const url = new URL(config.endpoint);
  url.hostname = `${config.bucket}.${url.hostname}`;
  url.pathname = `/${encodeKey(key)}`;
  return url.toString();
}

function canonicalQuery(query: URLSearchParams): string {
  return [...query.entries()]
    .sort(
      ([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    )
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function requireField(value: unknown, name: string): string {
  const result = optionalString(value);
  if (!result) throw new ProviderRequestError(400, `${name} is required`);
  return result;
}

function optionalHeader(name: string, value: unknown): Record<string, string> | undefined {
  const resolved = optionalString(value);
  return resolved ? { [name]: resolved } : undefined;
}

function boundedInteger(value: unknown, fallback: number): number {
  const number = optionalInteger(value);
  return number === undefined ? fallback : Math.min(Math.max(number, 1), 1000);
}

function xmlTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXml(match[1] ?? "") : null;
}

function decodeXml(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

async function readBodyText(response: Response, fieldName: string, signal?: AbortSignal): Promise<string> {
  return new TextDecoder().decode(
    await readBoundedResponseBytes(response, {
      maxBytes: 2 * 1024 * 1024,
      fieldName,
      signal,
      createError: (message) => new ProviderRequestError(413, message),
    }),
  );
}

async function tosError(response: Response, phase: string): Promise<ProviderRequestError> {
  return tosErrorFromText(response, await readBodyText(response, `TOS ${phase} error`), phase);
}

function tosErrorFromText(response: Response, text: string, phase: string): ProviderRequestError {
  const code = xmlTag(text, "Code") ?? response.statusText;
  return new ProviderRequestError(response.status, `Volcengine TOS ${phase} failed (${code || response.status})`);
}

function formatDate(date: Date): string {
  return date
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function collapse(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ");
}

function createTimeout(parent: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      parent?.removeEventListener("abort", abort);
    },
  };
}
