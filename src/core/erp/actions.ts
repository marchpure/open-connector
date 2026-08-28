import type { ActionDefinition } from "../types.ts";
import type { ErpNativeEntity } from "./types.ts";

import { s } from "../json-schema.ts";
import { defineProviderAction } from "../provider-definition.ts";
import { erpDomains } from "./types.ts";

const nativeObject = s.looseObject("One provider-native ERP record. Field names and values retain native semantics.");
const domain = s.stringEnum("The stable ERP business domain.", erpDomains);

export function defineErpReadActions(service: string, entities: readonly ErpNativeEntity[]): ActionDefinition[] {
  const nativeEntities = entities.map((entry) => entry.entity);
  return [
    defineProviderAction(service, {
      name: "validate_connection",
      description: "Validate the configured ERP identity against the provider's official API.",
      inputSchema: s.object("No input is required.", {}),
      outputSchema: s.requiredObject("Validated provider-native connection identity.", {
        accountId: s.string("Provider-native account, tenant, database, or company identifier."),
        apiVersion: s.string("Provider-native API version."),
      }),
    }),
    defineProviderAction(service, {
      name: "discover_capabilities",
      description: "Discover the business domains, native entities, and fields supported by this exact ERP connection.",
      inputSchema: s.object("No input is required.", {}),
      outputSchema: s.requiredObject("Connection-specific read capabilities.", {
        capabilities: s.array(
          "Supported mappings. Absence means unsupported; it is never reported as an empty successful entity read.",
          s.requiredObject("One explicit stable-to-native mapping.", {
            domain,
            nativeEntity: s.stringEnum("The provider-native entity name.", nativeEntities),
            fields: s.stringArray("Provider-native fields visible to this connection."),
            readable: s.literal(true),
            writable: s.literal(false),
          }),
        ),
      }),
    }),
    defineProviderAction(service, {
      name: "list_entities",
      description:
        "Read one bounded provider-native page mapped to a stable ERP domain. This action never performs writes.",
      inputSchema: s.object(
        "A bounded ERP entity read.",
        {
          domain,
          fields: s.stringArray("Optional provider-native field projection.", {
            minItems: 1,
            maxItems: 50,
            itemDescription: "A field advertised by capability discovery.",
          }),
          pageSize: s.integer("Maximum rows in this page.", { minimum: 1, maximum: 200 }),
          cursor: s.string("Opaque provider-native continuation cursor from the previous response.", {
            maxLength: 4096,
          }),
          modifiedFrom: s.dateTime("Optional inclusive modification watermark."),
          modifiedTo: s.dateTime("Optional exclusive modification watermark."),
          companyId: s.string("Optional provider-native company/legal-entity boundary.", { maxLength: 256 }),
        },
        { optional: ["fields", "pageSize", "cursor", "modifiedFrom", "modifiedTo", "companyId"] },
      ),
      outputSchema: s.requiredObject("One bounded native ERP page and its explicit mapping.", {
        domain,
        nativeEntity: s.stringEnum("The provider-native entity queried.", nativeEntities),
        items: s.array("Provider-native records.", nativeObject, { maxItems: 200 }),
        nextCursor: s.nullableString("Opaque provider-native continuation cursor."),
        native: s.looseObject("Provider-native pagination and version metadata."),
      }),
      resourceBindings: {
        domain: erpDomains.map((value) => `application/vnd.oomol.erp.${value}`),
      },
    }),
  ];
}
