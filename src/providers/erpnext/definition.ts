import type { ProviderDefinition } from "../../core/types.ts";

import { erpnextActions } from "./actions.ts";

const service = "erpnext";

export const provider: ProviderDefinition = {
  service,
  displayName: "ERPNext",
  description:
    "ERPNext through the official Frappe REST API. Agent leases expose explicit bounded read-only ERP domain mappings; legacy generic CRUD remains outside Agent leases.",
  categories: ["Productivity", "Finance"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "API Key",
      placeholder: "api_key",
      description:
        "ERPNext API key used with token authentication. Generate it from the user record's API Access section as described in the Frappe REST API docs: https://docs.frappe.io/framework/user/en/api/rest",
      extraFields: [
        {
          key: "baseUrl",
          label: "Base URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "https://demo.erpnext.com",
          description: "Base URL of your ERPNext or Frappe instance.",
        },
        {
          key: "apiSecret",
          label: "API Secret",
          inputType: "password",
          required: true,
          secret: true,
          placeholder: "api_secret",
          description:
            "ERPNext API secret paired with the API key for token authentication. Frappe shows it in the Generate Keys popup in the user record's API Access section: https://docs.frappe.io/framework/user/en/api/rest",
        },
        {
          key: "privateRunner",
          label: "Use controlled private runner",
          inputType: "text",
          required: false,
          secret: false,
          placeholder: "true",
          description:
            "Required for private instances together with CONNECTION_ERP_PRIVATE_RUNNER, OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK, and CONNECTION_ERP_EGRESS_ALLOWLIST.",
        },
        {
          key: "companyId",
          label: "Default company",
          inputType: "text",
          required: false,
          secret: false,
          description: "Optional ERPNext company name used as the fixed legal-entity boundary for Agent reads.",
        },
      ],
    },
  ],
  homepageUrl: "https://erpnext.com",
  actions: erpnextActions,
};
