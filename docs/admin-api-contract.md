# Admin API Contract

This contract is the W3 boundary for identity and access administration.

## Principals

- Admin/BFF identity: `Authorization: Bearer <OOMOL_CONNECT_ADMIN_TOKEN>` or the server-side admin session cookie. This identity may call `/api/*`, `/docs`, and the web console.
- Runtime API key identity: `OOMOL_CONNECT_RUNTIME_TOKEN` or stored `oct_...` tokens. This identity may call runtime execution and discovery endpoints only.
- Runtime JWT subject identity: a verified end-user JWT. This identity may call MCP, runtime execution and discovery endpoints, and current-subject access preview only.

Browser code must not fetch, store, or forward the admin token. If W3 needs a hosted admin UI, the browser must call a BFF session endpoint and the BFF must attach the admin credential server-side.

## Admin Surface

The canonical admin API is `/api/*`.

| Capability                           | Method and path                       | Caller         |
| ------------------------------------ | ------------------------------------- | -------------- |
| Read JWT identity provider config    | `GET /api/identity-provider`          | Admin/BFF only |
| Replace JWT identity provider config | `PUT /api/identity-provider`          | Admin/BFF only |
| List AccessGrants                    | `GET /api/access-grants`              | Admin/BFF only |
| Create AccessGrant                   | `POST /api/access-grants`             | Admin/BFF only |
| Patch AccessGrant                    | `PATCH /api/access-grants/{id}`       | Admin/BFF only |
| Revoke AccessGrant                   | `POST /api/access-grants/{id}/revoke` | Admin/BFF only |
| Preview any subject access decision  | `POST /api/access/preview`            | Admin/BFF only |
| List access audit records            | `GET /api/access/audit`               | Admin/BFF only |
| List verified identity subjects      | `GET /api/identity/subjects`          | Admin/BFF only |
| Manage runtime tokens                | `/api/runtime-tokens*`                | Admin/BFF only |
| Manage runtime policy                | `/api/runtime-policy`                 | Admin/BFF only |

## Runtime Surface

Runtime credentials may use:

| Capability                          | Method and path                                          | Caller                                                               |
| ----------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| MCP protocol                        | `POST /mcp`                                              | Runtime API key or runtime JWT                                       |
| MCP discovery summary               | `GET /mcp/tools`                                         | Runtime API key or runtime JWT                                       |
| Runtime catalog and action metadata | `GET /v1/providers`, `GET /v1/actions*`, `GET /v1/apps*` | Runtime API key or runtime JWT                                       |
| Runtime action execution            | `POST /v1/actions/{actionId}`                            | Runtime API key or runtime JWT                                       |
| Runtime provider proxy              | `POST /v1/proxy/{service}`                               | Runtime API key or runtime JWT                                       |
| Current-subject access preview      | `POST /v1/access:preview`                                | Runtime JWT only, or explicit subject in trusted admin console flows |

Runtime credentials must not list all grants, all subjects, audit records, tenant identity-provider configuration, or mutate authorization state.

## Legacy `/v1` Management Paths

These paths existed during W2 but are not part of the W3 runtime contract. They are admin-scoped compatibility routes only and are omitted from OpenAPI runtime documentation.

| Legacy path                          | W3 canonical path                     | Compatibility decision                                        |
| ------------------------------------ | ------------------------------------- | ------------------------------------------------------------- |
| `GET /v1/access-grants`              | `GET /api/access-grants`              | Admin token only; migrate callers to `/api`                   |
| `POST /v1/access-grants`             | `POST /api/access-grants`             | Admin token only; migrate callers to `/api`                   |
| `PATCH /v1/access-grants/{id}`       | `PATCH /api/access-grants/{id}`       | Admin token only; migrate callers to `/api`                   |
| `POST /v1/access-grants/{id}:revoke` | `POST /api/access-grants/{id}/revoke` | Admin token only; retain temporarily for colon-action clients |
| `POST /v1/access-grants/{id}/revoke` | `POST /api/access-grants/{id}/revoke` | Admin token only; migrate callers to `/api`                   |
| `GET /v1/access/audit`               | `GET /api/access/audit`               | Admin token only; migrate callers to `/api`                   |
| `GET /v1/identity/subjects`          | `GET /api/identity/subjects`          | Admin token only; migrate callers to `/api`                   |

New management APIs must use `/api/*` or a dedicated `/admin/v1/*` scope. They must not be added to generic `/v1/*` runtime auth.
