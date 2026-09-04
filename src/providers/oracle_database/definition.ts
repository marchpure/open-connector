import type { ProviderDefinition } from "../../core/types.ts";

import { databaseActions } from "../database-actions.ts";
import { databaseCredentialFields } from "../database-runtime.ts";

const service = "oracle_database";

export const nodeOnly = true;

export const provider: ProviderDefinition = {
  service,
  displayName: "Oracle Database",
  description: "Validate, discover, and run read-only SQL queries against Oracle Database.",
  categories: ["Data"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: databaseCredentialFields(1521),
      testAction: { actionName: "discover_schema", input: { limit: 1 } },
    },
  ],
  homepageUrl: "https://www.oracle.com/database/",
  actions: databaseActions(service, "Oracle Database"),
};
