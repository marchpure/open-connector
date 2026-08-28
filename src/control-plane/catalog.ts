import type { CatalogStore, RuntimeProviderDefinition } from "../catalog-store.ts";
import type {
  CredentialDefinition,
  JsonSchema,
  OAuth2AuthDefinition,
  ProviderAuthDefinition,
} from "../core/types.ts";
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

  list(): Array<EnablementEntry & CatalogProviderEntry> {
    return this.catalog.providers
      .map((provider) => this.toEntry(provider))
      .filter(
        (entry): entry is EnablementEntry & CatalogProviderEntry =>
          entry !== undefined,
      );
  }

  get(service: string): (EnablementEntry & CatalogProviderEntry) | undefined {
    const provider = this.catalog.providers.find((candidate) => candidate.service === service);
    return provider ? this.toEntry(provider) : undefined;
  }

  private toEntry(
    provider: RuntimeProviderDefinition,
  ): (EnablementEntry & CatalogProviderEntry) | undefined {
    const configured = this.entries.get(provider.service);
    if (!configured) {
      return undefined;
    }
    return {
      ...configured,
      displayName: provider.displayName,
      actionIds: provider.actions.map((action) => action.id),
      configSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      authSchema: providerAuthSchema(provider.auth),
    };
  }
}

type CatalogProviderEntry = {
  displayName: string;
  actionIds: string[];
  configSchema: JsonSchema;
  authSchema: JsonSchema;
};

function providerAuthSchema(auth: readonly ProviderAuthDefinition[]): JsonSchema {
  const alternatives = auth.flatMap((definition) => {
    if (definition.type === "no_auth") {
      return [];
    }
    return [authDefinitionSchema(definition)];
  });
  if (alternatives.length === 0) {
    return {
      type: "object",
      properties: {},
      additionalProperties: false,
    };
  }
  return alternatives.length === 1
    ? alternatives[0]
    : { oneOf: alternatives };
}

function authDefinitionSchema(
  definition: Exclude<ProviderAuthDefinition, { type: "no_auth" }>,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    _auth_type: {
      const: definition.type,
      title: "Authentication type",
      type: "string",
    },
  };
  const required = ["_auth_type"];

  if (definition.type === "api_key") {
    properties.apiKey = credentialSchema({
      key: "apiKey",
      label: definition.label ?? "API key",
      inputType: "password",
      required: true,
      secret: true,
      placeholder: definition.placeholder,
      description: definition.description,
    });
    required.push("apiKey");
    for (const field of definition.extraFields ?? []) {
      properties[field.key] = credentialSchema(field);
      if (field.required) required.push(field.key);
    }
  } else if (definition.type === "custom_credential") {
    for (const field of definition.fields) {
      properties[field.key] = credentialSchema(field);
      if (field.required) required.push(field.key);
    }
  } else {
    oauthSchemaFields(definition).forEach((field) => {
      properties[field.key] = credentialSchema(field);
      if (field.required) required.push(field.key);
    });
  }

  return {
    type: "object",
    "x-auth-type": definition.type,
    properties,
    required,
    additionalProperties: false,
  };
}

function oauthSchemaFields(definition: OAuth2AuthDefinition): CredentialDefinition[] {
  return (definition.clientConfigFields ?? []).map((field) => ({
    key: field.key,
    label: field.label,
    inputType: field.inputType,
    required: field.required,
    secret: field.secret,
    placeholder: field.placeholder,
    description: field.description,
  }));
}

function credentialSchema(field: CredentialDefinition): JsonSchema {
  return {
    type: "string",
    title: field.label,
    description: field.description,
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    ...(field.inputType === "password" || field.secret
      ? { format: "password" }
      : {}),
  };
}
