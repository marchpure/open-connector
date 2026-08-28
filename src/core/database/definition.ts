import type { CredentialDefinition, ProviderDefinition } from "../types.ts";

import { createDatabaseActions } from "./actions.ts";

export interface DatabaseProviderDefinitionOptions {
  service: string;
  displayName: string;
  homepageUrl: string;
  defaultPort: number;
  defaultDatabase: string;
  extraFields?: CredentialDefinition[];
}

export function createDatabaseProviderDefinition(options: DatabaseProviderDefinitionOptions): ProviderDefinition {
  return {
    service: options.service,
    displayName: options.displayName,
    categories: ["Data", "Developer Tools"],
    authTypes: ["custom_credential"],
    auth: [
      {
        type: "custom_credential",
        fields: [
          {
            key: "host",
            label: "Host",
            inputType: "text",
            required: true,
            secret: false,
            placeholder: "database.example.com",
          },
          {
            key: "port",
            label: "Port",
            inputType: "text",
            required: false,
            secret: false,
            placeholder: String(options.defaultPort),
          },
          {
            key: "database",
            label: "Database",
            inputType: "text",
            required: false,
            secret: false,
            placeholder: options.defaultDatabase,
          },
          {
            key: "username",
            label: "Username",
            inputType: "text",
            required: true,
            secret: false,
            placeholder: "readonly_user",
          },
          {
            key: "password",
            label: "Password",
            inputType: "password",
            required: true,
            secret: true,
            placeholder: "Enter password",
          },
          {
            key: "tls",
            label: "TLS mode",
            inputType: "text",
            required: false,
            secret: false,
            placeholder: "require",
            description: "One of disable, require, or verify-full. Defaults to require.",
          },
          {
            key: "caCertificate",
            label: "CA certificate",
            inputType: "textarea",
            required: false,
            secret: true,
            placeholder: "PEM certificate",
          },
          ...(options.extraFields ?? []),
        ],
        testAction: { actionName: "validate_connection", input: {} },
      },
    ],
    homepageUrl: options.homepageUrl,
    actions: createDatabaseActions(options.service, options.displayName),
  };
}
