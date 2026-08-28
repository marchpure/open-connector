import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "dingtalk";
const user = s.looseObject("A DingTalk user visible to the authorized identity.");
const department = s.looseObject("A DingTalk department visible to the authorized identity.");
const calendar = s.looseObject("A DingTalk calendar visible to the authorizing user.");
const calendarEvent = s.looseObject("A bounded DingTalk calendar event visible to the authorizing user.");
const todoTask = s.looseObject("A bounded DingTalk todo task visible to the authorizing user.");
const cursorPageFields = {
  nextCursor: s.nullableString("The opaque next-page cursor, when returned."),
  hasMore: s.boolean("Whether another bounded page may be available."),
};

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
  defineProviderAction(service, {
    name: "list_calendars",
    description: "List calendars visible to the user who authorized this connection.",
    requiredScopes: ["Calendar.Calendar.Read"],
    providerPermissions: ["Calendar.Calendar.Read"],
    inputSchema: s.object("No input is required.", {}),
    outputSchema: s.object("The authorized user's bounded calendar list.", {
      items: s.array("Visible calendars.", calendar),
      ...cursorPageFields,
    }),
  }),
  defineProviderAction(service, {
    name: "list_calendar_events",
    description: "List a bounded time window of events from a previously discovered calendar.",
    requiredScopes: ["Calendar.Calendar.Read"],
    providerPermissions: ["Calendar.Calendar.Read"],
    resourceBindings: { calendarId: ["application/vnd.dingtalk.calendar"] },
    inputSchema: s.object(
      "A bounded calendar event page. The requested time window may not exceed 31 days.",
      {
        calendarId: s.nonEmptyString("A calendar ID returned by discovery."),
        timeMin: s.nonEmptyString("Inclusive ISO 8601 window start."),
        timeMax: s.nonEmptyString("Exclusive ISO 8601 window end."),
        cursor: s.string("An opaque cursor returned by the previous page."),
        maxResults: s.integer("Maximum events in this page.", { minimum: 1, maximum: 100 }),
      },
      { required: ["calendarId", "timeMin", "timeMax"], optional: ["cursor", "maxResults"] },
    ),
    outputSchema: s.object("A bounded DingTalk event page.", {
      items: s.array("Visible calendar events.", calendarEvent),
      ...cursorPageFields,
    }),
  }),
  defineProviderAction(service, {
    name: "list_todo_tasks",
    description: "List a bounded page of todo tasks visible to the user who authorized this connection.",
    requiredScopes: ["Todo.Todo.Read"],
    providerPermissions: ["Todo.Todo.Read"],
    inputSchema: s.object(
      "A bounded todo page with an optional due-time window of at most 366 days.",
      {
        cursor: s.string("An opaque cursor returned by the previous page."),
        fromDueTime: s.nonNegativeInteger("Inclusive due-time lower bound in milliseconds since Unix epoch."),
        toDueTime: s.nonNegativeInteger("Inclusive due-time upper bound in milliseconds since Unix epoch."),
        isDone: s.boolean("Filter by completion state."),
      },
      { optional: ["cursor", "fromDueTime", "toDueTime", "isDone"] },
    ),
    outputSchema: s.object("A bounded DingTalk todo page.", {
      items: s.array("Visible todo tasks.", todoTask),
      ...cursorPageFields,
    }),
  }),
  defineProviderAction(service, {
    name: "get_todo_task",
    description: "Read one todo task previously returned by discovery.",
    requiredScopes: ["Todo.Todo.Read"],
    providerPermissions: ["Todo.Todo.Read"],
    resourceBindings: { taskId: ["application/vnd.dingtalk.todo-task"] },
    inputSchema: s.object("Identify a discovered todo task.", {
      taskId: s.nonEmptyString("A todo task ID returned by discovery."),
    }),
    outputSchema: todoTask,
  }),
];
