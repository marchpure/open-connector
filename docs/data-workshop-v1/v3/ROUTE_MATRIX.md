# V3 route matrix

## Navigation

Top-level navigation is exactly: 首页, 连接, 知识库, Skill, 最近会话. MCP,
HTTP API, and SDK documentation belongs under the 连接 secondary navigation.

| Browser route                       | Owner | Required behavior                                                              |
| ----------------------------------- | ----- | ------------------------------------------------------------------------------ |
| `/home`                             | W3    | Four-step journey: prepare data, configure access, connect MCP, generate Skill |
| `/connections/overview`             | W3    | Connection estate and health summary                                           |
| `/connections/providers`            | W3    | Existing connections                                                           |
| `/connections/providers/market`     | W3    | Provider catalog                                                               |
| `/connections/providers/new/oracle` | W3    | Oracle configuration and real validation                                       |
| `/connections/providers/:id`        | W3    | Connection details and Actions                                                 |
| `/connections/providers/:id/access` | W3    | Grant list, create/edit/revoke, and subject preview                            |
| `/connections/actions`              | W3    | Action catalog and admin-authenticated debugger                                |
| `/connections/trace`                | W3    | Redacted invocation and policy trace                                           |
| `/connections/access`               | W3    | Cross-connection grant administration and preview                              |
| `/connections/docs`                 | W3    | MCP, HTTP API, and SDK tabs; default tab is MCP                                |
| `/kb`                               | W6    | Redirect to `/kb/connect` without a Profile, otherwise `/kb/resources`         |
| `/kb/connect`                       | W6    | Hosted OpenViking Profile configuration                                        |
| `/kb/resources`                     | W6    | Resource tree, import, content, and ResourceRef creation                       |
| `/kb/retrieval`                     | W6    | Search, Find, Grep, and Glob                                                   |
| `/kb/tasks`                         | W6    | Real import/processing state, retry, and error recovery                        |
| `/kb/watch`                         | W6    | Watch definitions, state, and history                                          |
| `/skill`                            | W7    | Skill list                                                                     |
| `/skill/new`                        | W7    | New Skill workbench                                                            |
| `/skill/:id`                        | W7    | Existing Skill and Session workbench                                           |
| `/sessions`                         | W7    | Recent sessions                                                                |

Connection secondary navigation is exactly: 总览, 连接器, Actions, Trace,
访问权限, 文档. “API Key 与策略” is not the access-control label.

## Retired browser routes

These are compatibility redirects only; no page component, loader, mock data,
or navigation entry may remain.

| Request                      | Required result                                |
| ---------------------------- | ---------------------------------------------- |
| browser `GET /mcp`           | `301` or router replace to `/connections/docs` |
| browser `GET /mcp/new`       | `301` or router replace to `/connections/docs` |
| browser `GET /mcp/:id`       | `301` or router replace to `/connections/docs` |
| browser `GET /mcp/not-found` | `301` or router replace to `/connections/docs` |

## Protocol route collision rule

`POST /mcp` is the OpenConnector Streamable HTTP data plane. It must never be
deleted, renamed, or redirected. Routing is method-aware:

```text
GET  /mcp*  + browser navigation -> /connections/docs
POST /mcp   + MCP content         -> OpenConnector MCP runtime
```

The edge must not cache `POST /mcp` or streaming responses and must preserve
`Authorization` and MCP session headers.
