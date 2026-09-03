# Data Workshop V1 I0 baseline V3

Status: `DWV1_I0_BASELINE_V3_FROZEN`

Frozen at: `2026-09-04T00:55:42+08:00`

This is a contract and ownership baseline. It does not claim that the V3
business features are implemented, deployed, or accepted.

## Authority

Precedence is:

1. [SPEC V3, revision 135][spec]
2. [PRD V3, revision 11][prd]
3. [Inspire Canvas][canvas], as interaction evidence only

The live Canvas contains two v5.0-labelled shapes, but both still expose a
top-level “MCP 接入” item and the public stable preview still selects v4.8.
Those conflicts are superseded by SPEC V3 v5.1. The implementation baseline is
therefore the written V3 contract in this package, not the currently published
prototype.

## Frozen architecture

```text
Agent Identity
  -> OAuth Access Token
WorkBuddy / MCP Client
  -> Authorization: Bearer <access_token>
OpenConnector HTTPS POST /mcp
  -> verify JWT + resolve sub/groups + tenant
  -> evaluate AccessGrant
  -> filter tools/list
  -> re-authorize every tools/call
Connection Action
```

`AccessGrant = Connection + User/UserGroup + Role`.

OpenConnector is the policy-enforcement point. AgentKit is only the deployment
runtime for the W5 native veADK agent. APIG/WAF/LB performs TLS, rate limiting,
routing, and streaming pass-through only.

## Repository pins

The canonical product source pins are recorded in
[`REPOSITORY_PINS.json`](REPOSITORY_PINS.json). Each pin was checked against the
remote default branch and a clean local checkout:

| Product owner         | Canonical remote                                         | Default branch | Frozen full SHA                            |
| --------------------- | -------------------------------------------------------- | -------------- | ------------------------------------------ |
| OpenConnector         | `git@github.com:marchpure/open-connector.git`            | `main`         | `0fa2c728dfbf957735da2843ec2b8a4f3425b105` |
| Data Workshop Web+BFF | `https://github.com/marchpure/veadk-data-studio.git`     | `main`         | `9766b3a5e810c12edcfbe3ba43d9a3e0419c2275` |
| Skill Creator Agent   | `git@github.com:marchpure/data-workshop-skill-agent.git` | `main`         | `495d52e218bcde1b5386c01bcd4be04dc95852d3` |

`volcengine/veadk-python` is an SDK dependency only.
`marchpure/veadk-python` is a read-only donor and legacy evidence repository
only. No Data Workshop product ownership may move into either repository.

The W5 repository is private and already exists; recovery creation was not
needed. No noncanonical organization path is a repository dependency or
fallback.

## Frozen package

- [`OWNERSHIP_MATRIX.md`](OWNERSHIP_MATRIX.md): exclusive W1–W7 ownership.
- [`AUDIT_INVENTORY.md`](AUDIT_INVENTORY.md): current branches, runtime, and
  donor evidence.
- [`AUTHORIZATION.md`](AUTHORIZATION.md): JWT/JWKS and AccessGrant semantics.
- [`contracts/openapi.yaml`](contracts/openapi.yaml): OpenConnector V3 API.
- [`contracts/bff-openapi.yaml`](contracts/bff-openapi.yaml): Web+BFF V3 API.
- [`contracts/schemas.json`](contracts/schemas.json): shared data schemas.
- [`contracts/ERROR_ENVELOPE.md`](contracts/ERROR_ENVELOPE.md): REST and MCP
  failures.
- [`ROUTE_MATRIX.md`](ROUTE_MATRIX.md): formal UI routes and legacy redirects.
- [`TEST_MATRIX.md`](TEST_MATRIX.md): cross-workstream acceptance obligations.
- [`MIGRATION_LEDGER.md`](MIGRATION_LEDGER.md): keep, remove, archive, and
  manual-reuse decisions.
- [`W1_W7_HANDOFF.md`](W1_W7_HANDOFF.md): bases, inputs, outputs, and gates.
- [`report/output/index.html`](report/output/index.html): standalone,
  browser-readable baseline report; it is not linked from product navigation.

The three source commits are additionally protected by the annotated tag
`dwv1-i0-baseline-v3-source` in their respective repositories. The contract
package is published from branch `docs/dwv1-i0-baseline-v3` and tagged
`dwv1-i0-baseline-v3-frozen`.

## Non-negotiable invariants

- JWT validation covers signature, `iss`, `aud`, `exp`, `nbf`, and tenant.
- Unknown `kid` triggers one controlled JWKS refresh; refresh failure denies.
- `sub` and `groups` resolve to stable UserPool subject IDs.
- Roles are `reader`, `operator`, and `custom`; matching explicit deny wins.
- `tools/list` is identity-filtered; every `tools/call` is authorized again.
- New connections are private until an active AccessGrant allows Actions.
- OpenViking maps only
  `Profile/directory/resource -> Knowledge ResourceRef -> Skill Context`.
- Frontend legacy `/mcp*` GET routes redirect to `/connections/docs`.
- Backend `POST /mcp` remains the real Streamable HTTP data plane.
- Runtime API keys remain an advanced M2M compatibility mechanism only.
- Tokens and secrets never enter URLs, browser storage, logs, traces,
  screenshots, evidence, artifacts, or ZIPs.

## Explicitly retired

The V3 product has no:

- AgentKit MCP Gateway user-access path;
- Publication, Publication Revision, Credential Provider, Toolset, or
  AllowedClients object;
- access-token-to-API-key exchange;
- natural-person API key flow;
- OpenViking MCP adapter or OpenViking publication;
- top-level MCP navigation or standalone MCP product page.

## Freeze rule

Any change to an invariant, schema, method/path, ownership boundary, formal
route, redirect, or test obligation requires a reviewed V4 baseline. Workstream
implementations may refine internals without changing this package.

[prd]: https://bytedance.larkoffice.com/docx/KT6OdypsfoezVexGGYvcdtoZnVg
[spec]: https://bytedance.larkoffice.com/docx/NUMidBYfgop4BExlfracPc1nnfb
[canvas]: https://inspire.bytedance.net/prototype/canvas/6a8a29f9c015c9021c92777c
