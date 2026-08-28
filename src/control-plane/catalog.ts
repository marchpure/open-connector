import type { CatalogStore, RuntimeProviderDefinition } from "../catalog-store.ts";
import type { CredentialDefinition, JsonSchema, ProviderAuthDefinition } from "../core/types.ts";
import type { CatalogTier } from "./types.ts";

export interface EnablementEntry {
  service: string;
  tier: CatalogTier;
  connectorDefinitionVersion: string;
  owner: string;
  evidenceRef?: string;
}

export class CatalogEnablement {
  private readonly entries: Map<string, EnablementEntry>;
  private readonly catalog: CatalogStore;

  constructor(catalog: CatalogStore, entries: EnablementEntry[] = []) {
    this.catalog = catalog;
    this.entries = new Map(entries.map((entry) => [entry.service, entry]));
  }

  list(): CatalogEntry[] {
    return this.catalog.providers
      .map((provider) => this.toEntry(provider))
      .filter((entry): entry is CatalogEntry => entry !== undefined);
  }

  get(service: string): CatalogEntry | undefined {
    const provider = this.catalog.providers.find((candidate) => candidate.service === service);
    return provider ? this.toEntry(provider) : undefined;
  }

  private toEntry(provider: RuntimeProviderDefinition) {
    const configured = this.entries.get(provider.service);
    if (!configured) {
      return undefined;
    }
    return {
      ...configured,
      displayName: provider.displayName,
      actionIds: provider.actions.map((action) => action.id),
      configSchema: connectionSchema(provider.auth, false),
      authSchema: authSchema(provider.auth),
    };
  }
}

export type CatalogEntry = EnablementEntry & {
  displayName: string;
  actionIds: string[];
  configSchema: JsonSchema;
  authSchema: JsonSchema;
};

function authSchema(definitions: ProviderAuthDefinition[]): JsonSchema {
  return connectionSchema(definitions, true);
}

function connectionSchema(definitions: ProviderAuthDefinition[], secrets: boolean): JsonSchema {
  const alternatives = definitions.map((definition) => authDefinitionSchema(definition, secrets));
  if (alternatives.length === 1) return alternatives[0];
  return { oneOf: alternatives };
}

function authDefinitionSchema(definition: ProviderAuthDefinition, secrets: boolean): JsonSchema {
  if (definition.type === "no_auth") {
    return secrets
      ? objectSchema([], {
          _auth_type: { type: "string", const: "no_auth", title: "Authentication type" },
        })
      : { ...objectSchema([]), "x-auth-type": "no_auth" };
  }
  if (definition.type === "oauth2") {
    const fields = definition.clientConfigFields ?? [];
    return schemaForFields(definition.type, fields, secrets);
  }
  const fields =
    definition.type === "api_key"
      ? [
          {
            key: "apiKey",
            label: definition.label ?? "API key",
            inputType: "password" as const,
            required: true,
            secret: true,
            placeholder: definition.placeholder,
            description: definition.description,
          },
          ...(definition.extraFields ?? []),
        ]
      : definition.fields;
  return schemaForFields(definition.type, fields, secrets);
}

function schemaForFields(type: string, fields: CredentialDefinition[], secrets: boolean): JsonSchema {
  const selected = fields.filter((field) => field.secret === secrets);
  const schema = objectSchema(
    selected.filter((field) => field.required).map((field) => field.key),
    {
      ...(secrets
        ? {
            _auth_type: {
              type: "string",
              const: type,
              title: "Authentication type",
            },
          }
        : {}),
      ...Object.fromEntries(selected.map((field) => [field.key, credentialProperty(field)])),
    },
  );
  return secrets ? schema : { ...schema, "x-auth-type": type };
}

function objectSchema(required: string[], properties: Record<string, JsonSchema> = {}): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function credentialProperty(field: CredentialDefinition): JsonSchema {
  return {
    type: field.inputType === "json" ? "object" : "string",
    title: field.label,
    ...(field.inputType === "password" || field.secret ? { format: "password" } : {}),
    ...(field.inputType === "textarea" ? { format: "textarea" } : {}),
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    ...(field.description ? { description: field.description } : {}),
  };
}
