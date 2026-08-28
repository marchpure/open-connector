import type { ProviderDefinition } from "../../core/types.ts";

import { createDatabaseProviderDefinition } from "../../core/database/definition.ts";

export const nodeOnly = true;

export const provider: ProviderDefinition = createDatabaseProviderDefinition({
  service: "trino",
  displayName: "Trino",
  homepageUrl: "https://trino.io",
  defaultPort: 8443,
  defaultDatabase: "system",
  extraFields: [
    {
      key: "authMode",
      label: "Authentication mode",
      inputType: "text",
      required: true,
      secret: false,
      placeholder: "basic",
      description: "One of basic or none. Basic authentication requires TLS.",
    },
    {
      key: "schema",
      label: "Default schema",
      inputType: "text",
      required: false,
      secret: false,
      placeholder: "information_schema",
    },
  ],
});
