import type { ProviderDefinition } from "../../core/types.ts";

import { createDatabaseProviderDefinition } from "../../core/database/definition.ts";

export const nodeOnly = true;

export const provider: ProviderDefinition = createDatabaseProviderDefinition({
  service: "oceanbase",
  displayName: "OceanBase",
  homepageUrl: "https://www.oceanbase.com",
  defaultPort: 2881,
  defaultDatabase: "test",
  extraFields: [
    {
      key: "mode",
      label: "Compatibility mode",
      inputType: "text",
      required: true,
      secret: false,
      placeholder: "mysql",
      description: "OceanBase tenant compatibility mode. This runtime currently supports mysql.",
    },
  ],
});
