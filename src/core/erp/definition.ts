import type { ProviderDefinition } from "../types.ts";
import type { CredentialDefinition } from "../types.ts";
import type { ErpRestVendor } from "./vendor-runtime.ts";

import { defineErpReadActions } from "./actions.ts";

export function defineErpVendor(vendor: ErpRestVendor, homepageUrl: string): ProviderDefinition {
  return {
    service: vendor.service,
    displayName: vendor.displayName,
    description: `Read-only ${vendor.displayName} connection using the vendor's official ${vendor.apiVersion} API with explicit ERP domain mappings and bounded reads.`,
    categories: ["Finance", "Productivity"],
    authTypes: ["custom_credential"],
    auth: [
      {
        type: "custom_credential",
        fields: credentialFields(vendor),
      },
    ],
    homepageUrl,
    actions: defineErpReadActions(vendor.service, vendor.entities),
  };
}

function credentialFields(vendor: ErpRestVendor): CredentialDefinition[] {
  const fields: CredentialDefinition[] = [
    {
      key: "baseUrl",
      label: "Official API base URL",
      inputType: "text" as const,
      required: true,
      secret: false,
      description: "Tenant-defined only for supported cloud or private deployments; URL and DNS egress are guarded.",
    },
    {
      key: "accountId",
      label: "Account / tenant identifier",
      inputType: "text" as const,
      required: false,
      secret: false,
    },
    {
      key: "companyId",
      label: "Default company / legal entity ID",
      inputType: "text",
      required: false,
      secret: false,
      description: "Required by providers whose entity endpoints are company-scoped, such as Business Central.",
    },
  ];
  if (vendor.authStyle === "kingdee") {
    fields[1]!.required = true;
    fields.push(
      { key: "appId", label: "Kingdee application ID", inputType: "text", required: true, secret: false },
      { key: "appSecret", label: "Kingdee application secret", inputType: "password", required: true, secret: true },
      { key: "username", label: "Kingdee API user", inputType: "text", required: true, secret: false },
      {
        key: "localeId",
        label: "Kingdee locale ID",
        inputType: "text",
        required: false,
        secret: false,
        placeholder: "2052",
      },
    );
  } else if (vendor.authStyle === "basic") {
    fields.push(
      { key: "username", label: "Username", inputType: "text", required: true, secret: false },
      { key: "password", label: "Password", inputType: "password", required: true, secret: true },
    );
  } else if (vendor.authStyle === "api-key-header") {
    fields.push(
      {
        key: "apiKeyHeader",
        label: "Official API key header",
        inputType: "text",
        required: true,
        secret: false,
      },
      { key: "apiKey", label: "API key", inputType: "password", required: true, secret: true },
    );
  } else {
    fields.push({
      key: "accessToken",
      label: "Access token / API key",
      inputType: "password",
      required: true,
      secret: true,
      description: "A server-side token provisioned for read-only official API access.",
    });
  }
  if (vendor.authStyle === "odoo-json2") {
    fields.push({ key: "database", label: "Odoo database", inputType: "text", required: true, secret: false });
  }
  if (vendor.privateRunner) {
    fields.push({
      key: "privateRunner",
      label: "Use controlled private runner",
      inputType: "text",
      required: false,
      secret: false,
      placeholder: "true",
      description:
        "Set to true only on a dedicated runner with CONNECTION_ERP_PRIVATE_RUNNER, OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK, and CONNECTION_ERP_EGRESS_ALLOWLIST.",
    });
  }
  return fields;
}
