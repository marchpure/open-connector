import type { ProviderDefinition } from "../../core/types.ts";

import { createDatabaseProviderDefinition } from "../../core/database/definition.ts";

export const nodeOnly = true;

export const provider: ProviderDefinition = createDatabaseProviderDefinition({
  service: "sql_server",
  displayName: "Microsoft SQL Server",
  homepageUrl: "https://www.microsoft.com/sql-server",
  defaultPort: 1433,
  defaultDatabase: "master",
  extraFields: [
    {
      key: "instanceName",
      label: "Instance name",
      inputType: "text",
      required: false,
      secret: false,
      placeholder: "SQLEXPRESS",
      description: "Optional named instance. Do not set it together with a custom port.",
    },
    {
      key: "encrypt",
      label: "Encrypt",
      inputType: "text",
      required: false,
      secret: false,
      placeholder: "true",
      description: "Whether SQL Server transport encryption is enabled. Defaults to true.",
    },
    {
      key: "trustServerCertificate",
      label: "Trust server certificate",
      inputType: "text",
      required: false,
      secret: false,
      placeholder: "false",
      description: "Accept an untrusted server certificate. Defaults to false.",
    },
  ],
});
