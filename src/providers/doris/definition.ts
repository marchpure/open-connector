import type { ProviderDefinition } from "../../core/types.ts";

import { createDatabaseProviderDefinition } from "../../core/database/definition.ts";

export const nodeOnly = true;
export const provider: ProviderDefinition = createDatabaseProviderDefinition({
  service: "doris",
  displayName: "Apache Doris",
  homepageUrl: "https://doris.apache.org",
  defaultPort: 9030,
  defaultDatabase: "information_schema",
});
