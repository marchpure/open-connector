import type { ProviderDefinition } from "../../core/types.ts";

import { createDatabaseProviderDefinition } from "../../core/database/definition.ts";

export const nodeOnly = true;

export const provider: ProviderDefinition = createDatabaseProviderDefinition({
  service: "hive",
  displayName: "Apache Hive",
  homepageUrl: "https://hive.apache.org",
  defaultPort: 10000,
  defaultDatabase: "default",
  extraFields: [
    {
      key: "authMode",
      label: "Authentication mode",
      inputType: "text",
      required: true,
      secret: false,
      placeholder: "ldap",
      description: "One of nosasl or ldap. Kerberos requires an operator-installed native module.",
    },
  ],
});
