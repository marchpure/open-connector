import type { ProviderDefinition } from "../../core/types.ts";

import { createDatabaseProviderDefinition } from "../../core/database/definition.ts";

export const nodeOnly = true;

export const provider: ProviderDefinition = createDatabaseProviderDefinition({
  service: "postgresql",
  displayName: "PostgreSQL",
  homepageUrl: "https://www.postgresql.org",
  defaultPort: 5432,
  defaultDatabase: "postgres",
});
