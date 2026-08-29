import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { describe, expect, it, vi } from "vitest";
import { dingtalkActions } from "./actions.ts";
import { dingtalkActionHandlers, discoverResources } from "./executors.ts";

const credential: Extract<ResolvedCredential, { authType: "oauth2" }> = {
  authType: "oauth2",
  accessToken: "user-token",
  tokenType: "Bearer",
  profile: { accountId: "union-1", displayName: "User", grantedScopes: [] },
  metadata: { identityType: "user_access_token" },
};

describe("DingTalk ecosystem read contracts", () => {
  it("publishes only read actions with native scopes and resource bindings", () => {
    expect(dingtalkActions.map((action) => action.name)).toEqual([
      "get_current_user",
      "get_user",
      "search_users",
      "list_departments",
      "list_calendars",
      "list_calendar_events",
      "list_todo_tasks",
      "get_todo_task",
    ]);
    expect(dingtalkActions.every((action) => /^(get|list|search)_/.test(action.name))).toBe(true);
    expect(dingtalkActions.find((action) => action.name === "list_calendar_events")).toMatchObject({
      requiredScopes: ["Calendar.Calendar.Read"],
      resourceBindings: { calendarId: ["application/vnd.dingtalk.calendar"] },
    });
    expect(dingtalkActions.find((action) => action.name === "get_todo_task")).toMatchObject({
      requiredScopes: ["Todo.Todo.Read"],
      resourceBindings: { taskId: ["application/vnd.dingtalk.todo-task"] },
    });
  });

  it("derives calendar identity from the token and uses the official token header", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/contact/users/me")) {
        expect(request.headers.get("authorization")).toBe("Bearer user-token");
        return Response.json({ unionId: "union-1" });
      }
      expect(request.url).toContain("/calendar/users/union-1/calendars");
      expect(request.headers.get("x-acs-dingtalk-access-token")).toBe("user-token");
      expect(request.headers.has("authorization")).toBe(false);
      return Response.json({ response: { calendars: [{ id: "cal-1", summary: "Work" }] } });
    });

    await expect(
      dingtalkActionHandlers.list_calendars({}, { accessToken: "user-token", tokenType: "Bearer", fetcher }),
    ).resolves.toEqual({
      items: [
        {
          id: "cal-1",
          summary: "Work",
          identityType: "user_access_token",
          access: "authorizing-user-visible",
          resourceKind: "calendar",
          mimeType: "application/vnd.dingtalk.calendar",
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("enforces calendar windows and bounded event pages", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/contact/users/me")) return Response.json({ unionId: "union-1" });
      const url = new URL(request.url);
      expect(url.searchParams.get("maxResults")).toBe("100");
      expect(url.searchParams.get("nextToken")).toBe("cursor-1");
      return Response.json({
        events: Array.from({ length: 120 }, (_, index) => ({ id: `event-${index}`, accessToken: "redact" })),
        nextToken: "cursor-2",
      });
    });
    const context = { accessToken: "user-token", tokenType: "Bearer", fetcher };
    await expect(
      dingtalkActionHandlers.list_calendar_events(
        {
          calendarId: "cal-1",
          timeMin: "2026-08-01T00:00:00Z",
          timeMax: "2026-08-15T00:00:00Z",
          maxResults: 100,
          cursor: "cursor-1",
        },
        context,
      ),
    ).resolves.toMatchObject({ hasMore: true, nextCursor: "cursor-2", items: { length: 100 } });
    await expect(
      dingtalkActionHandlers.list_calendar_events(
        {
          calendarId: "cal-1",
          timeMin: "2026-01-01T00:00:00Z",
          timeMax: "2026-08-15T00:00:00Z",
        },
        context,
      ),
    ).rejects.toThrow("calendar window exceeds");
  });

  it("bounds todo queries and does not accept an arbitrary user identity", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/contact/users/me")) return Response.json({ unionId: "union-1" });
      expect(request.url).toContain("/todo/users/union-1/tasks/list");
      expect(request.url).not.toContain("attacker");
      expect(request.headers.get("x-acs-dingtalk-access-token")).toBe("user-token");
      return Response.json({ todoCards: [{ taskId: "task-1", subject: "Review", secret: "redact" }] });
    });
    const result = await dingtalkActionHandlers.list_todo_tasks(
      { unionId: "attacker", fromDueTime: 1_700_000_000_000, toDueTime: 1_700_086_400_000 },
      { accessToken: "user-token", tokenType: "Bearer", fetcher },
    );
    expect(JSON.stringify(result)).not.toContain("redact");
    await expect(
      dingtalkActionHandlers.list_todo_tasks(
        { fromDueTime: 1_700_000_000_000 },
        { accessToken: "user-token", tokenType: "Bearer", fetcher },
      ),
    ).rejects.toThrow("bounds must be provided together");
  });

  it("discovers calendars and todos while treating ungranted optional domains as absent", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/users/me")) return Response.json({ unionId: "union-1", nick: "Ada" });
      if (url.pathname.endsWith("/users/search")) return Response.json({ users: [] });
      if (url.pathname.endsWith("/calendars")) {
        return Response.json({ response: { calendars: [{ id: "cal-1", summary: "Work" }] } });
      }
      if (url.pathname.endsWith("/tasks/list")) {
        return Response.json({ todoCards: [{ taskId: "task-1", subject: "Review" }] });
      }
      if (url.pathname.endsWith("/departments")) return Response.json({ departments: [] });
      throw new Error(`unexpected URL ${url}`);
    });
    const resources = await discoverResources(context(), fetcher);
    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: "cal-1",
          mimeType: "application/vnd.dingtalk.calendar",
          schema: expect.objectContaining({ identityType: "user_access_token", access: "authorizing-user-visible" }),
        }),
        expect.objectContaining({
          resourceId: "task-1",
          mimeType: "application/vnd.dingtalk.todo-task",
        }),
      ]),
    );
  });

  it("does not hide expired-token or throttling failures during discovery", async () => {
    for (const status of [401, 429]) {
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
        if (url.pathname.endsWith("/users/me")) return Response.json({ unionId: "union-1" });
        if (url.pathname.endsWith("/users/search")) return Response.json({ users: [] });
        if (url.pathname.endsWith("/calendars")) return Response.json({}, { status });
        throw new Error(`unexpected URL ${url}`);
      });
      await expect(discoverResources(context(), fetcher)).rejects.toMatchObject({ status });
    }
  });
});

function context(): ExecutionContext {
  return {
    getCredential: async (service) => {
      expect(service).toBe("dingtalk");
      return credential;
    },
  };
}
