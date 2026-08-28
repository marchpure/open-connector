import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
  TransitFileWriter,
} from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";

import { createHash, createHmac } from "node:crypto";
import { compactObject, optionalRecord, optionalString, requiredRawString } from "../../core/cast.ts";
import {
  assertPublicHttpUrl,
  assertSafeObjectResponse,
  hasUnsafeControlCharacter,
  isPrivateNetworkAccessAllowed,
  readBoundedResponseBytes,
} from "../../core/request.ts";
import {
  createProviderFetch,
  createProviderProxyUrl,
  createProviderTimeout,
  defineProviderExecutors,
  normalizeProviderProxyHeaders,
  providerFetch,
  ProviderRequestError,
  providerUserAgent,
  readProviderProxyResponse,
  toProviderProxyError,
} from "../provider-runtime.ts";

type AwsActionContext = {
  values: Record<string, string>;
  metadata: Record<string, unknown>;
  fetcher: typeof fetch;
  transitFiles?: TransitFileWriter;
  signal?: AbortSignal;
};

type AwsActionHandler = (input: Record<string, unknown>, context: AwsActionContext) => Promise<unknown>;

type AwsS3ClientConfig = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  allowPrivateNetwork?: boolean;
  fetcher: typeof fetch;
};

type AwsS3RequestInput = {
  method?: "GET" | "PUT" | "HEAD" | "DELETE";
  bucket?: string;
  endpoint?: string;
  objectKey?: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string | undefined>;
  body?: string | Buffer;
  signal?: AbortSignal;
};

type AwsOwner = {
  id: string;
  displayName: string | null;
};

type AwsObjectSummary = {
  name: string;
  url: string;
  lastModified: string;
  etag: string;
  type: string;
  size: number;
  storageClass: string | null;
  owner: AwsOwner | null;
};

type XmlNode = {
  name: string;
  children: XmlNode[];
  text: string;
};

class AwsS3HttpError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(input: { status: number; message: string; code?: string | null }) {
    super(input.message);
    this.name = "AwsS3HttpError";
    this.status = input.status;
    this.code = input.code ?? null;
  }
}

const sourceFetchTimeoutMs = 15_000;
const s3CompatibleRequestTimeoutMs = 30_000;
const maxSourceBytes = 20 * 1024 * 1024;
const awsServiceName = "s3";
const service = "aws_s3";

export const awsActionHandlers: ProviderActionHandlers<"aws_s3", AwsActionHandler> = {
  list_buckets(input, context) {
    return awsListBuckets(input, context);
  },
  list_objects(input, context) {
    return awsListObjects(input, context);
  },
  head_object(input, context) {
    return awsHeadObject(input, context);
  },
  download_object(input, context) {
    return awsDownloadObject(input, context);
  },
  put_object(input, context) {
    return awsPutObject(input, context);
  },
  delete_object(input, context) {
    return awsDeleteObject(input, context);
  },
  generate_presigned_url(input, context) {
    return awsGeneratePresignedUrl(input, context);
  },
};

export const executors: ProviderExecutors = defineProviderExecutors<AwsActionContext>({
  service,
  handlers: awsActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<AwsActionContext> {
    const credential = await context.getCredential(service);
    if (credential?.authType !== "custom_credential") {
      throw new ProviderRequestError(401, "Configure aws_s3 custom credentials first.");
    }
    return {
      values: credential.values,
      metadata: credential.metadata,
      fetcher: await createS3Fetcher(credential.values, fetcher),
      transitFiles: context.transitFiles,
      signal: context.signal,
    };
  },
});

export const proxy: ProviderProxyExecutor = async (input, context) => {
  try {
    const credential = await context.getCredential(service);
    if (credential?.authType !== "custom_credential") {
      throw new ProviderRequestError(401, "Configure aws_s3 custom credentials first.");
    }

    const region = resolveRegion(
      {},
      {
        values: credential.values,
        metadata: credential.metadata,
        fetcher: providerFetch,
        signal: context.signal,
      },
    );
    const bucket =
      optionalString(credential.metadata.bucket)?.trim() ?? optionalString(credential.values.bucket)?.trim();
    const endpoint =
      optionalString(credential.metadata.endpoint)?.trim() ?? optionalString(credential.values.endpoint)?.trim();
    const method = normalizeAwsS3ProxyMethod(input.method);
    const url = createProviderProxyUrl(buildAwsS3ProxyBaseUrl(region, bucket, endpoint), input.endpoint, input.query);
    url.search = canonicalizeSearchParams(url.searchParams);

    const body = normalizeAwsS3ProxyBody(input.body);
    const payloadHash =
      method === "PUT" ? sha256Hex(body ?? "") : body === undefined ? "UNSIGNED-PAYLOAD" : sha256Hex(body);
    const headers = normalizeProviderProxyHeaders(input.headers);
    headers.delete("user-agent");
    if (input.body !== undefined && !headers.has("content-type") && typeof input.body !== "string") {
      headers.set("content-type", "application/json");
    }
    headers.set("host", url.host);
    headers.set("x-amz-content-sha256", payloadHash);

    const signedRequest = signAwsRequest(
      createAwsS3Client({
        accessKeyId: requireAwsField(credential.values.accessKeyId, "accessKeyId"),
        secretAccessKey: requireAwsField(credential.values.secretAccessKey, "secretAccessKey"),
        sessionToken: optionalString(credential.values.sessionToken)?.trim(),
        region,
        endpoint,
        fetcher: providerFetch,
        allowPrivateNetwork: credential.values.allowPrivateNetwork === "true",
      }),
      {
        method,
        url,
        headers: Object.fromEntries(headers.entries()),
        payloadHash,
      },
    );
    signedRequest.headers.set("user-agent", providerUserAgent);

    const response = await providerFetch(url.toString(), {
      method,
      headers: signedRequest.headers,
      ...(body === undefined ? {} : { body }),
      signal: context.signal,
    });
    if (!response.ok) {
      throw await createAwsS3HttpError(response);
    }

    return { ok: true, response: await readProviderProxyResponse(response) };
  } catch (error) {
    return toProviderProxyError(normalizeAwsError(error, "execute"), "AWS S3 request failed");
  }
};

export const credentialValidators: CredentialValidators = {
  async customCredential(input, { fetcher }): Promise<CredentialValidationResult> {
    return validateAwsCredential(input.values, fetcher);
  },
};

export function createS3CompatibleExecutors(profile: {
  service: string;
  displayName: string;
  defaultEndpoint(values: Record<string, string>): string | undefined;
  forcePathStyle?: boolean;
}): {
  executors: ProviderExecutors;
  credentialValidators: CredentialValidators;
  discoverResources: (
    context: ExecutionContext,
    fetcher: typeof fetch,
  ) => Promise<
    Array<{
      sourceType: "tencent_cos" | "huawei_obs" | "minio" | "qiniu_kodo";
      resourceId: string;
      title?: string;
      mimeType?: string;
      schema?: Record<string, unknown>;
      url?: string;
    }>
  >;
} {
  const mappedExecutors: ProviderExecutors = Object.fromEntries(
    Object.entries(executors)
      .filter(([actionId]) =>
        ["list_buckets", "list_objects", "head_object", "download_object"].includes(actionId.slice("aws_s3.".length)),
      )
      .map(([actionId, executor]) => [
        `${profile.service}.${actionId.slice("aws_s3.".length)}`,
        async (input: unknown, context: ExecutionContext) => {
          const timeout = createProviderTimeout(context.signal, s3CompatibleRequestTimeoutMs);
          try {
            const result = await executor(input, {
              ...context,
              signal: timeout.signal,
              getCredential: async (requestedService) => {
                if (requestedService !== service) return context.getCredential(requestedService);
                const credential = await context.getCredential(profile.service);
                if (credential?.authType !== "custom_credential") return credential;
                const values = profileValues(credential.values, profile);
                return {
                  ...credential,
                  values,
                  metadata: profileMetadata(credential.metadata, values),
                };
              },
            });
            return timeout.didTimeout()
              ? {
                  ok: false,
                  error: {
                    code: "provider_error",
                    message: `${profile.service} request timed out`,
                    details: { status: 504 },
                  },
                }
              : result;
          } finally {
            timeout.cleanup();
          }
        },
      ]),
  );
  return {
    executors: mappedExecutors,
    credentialValidators: {
      async customCredential(input, options) {
        const values = profileValues(input.values, profile);
        const fetcher = await createS3Fetcher(values, options.fetcher);
        const timeout = createProviderTimeout(options.signal, s3CompatibleRequestTimeoutMs);
        try {
          const result = await validateAwsCredential(values, fetcher, timeout.signal);
          return {
            ...result,
            profile: {
              ...result.profile,
              displayName: `${profile.displayName} - ${input.values.bucket || input.values.region}`,
            },
            metadata: { ...result.metadata, providerProfile: profile.service },
          };
        } catch (error) {
          if (timeout.didTimeout()) throw new ProviderRequestError(504, `${profile.service} validation timed out`);
          throw error;
        } finally {
          timeout.cleanup();
        }
      },
    },
    async discoverResources(context, fetcher) {
      const timeout = createProviderTimeout(context.signal, s3CompatibleRequestTimeoutMs);
      try {
        const resources = await discoverResources(
          {
            ...context,
            signal: timeout.signal,
            getCredential: async (requestedService) => {
              if (requestedService !== service) return context.getCredential(requestedService);
              const credential = await context.getCredential(profile.service);
              if (credential?.authType !== "custom_credential") return credential;
              const values = profileValues(credential.values, profile);
              return {
                ...credential,
                values,
                metadata: profileMetadata(credential.metadata, values),
              };
            },
          },
          profile.service === "minio"
            ? await createS3Fetcher(await profileValuesForDiscovery(context, profile), fetcher)
            : fetcher,
        );
        return resources.map((resource) => ({
          ...resource,
          sourceType: profile.service as "tencent_cos" | "huawei_obs" | "minio" | "qiniu_kodo",
          mimeType: `application/vnd.${profile.service.replace("_", ".")}.bucket`,
          title: resource.title?.replace("S3", profile.displayName),
        }));
      } catch (error) {
        if (timeout.didTimeout()) throw new ProviderRequestError(504, `${profile.service} discovery timed out`);
        throw error;
      } finally {
        timeout.cleanup();
      }
    },
  };
}

function profileMetadata(metadata: Record<string, unknown>, values: Record<string, string>): Record<string, unknown> {
  return {
    ...metadata,
    endpoint: values.endpoint,
    region: values.region,
    bucket: values.bucket,
    prefix: values.prefix,
    forcePathStyle: values.forcePathStyle,
    allowPrivateNetwork: values.allowPrivateNetwork,
    caCertificateConfigured: Boolean(values.caCertificate),
  };
}

async function createS3Fetcher(values: Record<string, string>, fallback: typeof fetch): Promise<typeof fetch> {
  const caCertificate = optionalString(values.caCertificate);
  if (!caCertificate || values.customCa !== "true") {
    return values.allowPrivateNetwork === "true"
      ? createProviderFetch({ allowPrivateNetwork: isPrivateNetworkAccessAllowed })
      : fallback;
  }
  const { createMinioTlsFetch } = await import("../minio/tls-fetch.ts");
  return createProviderFetch({
    fetch: await createMinioTlsFetch(caCertificate),
    allowPrivateNetwork: values.allowPrivateNetwork === "true" ? isPrivateNetworkAccessAllowed : undefined,
  });
}

async function profileValuesForDiscovery(
  context: ExecutionContext,
  profile: {
    service: string;
    defaultEndpoint(values: Record<string, string>): string | undefined;
    forcePathStyle?: boolean;
  },
): Promise<Record<string, string>> {
  const credential = await context.getCredential(profile.service);
  return credential?.authType === "custom_credential" ? profileValues(credential.values, profile) : {};
}

function profileValues(
  values: Record<string, string>,
  profile: {
    service: string;
    defaultEndpoint(values: Record<string, string>): string | undefined;
    forcePathStyle?: boolean;
  },
): Record<string, string> {
  const endpoint = values.endpoint || profile.defaultEndpoint(values);
  return {
    ...values,
    ...(endpoint ? { endpoint } : {}),
    ...(profile.forcePathStyle ? { forcePathStyle: "true" } : {}),
    ...(profile.service === "minio" ? { customCa: "true" } : {}),
  };
}

export async function discoverResources(
  context: ExecutionContext,
  fetcher: typeof fetch,
): Promise<
  Array<{
    sourceType: "aws_s3";
    resourceId: string;
    title?: string;
    mimeType?: string;
    schema?: Record<string, unknown>;
    url?: string;
  }>
> {
  const credential = await context.getCredential(service);
  if (credential?.authType !== "custom_credential") {
    throw new ProviderRequestError(401, "Configure aws_s3 custom credentials first.");
  }
  const actionContext: AwsActionContext = {
    values: credential.values,
    metadata: credential.metadata,
    fetcher,
    signal: context.signal,
  };
  const result = await awsListBuckets({ maxKeys: 100 }, actionContext);
  const buckets = Array.isArray(result.buckets) ? result.buckets : [];
  return buckets
    .slice(0, 100)
    .map((bucket) => {
      const record = bucket && typeof bucket === "object" ? (bucket as Record<string, unknown>) : {};
      const name = optionalString(record.name);
      if (!name) return undefined;
      const region = optionalString(record.region) ?? resolveRegion({}, actionContext);
      return {
        sourceType: "aws_s3" as const,
        resourceId: name,
        title: `S3 bucket ${name}`,
        mimeType: "application/vnd.aws.s3.bucket",
        schema: compactObject({
          name,
          region,
          prefix: optionalString(credential.metadata.prefix) ?? optionalString(credential.values.prefix),
          allowlisted: true,
        }),
        url: buildBucketResourceUrl(
          region,
          name,
          resolveEndpoint({}, actionContext),
          isForcePathStyle(actionContext),
          allowsPrivateNetwork(actionContext),
        ),
      };
    })
    .filter((resource): resource is NonNullable<typeof resource> => resource !== undefined);
}

async function validateAwsCredential(
  input: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const accessKeyId = requireAwsField(input.accessKeyId, "accessKeyId");
  const secretAccessKey = requireAwsField(input.secretAccessKey, "secretAccessKey");
  const region = requireAwsField(input.region, "region");
  const bucket = optionalString(input.bucket);
  const endpoint = optionalString(input.endpoint);
  const prefix = optionalString(input.prefix);
  const sessionToken = optionalString(input.sessionToken);
  const client = createAwsS3Client({
    accessKeyId,
    secretAccessKey,
    sessionToken,
    region,
    fetcher,
    endpoint,
    forcePathStyle: input.forcePathStyle === "true",
  });

  try {
    if (bucket) {
      const bucketValidation = await validateBucketCredential(client, bucket, signal);
      if (bucketValidation.validated) {
        return {
          profile: {
            accountId: accessKeyId,
            displayName: `AWS S3 - ${bucket}`,
          },
          grantedScopes: [],
          metadata: compactObject({
            region,
            bucket,
            endpoint,
            prefix,
            credentialKind: sessionToken ? "sts" : "aksk",
            firstBucketName: bucket,
          }),
        };
      }
    }

    const response = await awsS3Request(client, {
      query: {
        "max-buckets": 1,
      },
      signal,
    });
    const xml = await readBoundedResponseText(response, "AWS S3 credential validation", undefined);
    const parsed = parseListBucketsXml(xml);
    const firstBucket = parsed.buckets[0];

    return {
      profile: {
        accountId: accessKeyId,
        displayName: firstBucket?.name ? `AWS S3 - ${firstBucket.name}` : `AWS S3 - ${region}`,
      },
      grantedScopes: [],
      metadata: compactObject({
        region,
        bucket,
        endpoint,
        prefix,
        credentialKind: sessionToken ? "sts" : "aksk",
        firstBucketName: firstBucket?.name,
      }),
    };
  } catch (error) {
    throw normalizeAwsError(error, "validate");
  }
}

async function awsListBuckets(input: Record<string, unknown>, context: AwsActionContext) {
  const allowlistedBucket = optionalString(context.metadata.bucket) ?? optionalString(context.values.bucket);
  if (allowlistedBucket) {
    const client = createClientForAction(input, context);
    await awsS3Request(client, { method: "HEAD", bucket: allowlistedBucket, signal: context.signal });
    return {
      buckets: [
        { name: allowlistedBucket, region: resolveRegion(input, context), storageClass: null, creationDate: "" },
      ],
      owner: null,
      isTruncated: false,
      nextMarker: null,
    };
  }
  const client = createClientForAction(input, context);
  const response = await awsS3Request(client, {
    query: compactObject({
      prefix: optionalString(input.prefix),
      "continuation-token": optionalString(input.marker),
      "max-buckets": asOptionalPositiveInteger(input.maxKeys),
    }),
    signal: context.signal,
  });
  const xml = await readBoundedResponseText(response, "AWS S3 bucket listing", context.signal);
  const parsed = parseListBucketsXml(xml);

  return {
    buckets: parsed.buckets,
    owner: parsed.owner,
    isTruncated: parsed.nextMarker != null,
    nextMarker: parsed.nextMarker,
  };
}

async function awsListObjects(input: Record<string, unknown>, context: AwsActionContext) {
  const bucket = resolveBucket(input, context);
  const region = resolveRegion(input, context);
  createAwsS3BaseUrl(
    region,
    bucket,
    resolveEndpoint(input, context),
    isForcePathStyle(context),
    allowsPrivateNetwork(context),
  );
  assertAllowedBucket(bucket, context);
  const requestedPrefix = assertAllowedPrefix(
    optionalString(input.prefix) ??
      optionalString(context.metadata.prefix) ??
      optionalString(context.values.prefix) ??
      "",
    context,
  );
  const response = await awsS3Request(createClientForAction(input, context), {
    bucket,
    query: compactObject({
      "list-type": 2,
      "encoding-type": "url",
      prefix: requestedPrefix,
      delimiter: optionalString(input.delimiter),
      "continuation-token": optionalString(input.continuationToken),
      "start-after": optionalString(input.startAfter),
      "fetch-owner": input.fetchOwner === true ? "true" : undefined,
      "max-keys": asOptionalPositiveInteger(input.maxKeys),
    }),
    signal: context.signal,
  });
  const xml = await readBoundedResponseText(response, "AWS S3 object listing", context.signal);
  const parsed = parseListObjectsXml(xml, { bucket, region });

  return parsed;
}

async function awsHeadObject(input: Record<string, unknown>, context: AwsActionContext) {
  const bucket = resolveBucket(input, context);
  const objectKey = requireAwsField(input.objectKey, "objectKey");
  createAwsS3BaseUrl(
    resolveRegion(input, context),
    bucket,
    resolveEndpoint(input, context),
    isForcePathStyle(context),
    allowsPrivateNetwork(context),
  );
  assertAllowedBucket(bucket, context);
  assertAllowedObjectKey(objectKey, context);
  const response = await awsS3Request(createClientForAction(input, context), {
    method: "HEAD",
    bucket,
    objectKey,
    query: compactObject({
      versionId: optionalString(input.versionId),
    }),
    headers: { "if-match": optionalString(input.ifMatch) },
    signal: context.signal,
  });
  const headers = normalizeHeaderRecord(response.headers);

  return {
    object: {
      bucket,
      objectKey,
      etag: headers.etag ?? null,
      contentLength: parseHeaderInteger(headers["content-length"]),
      contentType: headers["content-type"] ?? null,
      lastModified: headers["last-modified"] ?? null,
      cacheControl: headers["cache-control"] ?? null,
      contentDisposition: headers["content-disposition"] ?? null,
      contentEncoding: headers["content-encoding"] ?? null,
      storageClass: headers["x-amz-storage-class"] ?? null,
      versionId: headers["x-amz-version-id"] ?? null,
      metadata: extractAwsMetadata(headers),
      headers,
    },
  };
}

async function awsDownloadObject(input: Record<string, unknown>, context: AwsActionContext) {
  try {
    if (!context.transitFiles) {
      throw new ProviderRequestError(400, "aws_s3 download_object requires local transit file storage");
    }

    const bucket = resolveBucket(input, context);
    const objectKey = readObjectKey(input);
    createAwsS3BaseUrl(
      resolveRegion(input, context),
      bucket,
      resolveEndpoint(input, context),
      isForcePathStyle(context),
      allowsPrivateNetwork(context),
    );
    assertAllowedBucket(bucket, context);
    assertAllowedObjectKey(objectKey, context);
    const response = await awsS3Request(createClientForAction(input, context), {
      method: "GET",
      bucket,
      objectKey,
      query: compactObject({
        versionId: optionalString(input.versionId),
      }),
      headers: { "if-match": optionalString(input.ifMatch) },
      signal: context.signal,
    });

    const name = optionalString(input.fileName) ?? defaultObjectFileName(objectKey);
    const mimeType = optionalString(response.headers.get("content-type")) ?? "application/octet-stream";
    try {
      assertSafeObjectResponse(response, {
        fieldName: "AWS S3 download",
        createError: (message) => new ProviderRequestError(415, message),
      });
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    const bytes = await readBoundedResponseBytes(response, {
      maxBytes: context.transitFiles.maxBytes,
      fieldName: "AWS S3 download",
      createError: (message) => new ProviderRequestError(413, message),
      signal: context.signal,
    });
    const file = await context.transitFiles.create(new File([Uint8Array.from(bytes)], name, { type: mimeType }));

    return {
      objectKey,
      name,
      mimeType,
      sizeBytes: file.sizeBytes,
      etag: response.headers.get("etag"),
      versionId: response.headers.get("x-amz-version-id"),
      file,
    };
  } catch (error) {
    throw normalizeAwsError(error, "execute");
  }
}

async function awsPutObject(input: Record<string, unknown>, context: AwsActionContext) {
  const bucket = resolveBucket(input, context);
  const region = resolveRegion(input, context);
  const objectKey = requireAwsField(input.objectKey, "objectKey");
  assertAllowedBucket(bucket, context);
  assertAllowedObjectKey(objectKey, context);
  const sourceUrl = optionalString(input.sourceUrl);
  const sourceFile = sourceUrl ? await downloadSourceFile(sourceUrl, context.signal) : null;
  const resolvedContentType = optionalString(input.contentType) ?? sourceFile?.contentType;
  const body = sourceUrl
    ? sourceFile!.bytes
    : optionalString(input.contentBase64) != null
      ? Buffer.from(String(input.contentBase64), "base64")
      : Buffer.from(String(input.contentText ?? ""), "utf8");
  const response = await awsS3Request(createClientForAction(input, context), {
    method: "PUT",
    bucket,
    objectKey,
    body,
    headers: {
      "content-type": resolvedContentType,
      "cache-control": optionalString(input.cacheControl),
      "content-disposition": optionalString(input.contentDisposition),
      ...buildAwsMetadataHeaders(optionalRecord(input.metadata)),
    },
    signal: context.signal,
  });
  const headers = normalizeHeaderRecord(response.headers);

  return {
    bucket,
    objectKey,
    url: buildObjectUrl(
      region,
      bucket,
      objectKey,
      resolveEndpoint(input, context),
      isForcePathStyle(context),
      allowsPrivateNetwork(context),
    ),
    etag: headers.etag ?? null,
  };
}

async function awsDeleteObject(input: Record<string, unknown>, context: AwsActionContext) {
  const bucket = resolveBucket(input, context);
  const objectKey = requireAwsField(input.objectKey, "objectKey");
  createAwsS3BaseUrl(
    resolveRegion(input, context),
    bucket,
    resolveEndpoint(input, context),
    isForcePathStyle(context),
    allowsPrivateNetwork(context),
  );
  assertAllowedBucket(bucket, context);
  assertAllowedObjectKey(objectKey, context);
  await awsS3Request(createClientForAction(input, context), {
    method: "DELETE",
    bucket,
    objectKey,
    query: compactObject({
      versionId: optionalString(input.versionId),
    }),
    signal: context.signal,
  });

  return {
    bucket,
    objectKey,
    deleted: true,
  };
}

async function awsGeneratePresignedUrl(input: Record<string, unknown>, context: AwsActionContext) {
  const bucket = resolveBucket(input, context);
  const objectKey = requireAwsField(input.objectKey, "objectKey");
  createAwsS3BaseUrl(
    resolveRegion(input, context),
    bucket,
    resolveEndpoint(input, context),
    isForcePathStyle(context),
    allowsPrivateNetwork(context),
  );
  assertAllowedBucket(bucket, context);
  assertAllowedObjectKey(objectKey, context);
  const method = normalizePresignedMethod(input.method);
  const expiresSeconds = normalizeExpiresSeconds(input.expiresSeconds);
  const client = createClientForAction(input, context);

  return {
    bucket,
    objectKey,
    method,
    expiresSeconds,
    url: awsPresignUrl(client, {
      bucket,
      objectKey,
      method,
      expiresSeconds,
      headers: compactObject({
        "content-type": optionalString(input.contentType),
      }),
    }),
  };
}

function createAwsS3Client(input: AwsS3ClientConfig) {
  return input;
}

function normalizeAwsS3ProxyMethod(method: string): "GET" | "PUT" | "HEAD" | "DELETE" {
  if (method === "GET" || method === "PUT" || method === "HEAD" || method === "DELETE") {
    return method;
  }
  throw new ProviderRequestError(400, "aws_s3 proxy only supports GET, PUT, HEAD, and DELETE requests.");
}

function buildAwsS3ProxyBaseUrl(region: string, bucket: string | undefined, endpoint?: string): string {
  return createAwsS3BaseUrl(region, bucket, endpoint).origin;
}

function normalizeAwsS3ProxyBody(body: unknown): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  return typeof body === "string" ? body : JSON.stringify(body);
}

async function validateBucketCredential(client: AwsS3ClientConfig, bucket: string, signal?: AbortSignal) {
  try {
    await awsS3Request(client, {
      method: "HEAD",
      bucket,
      signal,
    });
    return { validated: true };
  } catch (error) {
    if (error instanceof AwsS3HttpError && error.status >= 500) {
      return { validated: false };
    }
    if (!(error instanceof AwsS3HttpError)) {
      return { validated: false };
    }
    throw error;
  }
}

function createClientForAction(input: Record<string, unknown>, context: AwsActionContext) {
  const values = context.values ?? {};
  return createAwsS3Client({
    accessKeyId: requireAwsField(values.accessKeyId, "accessKeyId"),
    secretAccessKey: requireAwsField(values.secretAccessKey, "secretAccessKey"),
    sessionToken: optionalString(values.sessionToken)?.trim(),
    region: resolveRegion(input, context),
    endpoint: resolveEndpoint(input, context),
    forcePathStyle:
      context.values.forcePathStyle === "true" ||
      context.metadata.forcePathStyle === true ||
      context.metadata.forcePathStyle === "true",
    allowPrivateNetwork: context.values.allowPrivateNetwork === "true",
    fetcher: context.fetcher,
  });
}

async function awsS3Request(client: AwsS3ClientConfig, input: AwsS3RequestInput) {
  const method = input.method ?? "GET";
  const target = buildRequestTarget({
    region: client.region,
    endpoint: client.endpoint,
    bucket: input.bucket,
    objectKey: input.objectKey,
    query: input.query,
    forcePathStyle: client.forcePathStyle,
    allowPrivateNetwork: client.allowPrivateNetwork,
  });
  const body = normalizeRequestBody(input.body);
  const payloadHash =
    method === "PUT" ? sha256Hex(body ?? Buffer.alloc(0)) : body == null ? "UNSIGNED-PAYLOAD" : sha256Hex(body);
  const signedRequest = signAwsRequest(client, {
    method,
    url: target.url,
    headers: compactObject({
      ...input.headers,
      host: target.url.host,
      "x-amz-content-sha256": payloadHash,
    }),
    payloadHash,
  });
  const response = await client.fetcher(target.url.toString(), {
    method,
    headers: signedRequest.headers,
    ...(body == null ? {} : { body }),
    signal: input.signal,
  });

  if (!response.ok) {
    throw await createAwsS3HttpError(response);
  }

  return response;
}

function awsPresignUrl(
  client: AwsS3ClientConfig,
  input: {
    bucket: string;
    objectKey: string;
    method: "GET" | "PUT" | "DELETE";
    expiresSeconds: number;
    headers?: Record<string, string | undefined>;
  },
) {
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${client.region}/${awsServiceName}/aws4_request`;
  const target = buildRequestTarget({
    region: client.region,
    bucket: input.bucket,
    objectKey: input.objectKey,
    endpoint: client.endpoint,
    forcePathStyle: client.forcePathStyle,
    allowPrivateNetwork: client.allowPrivateNetwork,
  });
  const headers = new Headers();
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (!value) {
      continue;
    }
    headers.set(key, value);
  }
  headers.set("host", target.url.host);
  const canonicalHeaders = buildCanonicalHeaders(headers);
  const signedHeaders = Object.keys(canonicalHeaders).join(";");
  const query = new URLSearchParams();
  query.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  query.set("X-Amz-Credential", `${client.accessKeyId}/${credentialScope}`);
  query.set("X-Amz-Date", amzDate);
  query.set("X-Amz-Expires", String(input.expiresSeconds));
  query.set("X-Amz-SignedHeaders", signedHeaders);
  if (client.sessionToken) {
    query.set("X-Amz-Security-Token", client.sessionToken);
  }
  target.url.search = canonicalizeSearchParams(query);
  const canonicalRequest = [
    input.method,
    target.url.pathname,
    target.url.search.slice(1),
    formatCanonicalHeaders(canonicalHeaders),
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmacHex(
    getSigningKey(client.secretAccessKey, dateStamp, client.region, awsServiceName),
    stringToSign,
  );
  target.url.searchParams.set("X-Amz-Signature", signature);
  return target.url.toString();
}

function signAwsRequest(
  client: AwsS3ClientConfig,
  input: {
    method: "GET" | "PUT" | "HEAD" | "DELETE";
    url: URL;
    headers: Record<string, string>;
    payloadHash: string;
  },
) {
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${client.region}/${awsServiceName}/aws4_request`;
  const headers = new Headers(input.headers);
  headers.set("x-amz-date", amzDate);
  if (client.sessionToken) {
    headers.set("x-amz-security-token", client.sessionToken);
  }
  const canonicalHeaders = buildCanonicalHeaders(headers);
  const signedHeaders = Object.keys(canonicalHeaders).join(";");
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    input.url.search.slice(1),
    formatCanonicalHeaders(canonicalHeaders),
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${client.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${hmacHex(getSigningKey(client.secretAccessKey, dateStamp, client.region, awsServiceName), stringToSign)}`,
  ].join(", ");
  headers.set("authorization", authorization);
  return {
    headers,
  };
}

function buildRequestTarget(input: {
  region: string;
  endpoint?: string;
  bucket?: string;
  objectKey?: string;
  query?: Record<string, string | number | boolean | undefined>;
  forcePathStyle?: boolean;
  allowPrivateNetwork?: boolean;
}) {
  const url = createAwsS3BaseUrl(
    input.region,
    input.bucket,
    input.endpoint,
    input.forcePathStyle,
    input.allowPrivateNetwork,
  );
  const bucketPath = input.forcePathStyle && input.bucket ? `/${encodeURIComponent(input.bucket)}` : "";
  url.pathname = input.objectKey ? `${bucketPath}/${encodeS3Key(input.objectKey)}` : bucketPath || "/";
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value == null) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  url.search = canonicalizeSearchParams(url.searchParams);
  return {
    url,
  };
}

function createAwsS3BaseUrl(
  region: string,
  bucket: string | undefined,
  endpoint?: string,
  forcePathStyle = false,
  allowPrivateNetwork = false,
): URL {
  if (!/^[a-z0-9][a-z0-9.-]*$/iu.test(region) || (bucket !== undefined && !/^[a-z0-9][a-z0-9.-]*$/iu.test(bucket))) {
    throw new ProviderRequestError(400, "bucket and region must form a valid AWS S3 endpoint");
  }
  const base = endpoint
    ? parseS3Endpoint(endpoint, allowPrivateNetwork)
    : new URL(`https://s3.${region}.amazonaws.com`);
  const expectedHost = bucket && !forcePathStyle ? `${bucket}.${base.host}` : base.host;
  let url: URL;
  try {
    url = new URL(`https://${expectedHost}`);
  } catch {
    throw new ProviderRequestError(400, "bucket and region must form a valid AWS S3 endpoint");
  }
  if (
    url.host !== expectedHost.toLowerCase() ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new ProviderRequestError(400, "bucket and region must form a valid AWS S3 endpoint");
  }
  return url;
}

function buildObjectUrl(
  region: string,
  bucket: string,
  objectKey: string,
  endpoint?: string,
  forcePathStyle = false,
  allowPrivateNetwork = false,
) {
  return buildRequestTarget({
    region,
    bucket,
    objectKey,
    endpoint,
    forcePathStyle,
    allowPrivateNetwork,
  }).url.toString();
}

function buildBucketResourceUrl(
  region: string,
  bucket: string,
  endpoint?: string,
  forcePathStyle = false,
  allowPrivateNetwork = false,
): string {
  return buildRequestTarget({ region, bucket, endpoint, forcePathStyle, allowPrivateNetwork }).url.toString();
}

function buildCanonicalHeaders(headers: Headers) {
  const entries = Array.from(headers.entries()).map(([key, value]) => ({
    key: key.toLowerCase(),
    value: collapseHeaderWhitespace(value),
  }));
  entries.sort((left, right) => left.key.localeCompare(right.key));
  return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
}

function formatCanonicalHeaders(headers: Record<string, string>) {
  return `${Object.entries(headers)
    .map(([key, value]) => `${key}:${value}`)
    .join("\n")}\n`;
}

function canonicalizeSearchParams(searchParams: URLSearchParams) {
  const entries = Array.from(searchParams.entries()).map(([key, value]) => ({
    key: encodeRfc3986(key),
    value: encodeRfc3986(value),
  }));
  entries.sort((left, right) => {
    if (left.key === right.key) {
      return left.value.localeCompare(right.value);
    }
    return left.key.localeCompare(right.key);
  });
  return entries.map((entry) => `${entry.key}=${entry.value}`).join("&");
}

function encodeS3Key(value: string) {
  return value
    .split("/")
    .map((segment) => encodeRfc3986(segment))
    .join("/");
}

function readObjectKey(input: Record<string, unknown>): string {
  const objectKey = requiredRawString(
    input.objectKey,
    "objectKey",
    (message) => new ProviderRequestError(400, message),
  );
  if (objectKey.length === 0) {
    throw new ProviderRequestError(400, "objectKey must not be empty");
  }
  if (hasUnsafeControlCharacter(objectKey)) {
    throw new ProviderRequestError(400, "objectKey contains an unsafe control character");
  }
  if (objectKey.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new ProviderRequestError(400, "objectKey must not contain . or .. path segments");
  }
  return objectKey;
}

function defaultObjectFileName(objectKey: string): string {
  return objectKey.split("/").findLast((segment) => segment.length > 0) ?? "s3-object";
}

function encodeRfc3986(value: string) {
  return encodeURIComponent(value)
    .replaceAll("!", "%21")
    .replaceAll("'", "%27")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("*", "%2A");
}

function normalizeRequestBody(value: AwsS3RequestInput["body"]) {
  if (value == null) {
    return undefined;
  }
  return typeof value === "string" ? new Uint8Array(Buffer.from(value, "utf8")) : new Uint8Array(value);
}

async function createAwsS3HttpError(response: Response) {
  const text = await readBoundedResponseText(response, "AWS S3 error response");
  const parsedError = parseAwsErrorXml(text);
  return new AwsS3HttpError({
    status: response.status,
    code: parsedError.code,
    message: buildAwsErrorMessage(parsedError.code, parsedError.message, response.statusText),
  });
}

function parseListBucketsXml(xml: string) {
  const document = parseXmlDocument(xml);
  const root = document;
  const ownerElement = getFirstChild(root, "Owner");
  const bucketsElement = getFirstChild(root, "Buckets");
  const nextMarker = readElementText(root, "ContinuationToken");
  return {
    owner: ownerElement ? normalizeOwner(ownerElement) : null,
    buckets: getChildren(bucketsElement, "Bucket").map((bucketElement) => ({
      name: readElementText(bucketElement, "Name") ?? "",
      region: readElementText(bucketElement, "BucketRegion"),
      creationDate: readElementText(bucketElement, "CreationDate") ?? "",
      storageClass: null,
    })),
    nextMarker,
  };
}

function parseListObjectsXml(xml: string, input: { bucket: string; region: string }) {
  const root = parseXmlDocument(xml);
  return {
    objects: getChildren(root, "Contents").map((contentElement) =>
      normalizeObject(contentElement, input.bucket, input.region),
    ),
    prefixes: getChildren(root, "CommonPrefixes")
      .map((prefixElement) => decodeS3XmlValue(readElementText(prefixElement, "Prefix")))
      .filter((prefix): prefix is string => prefix != null),
    isTruncated: readElementText(root, "IsTruncated") === "true",
    keyCount: Number(readElementText(root, "KeyCount") ?? 0),
    continuationToken: decodeS3XmlValue(readElementText(root, "ContinuationToken")) ?? null,
    nextContinuationToken: decodeS3XmlValue(readElementText(root, "NextContinuationToken")) ?? null,
  };
}

function parseAwsErrorXml(xml: string) {
  if (!xml.trim().startsWith("<")) {
    return {
      code: null,
      message: xml.trim() || null,
    };
  }

  try {
    const root = parseXmlDocument(xml);
    return {
      code: readElementText(root, "Code"),
      message: readElementText(root, "Message"),
    };
  } catch {
    return {
      code: null,
      message: xml.trim() || null,
    };
  }
}

function parseXmlDocument(xml: string) {
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let cursor = 0;

  while (cursor < xml.length) {
    const tagStart = xml.indexOf("<", cursor);
    if (tagStart === -1) {
      appendXmlText(stack, xml.slice(cursor));
      break;
    }
    appendXmlText(stack, xml.slice(cursor, tagStart));
    const tagEnd = xml.indexOf(">", tagStart + 1);
    if (tagEnd === -1) {
      throw new ProviderRequestError(502, "failed to parse aws s3 xml response");
    }
    const rawTag = xml.slice(tagStart + 1, tagEnd).trim();
    cursor = tagEnd + 1;

    if (!rawTag || rawTag.startsWith("?") || rawTag.startsWith("!")) {
      continue;
    }

    if (rawTag.startsWith("/")) {
      const closingName = normalizeXmlTagName(rawTag.slice(1));
      const current = stack.pop();
      if (!current || current.name !== closingName) {
        throw new ProviderRequestError(502, "failed to parse aws s3 xml response");
      }
      if (stack.length === 0) {
        root = current;
      } else {
        stack[stack.length - 1]!.children.push(current);
      }
      continue;
    }

    const selfClosing = rawTag.endsWith("/");
    const tagContent = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
    const spaceIndex = tagContent.indexOf(" ");
    const tagName = normalizeXmlTagName(spaceIndex === -1 ? tagContent : tagContent.slice(0, spaceIndex));
    const node: XmlNode = {
      name: tagName,
      children: [],
      text: "",
    };

    if (selfClosing) {
      if (stack.length === 0) {
        root = node;
      } else {
        stack[stack.length - 1]!.children.push(node);
      }
      continue;
    }

    stack.push(node);
  }

  if (!root && stack.length === 1) {
    root = stack.pop() ?? null;
  }

  if (!root) {
    throw new ProviderRequestError(502, "failed to parse aws s3 xml response");
  }

  return root;
}

function appendXmlText(stack: XmlNode[], value: string) {
  const current = stack[stack.length - 1];
  if (!current) {
    return;
  }
  current.text += decodeXmlEntities(value);
}

function normalizeXmlTagName(value: string) {
  const trimmed = value.trim();
  const colonIndex = trimmed.indexOf(":");
  return colonIndex === -1 ? trimmed : trimmed.slice(colonIndex + 1);
}

function decodeXmlEntities(value: string) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function getChildren(parent: XmlNode | null | undefined, localName: string) {
  if (!parent) {
    return [];
  }
  return parent.children.filter((child) => child.name === localName);
}

function getFirstChild(parent: XmlNode | null | undefined, localName: string) {
  return getChildren(parent, localName)[0] ?? null;
}

function readElementText(parent: XmlNode | null | undefined, localName: string) {
  const child = getFirstChild(parent, localName);
  return child?.text.trim() || null;
}

function normalizeOwner(ownerElement: XmlNode | null | undefined) {
  const id = readElementText(ownerElement, "ID") ?? "";
  const displayName = readElementText(ownerElement, "DisplayName");
  if (!id && !displayName) {
    return null;
  }
  return {
    id,
    displayName,
  };
}

function normalizeObject(contentElement: XmlNode, bucket: string, region: string): AwsObjectSummary {
  const objectKey = decodeS3XmlValue(readElementText(contentElement, "Key")) ?? "";
  return {
    name: objectKey,
    url: buildObjectUrl(region, bucket, objectKey),
    lastModified: readElementText(contentElement, "LastModified") ?? "",
    etag: readElementText(contentElement, "ETag") ?? "",
    type: "object",
    size: Number(readElementText(contentElement, "Size") ?? 0),
    storageClass: readElementText(contentElement, "StorageClass"),
    owner: normalizeOwner(getFirstChild(contentElement, "Owner")),
  };
}

function decodeS3XmlValue(value: string | null) {
  if (value == null) {
    return null;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeHeaderRecord(headers: Headers) {
  return Object.fromEntries(Array.from(headers.entries()).map(([key, value]) => [key.toLowerCase(), value]));
}

function extractAwsMetadata(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([key, value]) => {
      if (!key.startsWith("x-amz-meta-")) {
        return [];
      }
      return [[key.slice("x-amz-meta-".length), value]];
    }),
  );
}

function buildAwsMetadataHeaders(input: Record<string, unknown> | undefined) {
  return Object.fromEntries(
    Object.entries(input ?? {}).flatMap(([key, value]) => {
      const resolved = optionalString(value);
      if (!resolved) {
        return [];
      }
      return [[`x-amz-meta-${key}`, resolved]];
    }),
  );
}

async function downloadSourceFile(sourceUrl: string, signal?: AbortSignal) {
  const validatedUrl = validateSourceUrl(sourceUrl);
  const timeout = createProviderTimeout(signal, sourceFetchTimeoutMs);

  try {
    const response = await providerFetch(validatedUrl, {
      signal: timeout.signal,
    });
    const contentLength = parseHeaderInteger(response.headers.get("content-length"));
    if (contentLength != null && contentLength > maxSourceBytes) {
      throw new ProviderRequestError(400, "sourceUrl payload is too large");
    }
    if (!response.ok) {
      throw new ProviderRequestError(
        response.status >= 500 ? 502 : response.status,
        `failed to download sourceUrl: ${response.status} ${response.statusText}`.trim(),
      );
    }

    const bytes = await readResponseBytesWithLimit(response, maxSourceBytes, timeout.signal);

    return {
      bytes,
      contentType: response.headers.get("content-type") ?? undefined,
    };
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      throw error;
    }
    if (timeout.didTimeout()) {
      throw new ProviderRequestError(504, "sourceUrl download timed out");
    }
    throw error;
  } finally {
    timeout.cleanup();
  }
}

async function readBoundedResponseText(response: Response, fieldName: string, signal?: AbortSignal): Promise<string> {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: 2 * 1024 * 1024,
    fieldName,
    signal,
    createError: (message) => new ProviderRequestError(413, message),
  });
  return new TextDecoder().decode(bytes);
}

function validateSourceUrl(value: string): URL {
  try {
    return assertPublicHttpUrl(value, {
      fieldName: "sourceUrl",
      createError: (message) => new ProviderRequestError(400, message),
    });
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      throw error;
    }
    throw new ProviderRequestError(400, "sourceUrl must be a valid URL");
  }
}

async function readResponseBytesWithLimit(response: Response, limit: number, signal?: AbortSignal) {
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: limit,
    fieldName: "sourceUrl payload",
    signal,
    createError: (message) => new ProviderRequestError(400, message),
  });
  return Buffer.from(bytes);
}

function resolveRegion(input: Record<string, unknown>, context: AwsActionContext) {
  const inputRegion = optionalString(input.region)?.trim();
  if (inputRegion) {
    return inputRegion;
  }

  const metadataRegion = optionalString(context.metadata?.region)?.trim();
  if (metadataRegion) {
    return metadataRegion;
  }

  const valueRegion = optionalString(context.values?.region)?.trim();
  if (valueRegion) {
    return valueRegion;
  }

  throw new ProviderRequestError(400, "region is required for aws_s3 action execution");
}

function resolveEndpoint(input: Record<string, unknown>, context: AwsActionContext): string | undefined {
  const configured = optionalString(context.metadata.endpoint) ?? optionalString(context.values.endpoint);
  const requested = optionalString(input.endpoint);
  if (requested && configured && normalizeEndpointOrigin(requested) !== normalizeEndpointOrigin(configured)) {
    throw new ProviderRequestError(403, "endpoint is outside the connection allowlist");
  }
  return requested ?? configured;
}

function isForcePathStyle(context: AwsActionContext): boolean {
  return context.values.forcePathStyle === "true" || context.metadata.forcePathStyle === true;
}

function allowsPrivateNetwork(context: AwsActionContext): boolean {
  return context.values.allowPrivateNetwork === "true";
}

function assertAllowedBucket(bucket: string, context: AwsActionContext): void {
  const allowed = optionalString(context.metadata.bucket) ?? optionalString(context.values.bucket);
  if (allowed && bucket !== allowed) {
    throw new ProviderRequestError(403, "bucket is outside the AWS S3 connection allowlist");
  }
}

function assertAllowedPrefix(prefix: string, context: AwsActionContext): string {
  const allowed = optionalString(context.metadata.prefix) ?? optionalString(context.values.prefix) ?? "";
  if (allowed && !prefix.startsWith(allowed)) {
    throw new ProviderRequestError(403, "prefix is outside the AWS S3 connection allowlist");
  }
  return prefix;
}

function assertAllowedObjectKey(objectKey: string, context: AwsActionContext): void {
  const prefix = optionalString(context.metadata.prefix) ?? optionalString(context.values.prefix) ?? "";
  if (prefix && !objectKey.startsWith(prefix)) {
    throw new ProviderRequestError(403, "objectKey is outside the AWS S3 connection allowlist");
  }
}

function parseS3Endpoint(value: string, allowPrivateNetwork = false): URL {
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw new ProviderRequestError(400, "endpoint must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new ProviderRequestError(400, "endpoint must be an HTTPS origin without credentials or a path");
  }
  assertPublicHttpUrl(url.toString(), {
    fieldName: "endpoint",
    createError: (message) => new ProviderRequestError(400, message),
    allowPrivateNetwork: allowPrivateNetwork && isPrivateNetworkAccessAllowed(),
  });
  return url;
}

function normalizeEndpointOrigin(value: string): string {
  return new URL(value.includes("://") ? value : `https://${value}`).origin;
}

function resolveBucket(input: Record<string, unknown>, context: AwsActionContext) {
  const inputBucket = optionalString(input.bucket)?.trim();
  if (inputBucket) {
    return inputBucket;
  }

  const metadataBucket = optionalString(context.metadata?.bucket)?.trim();
  if (metadataBucket) {
    return metadataBucket;
  }

  const valueBucket = optionalString(context.values?.bucket)?.trim();
  if (valueBucket) {
    return valueBucket;
  }

  throw new ProviderRequestError(400, "bucket is required");
}

function requireAwsField(value: unknown, name: string) {
  const resolved = optionalString(value)?.trim();
  if (!resolved) {
    throw new ProviderRequestError(400, `${name} is required`);
  }
  return resolved;
}

function normalizeAwsError(error: unknown, phase: "validate" | "execute") {
  if (error instanceof ProviderRequestError) {
    return error;
  }
  if (error instanceof AwsS3HttpError) {
    if (phase === "validate" && (error.status === 400 || error.status === 401 || error.status === 403)) {
      return new ProviderRequestError(400, error.message);
    }
    if (error.status === 429) {
      return new ProviderRequestError(429, error.message);
    }
    return new ProviderRequestError(error.status, error.message);
  }
  if (error instanceof Error && error.message.trim()) {
    return new ProviderRequestError(500, error.message);
  }
  return new ProviderRequestError(500, "aws s3 request failed");
}

function buildAwsErrorMessage(code: string | null, message: string | null, fallback: string) {
  if (code && message) {
    return `${code}: ${message}`;
  }
  if (message) {
    return message;
  }
  if (code) {
    return code;
  }
  return fallback || "aws s3 request failed";
}

function normalizePresignedMethod(value: unknown): "GET" | "PUT" | "DELETE" {
  return value === "PUT" || value === "DELETE" ? value : "GET";
}

function normalizeExpiresSeconds(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 3600;
  }
  return parsed;
}

function asOptionalPositiveInteger(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function parseHeaderInteger(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function collapseHeaderWhitespace(value: string) {
  return value.trim().split(" ").filter(Boolean).join(" ");
}

function formatAmzDate(value: Date) {
  const year = String(value.getUTCFullYear()).padStart(4, "0");
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  const hours = String(value.getUTCHours()).padStart(2, "0");
  const minutes = String(value.getUTCMinutes()).padStart(2, "0");
  const seconds = String(value.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

function sha256Hex(value: string | Uint8Array | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function getSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}
