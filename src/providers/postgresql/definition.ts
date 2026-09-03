import type { ProviderDefinition } from "../../core/types.ts";

import { databaseActions } from "../database-actions.ts";
import { databaseCredentialFields } from "../database-runtime.ts";

const service = "postgresql";

export const nodeOnly = true;

export const provider: ProviderDefinition = {
  service,
  displayName: "PostgreSQL",
  description: "Validate, discover, and run read-only SQL queries against PostgreSQL databases.",
  categories: ["Data"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: databaseCredentialFields(5432),
      testAction: { actionName: "discover_schema", input: { limit: 1 } },
    },
  ],
  homepageUrl: "https://www.postgresql.org",
  actions: databaseActions(service, "PostgreSQL"),
};
