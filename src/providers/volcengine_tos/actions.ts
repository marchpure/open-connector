import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "volcengine_tos";
const bucket = s.nonEmptyString("The allowlisted TOS bucket.");
const objectKey = s.nonEmptyString("The TOS object key.");
const prefix = s.string("An object-key prefix within the connection allowlist.");

const owner = s.object("The TOS owner summary.", {
  id: s.string("The owner identifier."),
  displayName: s.nullableString("The owner display name."),
});

const object = s.object("A TOS object summary.", {
  name: s.string("The object key."),
  url: s.string("The canonical TOS object URL."),
  lastModified: s.string("The last-modified timestamp."),
  etag: s.string("The object ETag."),
  type: s.string("The object type."),
  size: s.nonNegativeInteger("The object size in bytes."),
  storageClass: s.nullableString("The TOS storage class."),
  owner: s.nullable(owner),
});

const downloadedObject = s.requiredObject("A bounded TOS object stored in transit storage.", {
  objectKey,
  name: s.nonEmptyString("The transit filename."),
  mimeType: s.nonEmptyString("The response MIME type."),
  sizeBytes: s.nonNegativeInteger("The downloaded size in bytes."),
  etag: s.nullableString("The response ETag."),
  versionId: s.nullableString("The TOS version identifier."),
  file: s.requiredObject("The transit file reference.", {
    fileId: s.nonEmptyString("The transit file identifier."),
    downloadUrl: s.url("The transit download URL."),
    sizeBytes: s.nonNegativeInteger("The transit file size."),
    name: s.nonEmptyString("The transit filename."),
    mimeType: s.nonEmptyString("The transit MIME type."),
  }),
});

const metadata = s.object("TOS object metadata.", {
  bucket,
  objectKey,
  etag: s.nullableString("The object ETag."),
  contentLength: s.nullable(s.integer("The object size in bytes.")),
  contentType: s.nullableString("The object MIME type."),
  lastModified: s.nullableString("The last-modified timestamp."),
  contentEncoding: s.nullableString("The content encoding."),
  storageClass: s.nullableString("The TOS storage class."),
  versionId: s.nullableString("The TOS version identifier."),
  metadata: s.record("User metadata.", s.string("A metadata value.")),
  headers: s.record("Safe response headers.", s.string("A header value.")),
});

export const volcengineTosActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "validate_connection",
    description: "Validate the TOS credentials and the configured bucket allowlist.",
    inputSchema: s.object("No input is required.", {}),
    outputSchema: s.requiredObject("The validated TOS connection.", {
      bucket,
      region: s.string("The configured TOS region."),
      endpoint: s.string("The normalized TOS endpoint."),
    }),
  }),
  defineProviderAction(service, {
    name: "list_buckets",
    description: "Return the single bucket explicitly allowlisted by this connection.",
    inputSchema: s.object("No input is required.", {}),
    outputSchema: s.requiredObject("The restricted bucket discovery result.", {
      buckets: s.array("The one validated allowlisted bucket.", s.looseObject("A TOS bucket summary.")),
      isTruncated: s.boolean("Whether more buckets are available; always false for an allowlisted connection."),
    }),
  }),
  defineProviderAction(service, {
    name: "list_objects",
    description: "List one bounded page of objects inside the configured bucket and prefix allowlist.",
    inputSchema: s.object(
      "The bounded TOS object listing input.",
      {
        bucket,
        prefix,
        delimiter: s.string("Optional key delimiter."),
        continuationToken: s.string("The continuation token from the previous page."),
        startAfter: s.string("Start after this key within the allowlist."),
        maxKeys: s.integer("Maximum objects in this page.", { minimum: 1, maximum: 1000 }),
      },
      { optional: ["bucket", "prefix", "delimiter", "continuationToken", "startAfter", "maxKeys"] },
    ),
    outputSchema: s.requiredObject("A bounded TOS object listing.", {
      objects: s.array("The objects in this page.", object),
      prefixes: s.array("Common prefixes.", s.string("A common prefix.")),
      isTruncated: s.boolean("Whether another page is available."),
      nextContinuationToken: s.nullableString("The continuation token for the next page."),
    }),
    resourceBindingsOptional: { bucket: ["application/vnd.volcengine.tos.bucket"] },
  }),
  defineProviderAction(service, {
    name: "head_object",
    description: "Read metadata for one allowlisted TOS object without reading its body.",
    inputSchema: s.object(
      "The TOS object metadata input.",
      {
        bucket,
        objectKey,
        versionId: s.string("An optional object version identifier."),
        ifMatch: s.string("Optional ETag precondition."),
      },
      { optional: ["bucket", "versionId", "ifMatch"] },
    ),
    outputSchema: s.requiredObject("The TOS object metadata.", { object: metadata }),
    resourceBindingsOptional: { bucket: ["application/vnd.volcengine.tos.bucket"] },
  }),
  defineProviderAction(service, {
    name: "download_object",
    description: "Stream one bounded allowlisted TOS object into transit storage.",
    inputSchema: s.object(
      "The bounded TOS download input.",
      {
        bucket,
        objectKey,
        versionId: s.string("An optional object version identifier."),
        ifMatch: s.string("Optional ETag precondition."),
        fileName: s.nonEmptyString("Optional transit filename."),
      },
      { optional: ["bucket", "versionId", "ifMatch", "fileName"] },
    ),
    outputSchema: downloadedObject,
    resourceBindingsOptional: { bucket: ["application/vnd.volcengine.tos.bucket"] },
  }),
];
