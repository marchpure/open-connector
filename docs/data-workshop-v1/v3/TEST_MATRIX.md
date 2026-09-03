# V3 test matrix

Every row is a required release assertion. Evidence must contain the command or
journey, result, environment, timestamp, commit/deployment ID, and redacted
request IDs where applicable.

| ID      | Owner    | Level            | Required assertion                                                                                                    |
| ------- | -------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| REP-01  | I0       | Git              | Each canonical default branch equals its frozen full SHA and every tracked checkout is clean                          |
| REP-02  | I0       | Git              | W5 remote is exactly `marchpure/data-workshop-skill-agent`, private, default `main`; forbidden Hydra remote is absent |
| REP-03  | I0       | Git              | All three donor SHAs resolve exactly; no generated asset, cache, evidence, or secret is copied                        |
| MIG-01  | I0       | Static           | V2 manifest carries `SUPERSEDED_BY_DWV1_I0_BASELINE_V3`                                                               |
| MIG-02  | I0       | Static           | Publication branch carries `DO_NOT_INTEGRATE`; only its generic patterns are allowlisted                              |
| AUTH-01 | W2       | Unit/integration | Valid signature, issuer, audience, expiry, not-before and tenant yields AuthContext                                   |
| AUTH-02 | W2       | Negative         | Bad signature/issuer/audience, expired/not-yet-valid token, missing `sub`, and tenant mismatch all deny               |
| AUTH-03 | W2       | Integration      | Unknown `kid` triggers one bounded JWKS refresh; unresolved key denies; rotation succeeds                             |
| AUTH-04 | W2       | Contract         | `sub` and `groups` resolve to stable UserPool IDs; display names/emails are never keys                                |
| POL-01  | W2       | Unit             | Direct and group allow grants union their Actions                                                                     |
| POL-02  | W2       | Unit             | Any matching explicit deny overrides all matching allows                                                              |
| POL-03  | W1/W2    | Integration      | Result intersects enabled and provider-available Actions; source-native permission still applies                      |
| POL-04  | W2       | Integration      | Revoke, role change, disabled connection, and Action version change affect the next request                           |
| MCP-01  | W1/W2    | Integration      | `tools/list` returns only connections/Actions visible to current AuthContext                                          |
| MCP-02  | W1/W2    | Negative         | Guessed tool names and stale discovery cannot bypass per-call authorization                                           |
| MCP-03  | W1/W2    | Integration      | Every list/call emits redacted Trace and PolicyDecision audit with request ID                                         |
| MCP-04  | W4       | E2E              | WorkBuddy OAuth reaches stable HTTPS `POST /mcp`, lists tools, and performs a real read                               |
| MCP-05  | W4       | Resilience       | Streaming, MCP session headers, restart, multi-instance operation, rate limiting, and JWKS rotation pass              |
| API-01  | W1/W2    | Contract         | OpenConnector paths/methods match `contracts/openapi.yaml` and schemas validate                                       |
| API-02  | W3/W6/W7 | Contract         | BFF paths/methods match `contracts/bff-openapi.yaml`; standard envelopes include request ID                           |
| API-03  | All      | Negative         | Error bodies never reveal token, key, password, grant existence across tenants, or internal stack                     |
| UI-01   | W3       | Browser          | Top navigation is exactly 首页, 连接, 知识库, Skill, 最近会话                                                         |
| UI-02   | W3       | Browser          | All formal routes deep-link, reload, back/forward, and render at 1440×900, 1280×800, 390×844                          |
| UI-03   | W3       | Browser          | Browser GET on every retired `/mcp*` form redirects/replaces to `/connections/docs`                                   |
| UI-04   | W1/W3    | Integration      | `POST /mcp` is not captured by the browser redirect and reaches MCP runtime                                           |
| UI-05   | W3       | Browser          | Connection grant create/edit/revoke/preview explains direct/group source and deny reason                              |
| UI-06   | W3       | Browser          | `/connections/docs` has MCP/HTTP API/SDK tabs, real configured endpoint/status, and no generated user token           |
| UI-07   | W3/W6/W7 | Static/browser   | No scenario controller, timer-based fake success, fake endpoint, hardcoded credential, or empty artifact pane         |
| OV-01   | W6       | Integration      | Profile CRUD/validate persists, masks key, and recovers Pending/Ready/Error                                           |
| OV-02   | W6       | E2E              | Text, URL, TXT, Markdown, PDF, CSV, JSON, XLSX and Connection imports produce real Tasks                              |
| OV-03   | W6       | E2E              | Resource read plus Search/Find/Grep/Glob and Watch work against hosted OpenViking                                     |
| OV-04   | W6       | Static/E2E       | Only Knowledge ResourceRef enters Skill context; no MCP adapter/publication remains                                   |
| SK-01   | W5/W7    | E2E              | Create and update reuse one target; session resume, tool trace, Diff and version work                                 |
| SK-02   | W5       | Negative         | Missing delegated user identity returns `BLOCKED_AUTH`; no elevated fallback                                          |
| SK-03   | W5       | Security         | Artifact/ZIP rejects traversal, symlink, duplicate entry, oversize, decompression bomb, and secrets                   |
| SK-04   | W5/W7    | E2E              | Validate precedes Revision/Artifact/ZIP; new WorkBuddy OAuth session runs installed Skill                             |
| SEC-01  | All      | Static/E2E       | Token/secret scan is zero across Git, URLs, browser storage, logs, traces, screenshots, evidence, artifacts and ZIP   |
| LEG-01  | W3/W6    | Static           | Product code/navigation has zero retired Publication/Gateway/OpenViking-MCP concepts                                  |
| LEG-02  | I0       | Static           | New baseline references only the canonical W5 repository path                                                         |

## I0 verifier

Run:

```bash
node scripts/verify-dwv1-v3-baseline.mjs
node scripts/verify-dwv1-v3-repositories.mjs
```

The verifier checks package structure, schema validity, required API and UI
routes, retired-object declarations, exact pins, report source/citation
integrity, remote default refs, and tracked-clean source checkouts. It does not
substitute for W1–W7 implementation tests.
