import type { ProviderDefinition } from "../../core/types.ts";

import { createDatabaseProviderDefinition } from "../../core/database/definition.ts";

export const nodeOnly = true;

export const provider: ProviderDefinition = createDatabaseProviderDefinition({
  service: "oracle_database",
  displayName: "Oracle Database",
  homepageUrl: "https://www.oracle.com/database/",
  defaultPort: 1521,
  defaultDatabase: "FREEPDB1",
  includeDatabaseField: false,
  extraFields: [
    {
      key: "serviceName",
      label: "Service name",
      inputType: "text",
      required: true,
      secret: false,
      placeholder: "FREEPDB1",
      description: "Oracle service name used by the listener, for example FREEPDB1.",
    },
    {
      key: "allowedSchemas",
      label: "Allowed schemas",
      inputType: "text",
      required: false,
      secret: false,
      placeholder: "APP",
      description: "Comma-separated schema allowlist used by discovery and query lineage checks.",
    },
  ],
});
