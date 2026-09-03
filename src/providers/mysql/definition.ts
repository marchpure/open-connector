import type { ProviderDefinition } from "../../core/types.ts";

import { databaseActions } from "../database-actions.ts";
import { databaseCredentialFields } from "../database-runtime.ts";

const service = "mysql";

export const nodeOnly = true;

export const provider: ProviderDefinition = {
  service,
  displayName: "MySQL",
  description: "Validate, discover, and run read-only SQL queries against MySQL databases.",
  categories: ["Data"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: databaseCredentialFields(3306),
      testAction: { actionName: "discover_schema", input: { limit: 1 } },
    },
  ],
  homepageUrl: "https://www.mysql.com",
  actions: databaseActions(service, "MySQL"),
};
