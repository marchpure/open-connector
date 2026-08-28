import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "dingtalk";
const user = s.looseObject("A DingTalk user visible to the authorized identity.");
const department = s.looseObject("A DingTalk department visible to the authorized identity.");

export const dingtalkActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "get_current_user",
    description: "Read the DingTalk identity that authorized this connection.",
    requiredScopes: ["openid"],
    providerPermissions: ["openid"],
    inputSchema: s.object("No input is required.", {}),
    outputSchema: s.looseObject("The authorized DingTalk user."),
  }),
  defineProviderAction(service, {
    name: "get_user",
    description: "Read one DingTalk user by the provider user ID after authorization checks.",
    requiredScopes: ["Contact.User.Read"],
    providerPermissions: ["Contact.User.Read"],
    resourceBindings: { userId: ["application/vnd.dingtalk.user"] },
    inputSchema: s.object("Identify a visible DingTalk user.", {
      userId: s.nonEmptyString("The DingTalk user ID returned by discovery."),
    }),
    outputSchema: user,
  }),
  defineProviderAction(service, {
    name: "search_users",
    description: "Search the authorized DingTalk enterprise directory with a bounded page.",
    requiredScopes: ["Contact.User.Read"],
    providerPermissions: ["Contact.User.Read"],
    inputSchema: s.object(
      "Bounded DingTalk directory search.",
      {
        query: s.string("A directory search term."),
        offset: s.nonNegativeInteger("The page offset."),
        size: s.integer("The page size.", { minimum: 1, maximum: 100 }),
      },
      { optional: ["query", "offset", "size"] },
    ),
    outputSchema: s.object("A bounded DingTalk user page.", {
      items: s.array("Visible users.", user),
      nextCursor: s.nullableString("The next cursor, when returned."),
      hasMore: s.boolean("Whether another page exists."),
    }),
  }),
  defineProviderAction(service, {
    name: "list_departments",
    description: "List departments visible to the authorized DingTalk identity.",
    requiredScopes: ["Contact.Department.Read"],
    providerPermissions: ["Contact.Department.Read"],
    inputSchema: s.object(
      "Bounded department listing.",
      {
        parentId: s.string("The parent department ID."),
        maxResults: s.integer("Maximum departments.", { minimum: 1, maximum: 100 }),
      },
      { optional: ["parentId", "maxResults"] },
    ),
    outputSchema: s.object("A bounded DingTalk department page.", {
      items: s.array("Visible departments.", department),
      hasMore: s.boolean("Whether another page exists."),
      nextCursor: s.nullableString("The next cursor, when returned."),
    }),
  }),
];
