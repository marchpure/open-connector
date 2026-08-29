import type { ProviderDefinition } from "../../core/types.ts";

import { createDatabaseProviderDefinition } from "../../core/database/definition.ts";

export const nodeOnly = true;

export const provider: ProviderDefinition = createDatabaseProviderDefinition({
  service: "hologres",
  displayName: "Hologres",
  homepageUrl: "https://www.alibabacloud.com/product/hologres",
  defaultPort: 80,
  defaultDatabase: "postgres",
});
