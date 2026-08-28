import type { ActionDefinition, ProviderDefinition } from "../core/types.ts";

import { awsActions } from "./aws_s3/actions.ts";

export interface S3CompatibleProfile {
  service: "tencent_cos" | "huawei_obs" | "minio" | "qiniu_kodo";
  displayName: string;
  description: string;
  homepageUrl: string;
  endpointPlaceholder: string;
  endpointDescription: string;
  regionPlaceholder: string;
  forcePathStyle?: boolean;
  supportsSessionToken?: boolean;
}

export function s3CompatibleActions(profile: S3CompatibleProfile): ActionDefinition[] {
  return awsActions
    .filter((action) => ["list_buckets", "list_objects", "head_object", "download_object"].includes(action.name))
    .map((action) => ({
      ...action,
      id: `${profile.service}.${action.name}`,
      service: profile.service,
      description: action.description.replace(/Amazon S3|AWS S3|S3/gu, profile.displayName),
      resourceBindings:
        action.name === "list_buckets"
          ? undefined
          : remapBindings(action.resourceBindings ?? action.resourceBindingsOptional, profile),
      resourceBindingsOptional: undefined,
    }));
}

export function s3CompatibleDefinition(profile: S3CompatibleProfile): ProviderDefinition {
  return {
    service: profile.service,
    displayName: profile.displayName,
    description: profile.description,
    categories: ["Storage", "Developer Tools"],
    authTypes: ["custom_credential"],
    auth: [
      {
        type: "custom_credential",
        fields: [
          field("accessKeyId", "Access Key ID", "text", true, false, "Provider-issued access key ID."),
          field("secretAccessKey", "Secret Access Key", "password", true, true, "Matching provider secret key."),
          ...(profile.supportsSessionToken === false
            ? []
            : [
                field(
                  "sessionToken",
                  "Temporary Security Token",
                  "password",
                  false,
                  true,
                  "Optional temporary credential token.",
                ),
              ]),
          field("region", "Region", "text", true, false, "Provider region.", profile.regionPlaceholder),
          field("endpoint", "Endpoint", "text", true, false, profile.endpointDescription, profile.endpointPlaceholder),
          ...(profile.service === "qiniu_kodo"
            ? [
                field(
                  "downloadDomain",
                  "Bucket Download Domain",
                  "text",
                  true,
                  false,
                  "HTTPS origin bound to this Qiniu bucket. Signed download tokens remain server-side.",
                  "https://downloads.example.com",
                ),
              ]
            : []),
          field("bucket", "Allowlisted Bucket", "text", true, false, "Only this bucket may be discovered or read."),
          field(
            "prefix",
            "Allowlisted Prefix",
            "text",
            false,
            false,
            "Optional object-key prefix enforced for listing, metadata, and downloads.",
          ),
          ...(profile.service === "minio"
            ? [
                field(
                  "allowPrivateNetwork",
                  "Private Network Deployment",
                  "text",
                  false,
                  false,
                  "Set to true only when the host also enables OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK.",
                  "true",
                ),
                field(
                  "caCertificate",
                  "Custom CA Certificate",
                  "textarea",
                  false,
                  false,
                  "Optional PEM-encoded CA certificate used only for this MinIO TLS connection.",
                ),
              ]
            : []),
        ],
      },
    ],
    homepageUrl: profile.homepageUrl,
    actions: s3CompatibleActions(profile),
  };
}

function field(
  key: string,
  label: string,
  inputType: "text" | "password" | "textarea",
  required: boolean,
  secret: boolean,
  description: string,
  placeholder?: string,
) {
  return { key, label, inputType, required, secret, description, placeholder };
}

function remapBindings(
  bindings: Record<string, string[]> | undefined,
  profile: S3CompatibleProfile,
): Record<string, string[]> | undefined {
  if (!bindings) return undefined;
  return Object.fromEntries(
    Object.entries(bindings).map(([fieldName, kinds]) => [
      fieldName,
      kinds.map((kind) =>
        kind === "application/vnd.aws.s3.bucket" ? `application/vnd.${profile.service.replace("_", ".")}.bucket` : kind,
      ),
    ]),
  );
}
