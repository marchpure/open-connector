# Read-only audit inventory

Observed on 2026-09-04 before the V3 package was authored.

## OpenConnector candidates

| Ref                                    | Full SHA                                   | Finding                                                                                                                                                                     | V3 disposition                                                                                                              |
| -------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `marchpure/open-connector:main`        | `0fa2c728dfbf957735da2843ec2b8a4f3425b105` | Canonical default branch; has `POST /mcp`, five generic MCP tools, connection/action filtering based on the existing runtime grant/policy, and a basic remote-JWKS verifier | Frozen source base; W1/W2 must replace the runtime-token policy seam with AuthContext + AccessGrant without removing `/mcp` |
| `codex/dwv1-i0-p0-product-baseline`    | `e8251a3dd96af1af6692bb2e95217acf2745641d` | Adds OAuth compatibility discovery/callback and a structured JWT verifier on a V2-era line                                                                                  | Not a source base; manually reimplement only reviewed generic OAuth/JWT ideas                                               |
| `feat/data-workshop-p0-connection-ecs` | `496a230e8507fff50a43977c5cfaec3e9da3367e` | Contains Oracle Connection/Action/Trace and deployment evidence                                                                                                             | Candidate donor for W1/W4 only; rebase/review rather than merge wholesale                                                   |
| local `codex/web-action-chain`         | `50884f764c13a0629600dc38cae0616c1ec7c382` | Dirty user worktree with tracked and untracked changes                                                                                                                      | Preserve unchanged; never use as the clean freeze                                                                           |

### Current MCP/JWT gap

The canonical source base has:

- `src/server/connect-server.ts`: real method-specific `POST /mcp`;
- `src/mcp.ts`: stable generic tools `list_apps`, `list_connections`,
  `search_actions`, `get_action_guide`, and `execute_action`;
- `src/server/api/runtime-jwt.ts`: signature/issuer/audience/expiry validation
  through remote JWKS.

It does not yet provide the complete V3 IdentityProviderConfig,
SubjectResolver, stable `sub/groups/tenant` AuthContext, AccessGrant engine,
explicit-deny semantics, access preview/audit APIs, or per-user policy
invalidation. These are W2 implementation work and are not claimed by I0.

## V2 Publication implementation

The exact V2 implementation tip is
`marchpure/veadk-python:feat/data-workshop-p0-gateway-publisher@40568577c91dbdab2b2440ed893444eaa1b6a8d3`.
It contains:

- `frontend/server/extensions/agentkit_mcp/`;
- `frontend/src/features/knowledge-workspace/api/mcpPublications.ts`;
- `frontend/src/features/knowledge-workspace/pages/McpPublications.tsx`;
- Publication workflow, publisher, verifier, and managed-publication tests.

The marker commit
`a1db9ceb406aef15a3e4f9a1558dc942c7f74038` adds
`DO_NOT_INTEGRATE.md`; the annotated tag is
`dwv1-v2-publication-do-not-integrate`. See the migration ledger for the narrow
manual-reuse allowlist.

## Data Studio candidates

| Ref                                     | Full SHA                                   | V3 disposition                                                      |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| `main`                                  | `9766b3a5e810c12edcfbe3ba43d9a3e0419c2275` | Canonical W3/W6/W7 source base                                      |
| `agent/data-studio-p0`                  | `142837f7587dd1519d4287c1cb26c8e2840fc39a` | Historical P0 candidate; do not integrate without path-level review |
| `frontend/data-studio-commercial-p0`    | `54c1f299800e0c3957b31f482e11fed21b75024f` | Historical UI candidate; not a V3 base                              |
| `integration/data-studio-commercial-p0` | `5e37c5e255ec2190ba09a7d866f5d429d2f06434` | Historical integration candidate; not a V3 base                     |
| `integration/knowledge-center`          | `3e8132ea62cbdcbddb0affaccbdb52a7fdbfee42` | Historical knowledge candidate; exact V3 donors take precedence     |
| `integration/kc-veadk-knowledge-center` | `7a6cef9f0938bcdb2fe76b635311ca4eb25df0ca` | Historical integration candidate; not a V3 base                     |

Other remote branches remain ordinary repository history; none is implicitly
approved by this baseline.

## OpenViking donors

All exact commits resolve in `marchpure/veadk-python`:

| Purpose                        | Full SHA                                   | Relevant roots                                                                                               |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Primary production integration | `d203bfb89a36baa908d0e60ef49f6175dd623942` | `frontend/server/extensions/openviking/`, `frontend/src/extensions/openviking/`, OpenViking acceptance tests |
| Isolation reference            | `7ab6a8697a04cbbfdea7f88aaa27d6c117663fc2` | lazy registration, optional extension, workspace migration/repository boundaries                             |

Only source modules and tests needed by W6 may be migrated. Built web assets,
acceptance evidence, demo fixtures, caches, logs, and secrets are excluded.

## Skill Creator donor

Commit `9c025a977800bc2abb026ec059813d0a37cd0add` resolves in
`marchpure/veadk-python`. Relevant source roots include:

- `frontend/server/skills/` and `frontend/server/artifacts/`;
- `frontend/src/features/knowledge-workspace/{creator,workspace,artifact}/`;
- `frontend/src/ui/skill-workbench/`;
- session, artifact, Skill, and ZIP tests.

The generated `veadk/webui/assets/` diff at that commit is not donor source.
W5 owns agent/validation/artifact generation; W7 owns the adapted UI/BFF.

## Canonical W5

`marchpure/data-workshop-skill-agent` exists as a private repository with
default branch `main`. Its I0 tip
`495d52e218bcde1b5386c01bcd4be04dc95852d3` is a minimal, clean,
contract-only scaffold and pins public `volcengine/veadk-python` as an SDK
dependency. No product code is stored in either SDK or donor repository.

## Inspire Canvas

Authenticated read-only inspection found:

- v4.8 `shape:6a980bdb6df02302399ab526`, bundle
  `1682bb7775bec4a588058c554949a7f8a3e9ac128610e590caea3f08922e0576`;
- v5.0 `shape:6a9988c5d4feed01aa94ff0b`, bundle
  `68871e11c46970fd5ad99b89a052f48922a096f079b14571b3edca81c9a452aa`;
- v5.0 corrective `shape:6a998b19827c3f01e746fd87`, bundle
  `cc32eff964635434a6b58d5c15edbe07821eb6b0547bf20c8039f1cde8e0d1bc`.

The public stable URL still resolves to v4.8. The corrective V5 shape was read
across all formal paths plus retired `/mcp*` paths. It still carries a
top-level MCP item, “API Key 与策略,” a Gateway-based Skill sample, live legacy
MCP pages, and no `/connections/docs` or access routes. SPEC V3 revision 135 is
the binding correction.
