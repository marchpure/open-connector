import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "wecom";
const user = s.looseObject("A WeCom directory user visible to the enterprise application.");
const department = s.looseObject("A WeCom department visible to the enterprise application.");

export const wecomActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "get_application_identity",
    description: "Validate the enterprise application and return a redacted identity profile.",
    requiredScopes: ["contact:user:read"],
    providerPermissions: ["contact:user:read"],
    inputSchema: s.object("No input is required.", {}),
    outputSchema: s.object("The enterprise application identity.", {
      corpId: s.string("The redacted enterprise identifier."),
      agentId: s.string("The configured application identifier."),
    }),
  }),
  defineProviderAction(service, {
    name: "list_departments",
    description: "List departments visible to the configured WeCom enterprise application.",
    requiredScopes: ["contact:department:read"],
    providerPermissions: ["contact:department:read"],
    inputSchema: s.object("No input is required.", {}),
    outputSchema: s.array("Visible departments.", department),
  }),
  defineProviderAction(service, {
    name: "list_users",
    description: "List users in one visible WeCom department with a bounded response.",
    requiredScopes: ["contact:user:read"],
    providerPermissions: ["contact:user:read"],
    inputSchema: s.object(
      "Bounded WeCom user listing.",
      { departmentId: s.string("The department ID."), fetchChild: s.boolean("Whether to include child departments.") },
      { optional: ["departmentId", "fetchChild"] },
    ),
    outputSchema: s.object("Visible users in the selected department.", {
      items: s.array("Visible users.", user),
      total: s.integer("The returned user count."),
    }),
  }),
  defineProviderAction(service, {
    name: "get_group_chat",
    description: "Read one WeCom group chat visible to the enterprise application.",
    requiredScopes: ["chat:read"],
    providerPermissions: ["chat:read"],
    inputSchema: s.object("Identify a group chat.", { chatId: s.nonEmptyString("The WeCom group chat ID.") }),
    outputSchema: s.looseObject("The visible group chat."),
  }),
];
