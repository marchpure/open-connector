import type { ProviderDefinition } from "../../core/types.ts";

import { createDatabaseProviderDefinition } from "../../core/database/definition.ts";

export const nodeOnly = true;

/**
 * TiDB SQL deliberately uses a distinct canonical service ID. The existing
 * `tidb` provider is the TiDB Cloud management API and remains unchanged.
 */
export const provider: ProviderDefinition = createDatabaseProviderDefinition({
  service: "tidb_sql",
  displayName: "TiDB SQL",
  homepageUrl: "https://docs.pingcap.com/tidbcloud/connect-to-tidb-cluster/",
  defaultPort: 4000,
  defaultDatabase: "test",
});
