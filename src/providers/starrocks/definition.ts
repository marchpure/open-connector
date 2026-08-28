import type { ProviderDefinition } from "../../core/types.ts";

import { createDatabaseProviderDefinition } from "../../core/database/definition.ts";

export const nodeOnly = true;
export const provider: ProviderDefinition = createDatabaseProviderDefinition({
  service: "starrocks",
  displayName: "StarRocks",
  homepageUrl: "https://www.starrocks.io",
  defaultPort: 9030,
  defaultDatabase: "information_schema",
});
