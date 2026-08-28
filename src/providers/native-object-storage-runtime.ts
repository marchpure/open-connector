import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  TransitFileWriter,
} from "../core/types.ts";
import type { ProviderResourceCandidate } from "./provider-loader.ts";

import { XMLParser } from "fast-xml-parser";
import { createHash, createHmac } from "node:crypto";
import { posix } from "node:path";
import { compactObject, optionalInteger, optionalRecord, optionalString } from "../core/cast.ts";
import { assertPublicHttpUrl, assertSafeObjectResponse, readBoundedResponseBytes } from "../core/request.ts";
import {
  createProviderFetch,
  createProviderTimeout,
  ProviderRequestError,
  toProviderExecutionError,
} from "./provider-runtime.ts";

export type NativeStorageService = "tencent_cos" | "huawei_obs";

export interface NativeStorageProfile {
  service: NativeStorageService;
  displayName: string;
  bucketMimeType: string;
  listDialect: "v2" | "marker";
  buildEndpoint(values: Record<string, string>): URL;
  sign(request: Request, values: Record<string, string>): void;
  parseList?(payload: string, bucket: string, region: string): NativeObjectPage;
  parseHead?(headers: Headers, bucket: string, objectKey: string): Record<string, unknown>;
  mapError?(status: number, body: string): ProviderRequestError;
}

interface NativeStorageContext {
  values: Record<string, string>;
  fetcher: typeof fetch;
  transitFiles?: TransitFileWriter;
  signal?: AbortSignal;
}

interface NativeObjectPage {
  objects: Array<Record<string, unknown>>;
  prefixes: string[];
  isTruncated: boolean;
  keyCount: number;
  continuationToken: string | null;
  nextContinuationToken: string | null;
}

const xmlParser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });
const nativeStorageTimeoutMs = 30_000;

export function createNativeObjectStorageRuntime(profile: NativeStorageProfile): {
  executors: ProviderExecutors;
  credentialValidators: CredentialValidators;
  discoverResources: (context: ExecutionContext, fetcher: typeof fetch) => Promise<ProviderResourceCandidate[]>;
} {
  const handlers: Record<string, (input: Record<string, unknown>, context: NativeStorageContext) => Promise<unknown>> =
    {
      async list_buckets(_input, context) {
        const bucket = requiredValue(context.values.bucket, "bucket");
        await nativeRequest(profile, context, { method: "HEAD", bucket });
        return {
          buckets: [{ name: bucket, region: context.values.region, creationDate: "", storageClass: null }],
          owner: null,
          isTruncated: false,
          nextMarker: null,
        };
      },
      async list_objects(input, context) {
        const bucket = resolveBucket(input, context);
        const prefix = allowedPrefix(input, context);
        const maxKeys = Math.min(Math.max(optionalInteger(input.maxKeys) ?? 100, 1), 1000);
        const response = await nativeRequest(profile, context, {
          method: "GET",
          bucket,
          query: compactObject({
            "list-type": profile.listDialect === "v2" ? 2 : undefined,
            prefix,
            delimiter: optionalString(input.delimiter),
            "continuation-token": profile.listDialect === "v2" ? optionalString(input.continuationToken) : undefined,
            marker: profile.listDialect === "marker" ? optionalString(input.continuationToken) : undefined,
            "max-keys": maxKeys,
          }),
        });
        const text = await boundedText(
          response,
          `${profile.displayName} object listing`,
          4 * 1024 * 1024,
          context.signal,
        );
        return (profile.parseList ?? parseS3List)(text, bucket, context.values.region);
      },
      async head_object(input, context) {
        const bucket = resolveBucket(input, context);
        const objectKey = allowedObjectKey(input, context);
        const response = await nativeRequest(profile, context, {
          method: "HEAD",
          bucket,
          objectKey,
          query: compactObject({ versionId: optionalString(input.versionId) }),
          headers: compactObject({ "if-match": optionalString(input.ifMatch) }),
        });
        return {
          object: (profile.parseHead ?? parseHead)(response.headers, bucket, objectKey),
        };
      },
      async download_object(input, context) {
        if (!context.transitFiles) {
          throw new ProviderRequestError(400, `${profile.service} download_object requires local transit file storage`);
        }
        const bucket = resolveBucket(input, context);
        const objectKey = allowedObjectKey(input, context);
        const response = await nativeRequest(profile, context, {
          method: "GET",
          bucket,
          objectKey,
          query: compactObject({ versionId: optionalString(input.versionId) }),
          headers: compactObject({ "if-match": optionalString(input.ifMatch) }),
        });
        try {
          assertSafeObjectResponse(response, {
            fieldName: `${profile.displayName} download`,
            createError: (message) => new ProviderRequestError(415, message),
          });
        } catch (error) {
          await response.body?.cancel().catch(() => undefined);
          throw error;
        }
        const bytes = await readBoundedResponseBytes(response, {
          maxBytes: context.transitFiles.maxBytes,
          fieldName: `${profile.displayName} download`,
          createError: (message) => new ProviderRequestError(413, message),
          signal: context.signal,
        });
        const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
        const name = optionalString(input.fileName) ?? (posix.basename(objectKey) || "object");
        const file = await context.transitFiles.create(new File([Uint8Array.from(bytes)], name, { type: mimeType }));
        return {
          objectKey,
          name,
          mimeType,
          sizeBytes: file.sizeBytes,
          etag: response.headers.get("etag"),
          versionId:
            response.headers.get("x-cos-version-id") ??
            response.headers.get("x-obs-version-id") ??
            response.headers.get("x-amz-version-id"),
          file,
        };
      },
    };
  const executors: ProviderExecutors = Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      `${profile.service}.${name}`,
      async (input: unknown, context: ExecutionContext) => {
        const timeout = createProviderTimeout(context.signal, nativeStorageTimeoutMs);
        try {
          const credential = await context.getCredential(profile.service);
          if (credential?.authType !== "custom_credential") {
            throw new ProviderRequestError(401, `Configure ${profile.service} custom credentials first.`);
          }
          return {
            ok: true,
            output: await handler(input as Record<string, unknown>, {
              values: credential.values,
              fetcher: createProviderFetch(),
              transitFiles: context.transitFiles,
              signal: timeout.signal,
            }),
          };
        } catch (error) {
          if (timeout.didTimeout()) {
            return toProviderExecutionError(
              new ProviderRequestError(504, `${profile.displayName} request timed out`),
              `${profile.displayName} request failed`,
            );
          }
          return toProviderExecutionError(error, `${profile.displayName} request failed`);
        } finally {
          timeout.cleanup();
        }
      },
    ]),
  );
  return {
    executors,
    credentialValidators: {
      async customCredential(input, options): Promise<CredentialValidationResult> {
        const timeout = createProviderTimeout(options.signal, nativeStorageTimeoutMs);
        try {
          const context: NativeStorageContext = {
            values: input.values,
            fetcher: createProviderFetch({ fetch: options.fetcher }),
            signal: timeout.signal,
          };
          const bucket = requiredValue(input.values.bucket, "bucket");
          await nativeRequest(profile, context, { method: "HEAD", bucket });
          return {
            profile: {
              accountId: `${profile.service}:${input.values.accessKeyId}`,
              displayName: `${profile.displayName} - ${bucket}`,
            },
            metadata: {
              region: input.values.region,
              endpoint: profile.buildEndpoint(input.values).origin,
              bucket,
              prefix: input.values.prefix,
              credentialKind: input.values.sessionToken ? "temporary" : "aksk",
              signing: profile.service,
            },
          };
        } catch (error) {
          if (timeout.didTimeout()) {
            throw new ProviderRequestError(504, `${profile.displayName} credential validation timed out`);
          }
          throw error;
        } finally {
          timeout.cleanup();
        }
      },
    },
    async discoverResources(context, fetcher) {
      const credential = await context.getCredential(profile.service);
      if (credential?.authType !== "custom_credential") {
        throw new ProviderRequestError(401, `Configure ${profile.service} custom credentials first.`);
      }
      const timeout = createProviderTimeout(context.signal, nativeStorageTimeoutMs);
      try {
        const bucket = requiredValue(credential.values.bucket, "bucket");
        const runtime = { values: credential.values, fetcher, signal: timeout.signal };
        await nativeRequest(profile, runtime, { method: "HEAD", bucket });
        return [
          {
            sourceType: profile.service,
            resourceId: bucket,
            title: `${profile.displayName} bucket ${bucket}`,
            mimeType: profile.bucketMimeType,
            schema: compactObject({
              name: bucket,
              region: credential.values.region,
              endpoint: profile.buildEndpoint(credential.values).origin,
              prefix: credential.values.prefix,
              allowlisted: true,
            }),
            url: buildNativeUrl(profile, credential.values, bucket).toString(),
          },
        ];
      } catch (error) {
        if (timeout.didTimeout()) {
          throw new ProviderRequestError(504, `${profile.displayName} discovery timed out`);
        }
        throw error;
      } finally {
        timeout.cleanup();
      }
    },
  };
}

interface NativeRequestInput {
  method: "GET" | "HEAD";
  bucket: string;
  objectKey?: string;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string | undefined>;
}

async function nativeRequest(
  profile: NativeStorageProfile,
  context: NativeStorageContext,
  input: NativeRequestInput,
): Promise<Response> {
  assertConfiguredBucket(input.bucket, context.values);
  const url = buildNativeUrl(profile, context.values, input.bucket, input.objectKey);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (value !== undefined) headers.set(key, value);
  }
  const request = new Request(url, { method: input.method, headers, signal: context.signal });
  profile.sign(request, context.values);
  const response = await context.fetcher(request);
  if (!response.ok) {
    const body = await boundedText(response, `${profile.displayName} error`, 1024 * 1024, context.signal).catch(
      () => "",
    );
    throw profile.mapError?.(response.status, body) ?? defaultStorageError(profile, response.status, body);
  }
  return response;
}

function buildNativeUrl(
  profile: NativeStorageProfile,
  values: Record<string, string>,
  bucket: string,
  objectKey?: string,
): URL {
  const base = profile.buildEndpoint(values);
  assertPublicHttpUrl(base.toString(), {
    fieldName: "endpoint",
    createError: (message) => new ProviderRequestError(400, message),
  });
  const configured = optionalString(values.endpoint);
  if (configured && new URL(configured).origin !== base.origin) {
    throw new ProviderRequestError(403, "endpoint is outside the connection allowlist");
  }
  const url = new URL(base);
  url.hostname = `${bucket}.${url.hostname}`;
  url.pathname = objectKey ? `/${encodeKey(objectKey)}` : "/";
  return url;
}

function parseS3List(payload: string, bucket: string, region: string): NativeObjectPage {
  let root: Record<string, unknown>;
  try {
    root = optionalRecord(xmlParser.parse(payload)) ?? {};
  } catch {
    throw new ProviderRequestError(502, "object storage returned invalid XML");
  }
  const result = optionalRecord(root.ListBucketResult) ?? root;
  const contents = toArray(result.Contents);
  const prefixes = toArray(result.CommonPrefixes)
    .map((entry) => optionalString(optionalRecord(entry)?.Prefix))
    .filter((value): value is string => value !== undefined);
  const objects = contents.flatMap((entry) => {
    const item = optionalRecord(entry);
    const key = optionalString(item?.Key);
    if (!key) return [];
    return [
      {
        name: key,
        url: `s3://${bucket}/${key}`,
        lastModified: optionalString(item?.LastModified) ?? "",
        etag: optionalString(item?.ETag) ?? "",
        type: "object",
        size: optionalInteger(item?.Size) ?? 0,
        storageClass: optionalString(item?.StorageClass) ?? null,
        owner: null,
        region,
      },
    ];
  });
  return {
    objects,
    prefixes,
    isTruncated: String(result.IsTruncated).toLowerCase() === "true",
    keyCount: objects.length,
    continuationToken: optionalString(result.ContinuationToken) ?? null,
    nextContinuationToken: optionalString(result.NextContinuationToken) ?? optionalString(result.NextMarker) ?? null,
  };
}

function parseHead(headers: Headers, bucket: string, objectKey: string): Record<string, unknown> {
  return {
    bucket,
    objectKey,
    etag: headers.get("etag"),
    contentLength: integerHeader(headers, "content-length"),
    contentType: headers.get("content-type"),
    lastModified: headers.get("last-modified"),
    cacheControl: headers.get("cache-control"),
    contentDisposition: headers.get("content-disposition"),
    contentEncoding: headers.get("content-encoding"),
    storageClass: headers.get("x-cos-storage-class") ?? headers.get("x-obs-storage-class"),
    versionId: headers.get("x-cos-version-id") ?? headers.get("x-obs-version-id") ?? headers.get("x-amz-version-id"),
    metadata: Object.fromEntries(Array.from(headers.entries()).filter(([name]) => /^x-(?:cos|obs)-meta-/u.test(name))),
    headers: Object.fromEntries(headers.entries()),
  };
}

export function cosSign(request: Request, values: Record<string, string>, nowDate: Date = new Date()): void {
  const now = Math.floor(nowDate.getTime() / 1000);
  const keyTime = `${now - 60};${now + 900}`;
  if (values.sessionToken) request.headers.set("x-cos-security-token", values.sessionToken);
  const url = new URL(request.url);
  const queryEntries = [...url.searchParams.entries()]
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const queryKeys = queryEntries.map(([key]) => key);
  const query = queryEntries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  const signedHeaders = [["host", url.host], ...Array.from(request.headers.entries())]
    .filter(([name]) => name === "host" || name.startsWith("x-cos-"))
    .sort(([left], [right]) => left.localeCompare(right));
  const headerList = signedHeaders.map(([name]) => name);
  const canonicalHeaders = signedHeaders
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value.trim())}`)
    .join("&");
  const httpString = `${request.method.toLowerCase()}\n${url.pathname}\n${query}\n${canonicalHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1(httpString)}\n`;
  const signature = hmacHex(hmacHex(requiredValue(values.secretAccessKey, "secretAccessKey"), keyTime), stringToSign);
  request.headers.set(
    "authorization",
    `q-sign-algorithm=sha1&q-ak=${encodeURIComponent(requiredValue(values.accessKeyId, "accessKeyId"))}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${headerList.join(";")}&q-url-param-list=${queryKeys.join(";")}&q-signature=${signature}`,
  );
}

export function obsSign(request: Request, values: Record<string, string>, nowDate: Date = new Date()): void {
  const date = nowDate.toUTCString();
  request.headers.set("date", date);
  if (values.sessionToken) request.headers.set("x-obs-security-token", values.sessionToken);
  const url = new URL(request.url);
  const obsHeaders = Array.from(request.headers.entries())
    .filter(([name]) => name.startsWith("x-obs-"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value.trim()}\n`)
    .join("");
  const versionId = url.searchParams.get("versionId");
  const canonicalResource = `/${requiredValue(values.bucket, "bucket")}${url.pathname}${versionId === null ? "" : `?versionId=${versionId}`}`;
  const canonical = `${request.method}\n\n${request.headers.get("content-type") ?? ""}\n${date}\n${obsHeaders}${canonicalResource}`;
  const signature = createHmac("sha1", requiredValue(values.secretAccessKey, "secretAccessKey"))
    .update(canonical)
    .digest("base64");
  request.headers.set("authorization", `OBS ${requiredValue(values.accessKeyId, "accessKeyId")}:${signature}`);
}

export function nativeEndpoint(value: string | undefined, fallback: string, allowedHostSuffixes: string[]): URL {
  const url = new URL(value || fallback);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !allowedHostSuffixes.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))
  ) {
    throw new ProviderRequestError(400, "endpoint is not an allowed provider HTTPS origin");
  }
  return url;
}

function resolveBucket(input: Record<string, unknown>, context: NativeStorageContext): string {
  const bucket = optionalString(input.bucket) ?? requiredValue(context.values.bucket, "bucket");
  assertConfiguredBucket(bucket, context.values);
  return bucket;
}

function assertConfiguredBucket(bucket: string, values: Record<string, string>): void {
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(bucket) || bucket.length > 255) {
    throw new ProviderRequestError(400, "bucket must be a valid object-storage bucket name");
  }
  if (bucket !== requiredValue(values.bucket, "bucket")) {
    throw new ProviderRequestError(403, "bucket is outside the connection allowlist");
  }
}

function allowedPrefix(input: Record<string, unknown>, context: NativeStorageContext): string {
  const allowed = context.values.prefix ?? "";
  const requested = optionalString(input.prefix) ?? allowed;
  if (allowed && !requested.startsWith(allowed)) {
    throw new ProviderRequestError(403, "prefix is outside the connection allowlist");
  }
  return requested;
}

function allowedObjectKey(input: Record<string, unknown>, context: NativeStorageContext): string {
  const key = requiredValue(input.objectKey, "objectKey");
  const allowed = context.values.prefix ?? "";
  if (allowed && !key.startsWith(allowed)) {
    throw new ProviderRequestError(403, "objectKey is outside the connection allowlist");
  }
  if (key.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new ProviderRequestError(400, "objectKey must not contain . or .. path segments");
  }
  return key;
}

function requiredValue(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new ProviderRequestError(400, `${field} is required`);
}

function encodeKey(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/gu, percentEncode))
    .join("/");
}

function percentEncode(value: string): string {
  return `%${value.charCodeAt(0).toString(16).toUpperCase()}`;
}

function toArray(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function integerHeader(headers: Headers, name: string): number | null {
  const value = Number(headers.get(name));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function boundedText(
  response: Response,
  fieldName: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes,
    fieldName,
    createError: (message) => new ProviderRequestError(413, message),
    signal,
  });
  return new TextDecoder().decode(bytes);
}

function defaultStorageError(profile: NativeStorageProfile, status: number, body: string): ProviderRequestError {
  const rawCode =
    body.match(/<(?:Code|code)>([^<]+)</u)?.[1] ??
    optionalString(
      (() => {
        try {
          return optionalRecord(JSON.parse(body))?.error;
        } catch {
          return undefined;
        }
      })(),
    );
  const code = rawCode && /^[A-Za-z0-9_.-]{1,128}$/u.test(rawCode) ? rawCode : undefined;
  if (status === 401 || status === 403) {
    return new ProviderRequestError(status, `${profile.displayName} authorization failed${code ? `: ${code}` : ""}`);
  }
  if (status === 404) return new ProviderRequestError(404, `${profile.displayName} resource was not found`);
  if (status === 429) return new ProviderRequestError(429, `${profile.displayName} rate limit exceeded`);
  return new ProviderRequestError(status >= 500 ? 502 : status, `${profile.displayName} request failed`);
}

function hmacHex(secret: string, value: string): string {
  return createHmac("sha1", secret).update(value).digest("hex");
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}
