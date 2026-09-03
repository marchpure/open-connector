# V3 migration ledger

No Git history is rewritten. “Remove” means delete from the future V3 product
line, not erase historical commits.

| Source / object                                                 | Frozen disposition                                                                   | Evidence or target                                                                                                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V2 baseline manifest                                            | `SUPERSEDED_BY_DWV1_I0_BASELINE_V3`; historical evidence only                        | `marchpure/open-connector:codex/dwv1-i0-p0-baseline@70974f7b167b78646f7cb183435f4c504387065a`; tag `dwv1-v2-baseline-superseded-by-v3`                                                                               |
| V2 Publication implementation                                   | `DO_NOT_INTEGRATE`; no wholesale merge/cherry-pick/deploy                            | `marchpure/veadk-python:feat/data-workshop-p0-gateway-publisher@a1db9ceb406aef15a3e4f9a1558dc942c7f74038`; implementation tip `40568577c91dbdab2b2440ed893444eaa1b6a8d3`; tag `dwv1-v2-publication-do-not-integrate` |
| Publication tables, APIs, UI, revisions                         | Remove; archive development data as evidence only; no data migration                 | W2/W3                                                                                                                                                                                                                |
| AgentKit Gateway adapter and Credential Provider adapter        | Remove from Data Workshop integration                                                | W3                                                                                                                                                                                                                   |
| Gateway Toolset and AllowedClients policy                       | Remove; replace with Connection/Action AccessGrant                                   | W2/W3                                                                                                                                                                                                                |
| Access Token to Runtime API Key exchange                        | Remove                                                                               | W2/W3/W4                                                                                                                                                                                                             |
| Runtime API Key                                                 | Keep only as collapsed advanced M2M/service-account compatibility                    | W1/W3                                                                                                                                                                                                                |
| Frontend `/mcp`, `/mcp/new`, `/mcp/:id`, `/mcp/not-found` pages | Remove implementation; redirect GET navigation to `/connections/docs`                | W3                                                                                                                                                                                                                   |
| Backend `POST /mcp`                                             | Keep as the sole user MCP data plane                                                 | W1/W2/W4                                                                                                                                                                                                             |
| OpenViking MCP adapter/Profile publication                      | Remove                                                                               | W6                                                                                                                                                                                                                   |
| OpenViking Profile/resource/task/search/watch                   | Migrate selectively from exact donor; keep hosted-service boundary                   | W6                                                                                                                                                                                                                   |
| Skill UI/session/artifact/ZIP patterns                          | Migrate selectively from exact donor; rewrite identity and capability binding for V3 | W7                                                                                                                                                                                                                   |
| `volcengine/veadk-python`                                       | SDK dependency only; never receive Data Workshop product code                        | W5                                                                                                                                                                                                                   |
| `marchpure/veadk-python`                                        | Read-only donor and legacy evidence only                                             | Integration owner                                                                                                                                                                                                    |
| Any noncanonical historical W5 organization path                | Forbidden remote/reference/fallback                                                  | Integration owner                                                                                                                                                                                                    |

## Candidate branch audit

| Candidate                                                                                                 | Classification                           | Reuse rule                                                                                                                      |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `marchpure/open-connector:main@0fa2c728dfbf957735da2843ec2b8a4f3425b105`                                  | Canonical V3 source base                 | W1/W2/W4 branch from this pin                                                                                                   |
| `marchpure/open-connector:codex/dwv1-i0-p0-product-baseline@e8251a3dd96af1af6692bb2e95217acf2745641d`     | V2-era candidate, not baseline           | Manually reimplement reviewed OAuth metadata/JWT verifier ideas only; missing V3 `nbf`, tenant, groups, AccessGrant enforcement |
| `marchpure/open-connector:feat/data-workshop-p0-connection-ecs@496a230e8507fff50a43977c5cfaec3e9da3367e`  | W1/W4 candidate                          | Manually port reviewed Oracle, connection, trace, and deployment pieces; do not import old authorization assumptions            |
| `marchpure/veadk-python:feat/data-workshop-p0-gateway-publisher@40568577c91dbdab2b2440ed893444eaa1b6a8d3` | V2 Publication implementation            | `DO_NOT_INTEGRATE`                                                                                                              |
| local `feat/data-workshop-product-v1-integration@e57b67d751a3471360767dc4d6f268c1ee441858`                | Dirty/conflicted V2 integration worktree | Preserve for forensic evidence only; never use as a base                                                                        |
| `marchpure/data-workshop-skill-agent:main@495d52e218bcde1b5386c01bcd4be04dc95852d3`                       | Canonical W5 source base                 | Implement only W5-owned paths                                                                                                   |

## Manually reusable generic code

Only concepts—not commits or modules—may be reused from the quarantined
Publication branch, after review and new V3 tests:

- secret redaction and plaintext-persistence checks;
- idempotency-key conflict handling;
- request-ID propagation;
- standard REST error-envelope shaping;
- negative authorization/fail-closed test patterns;
- retryability classification.

Publication orchestration, repositories, models, revisions, routes, UI,
AgentKit clients, credential adapters, toolsets, and allowed-client verification
are not reusable.

## Exact donor ledger

| Donor                | Exact SHA                                  | Allowed extraction                                                                                     | Forbidden extraction                                                        |
| -------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Skill Creator UI     | `9c025a977800bc2abb026ec059813d0a37cd0add` | Three-column shell, session UX, conditional artifact pane, file tree, diff and ZIP validation patterns | Published-skill semantics, Gateway calls, tokens, generated bundles         |
| OpenViking primary   | `d203bfb89a36baa908d0e60ef49f6175dd623942` | Profile/resource/content/import/task/Search/Find/Grep/Glob/Watch and ResourceRef patterns              | MCP adapter/publication, demo data, evidence, caches, secrets, built assets |
| OpenViking isolation | `7ab6a8697a04cbbfdea7f88aaa27d6c117663fc2` | Lazy registration and module isolation patterns                                                        | Legacy workspace coupling and compatibility routes                          |

Every extracted file must be recorded with donor SHA, source path, destination
path, disposition (`copied`, `adapted`, or `rewritten`), reviewer, and tests.

## Inspire audit

Canvas `6a8a29f9c015c9021c92777c` was inspected through the authenticated
Inspire Studio canvas:

- v4.8 shape `shape:6a980bdb6df02302399ab526`, bundle
  `1682bb7775bec4a588058c554949a7f8a3e9ac128610e590caea3f08922e0576`,
  remains the public stable selection and visibly uses Publication.
- v5.0 shape `shape:6a9988c5d4feed01aa94ff0b`, bundle
  `68871e11c46970fd5ad99b89a052f48922a096f079b14571b3edca81c9a452aa`.
- v5.0 corrective shape `shape:6a998b19827c3f01e746fd87`, bundle
  `cc32eff964635434a6b58d5c15edbe07821eb6b0547bf20c8039f1cde8e0d1bc`.

Both v5.0 shapes still have top-level MCP navigation; the corrective shape also
leaves legacy `/mcp*` pages live and lacks `/connections/docs` and access
routes. They are useful interaction donors but not V3 route authority. SPEC V3
revision 135 wins.
