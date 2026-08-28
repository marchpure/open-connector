import type { ProviderDefinition } from "../../core/types.ts";

import { createDatabaseProviderDefinition } from "../../core/database/definition.ts";

export const nodeOnly = true;
export const provider: ProviderDefinition = createDatabaseProviderDefinition({
  service: "mysql",
  displayName: "MySQL",
  homepageUrl: "https://www.mysql.com",
  defaultPort: 3306,
  defaultDatabase: "mysql",
});
