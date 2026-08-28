import type { ProviderDefinition } from "../../core/types.ts";

import { volcengineTosActions } from "./actions.ts";

const service = "volcengine_tos";

export const provider: ProviderDefinition = {
  service,
  displayName: "Volcengine TOS",
  description:
    "Read-only, allowlisted access to Volcengine TOS buckets and objects through the official TOS Signature V4 protocol.",
  categories: ["Storage", "Developer Tools"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "accessKeyId",
          label: "Access Key ID",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "AKLT...",
          description: "Volcengine access key ID from IAM.",
        },
        {
          key: "secretAccessKey",
          label: "Secret Access Key",
          inputType: "password",
          required: true,
          secret: true,
          placeholder: "Your Volcengine secret access key",
          description: "Volcengine secret access key from IAM.",
        },
        {
          key: "region",
          label: "Region",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "cn-beijing",
          description: "The TOS region containing the allowlisted bucket.",
        },
        {
          key: "endpoint",
          label: "TOS Endpoint",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "tos-cn-beijing.volces.com",
          description: "The HTTPS TOS endpoint for the selected region.",
        },
        {
          key: "bucket",
          label: "Allowlisted Bucket",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "knowledge-bucket",
          description: "Only this bucket may be discovered or read through the connection.",
        },
        {
          key: "prefix",
          label: "Allowlisted Prefix",
          inputType: "text",
          required: false,
          secret: false,
          placeholder: "documents/",
          description: "Optional object-key prefix allowlist. Leave empty to allow the whole bucket.",
        },
        {
          key: "sessionToken",
          label: "Session Token",
          inputType: "password",
          required: false,
          secret: true,
          placeholder: "Optional STS session token",
          description: "Optional temporary-credential security token.",
        },
      ],
    },
  ],
  homepageUrl: "https://www.volcengine.com/product/tos",
  actions: volcengineTosActions,
};
