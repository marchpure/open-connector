# Data Workshop V1 I0 baseline manifest

Status: `SUPERSEDED_BY_DWV1_I0_BASELINE_V3`

> Historical V2 evidence only. Do not use this manifest, its Publication
> model, or its Gateway routes as an implementation baseline. The canonical
> replacement is the
> [Data Workshop V1 I0 V3 baseline](https://github.com/marchpure/open-connector/tree/docs/dwv1-i0-baseline-v3/docs/data-workshop-v1/v3).

This manifest is the frozen three-product I0 baseline record.
No business feature work was started and no cloud or production state was
changed.

Design authority: Data Workshop V1 implementation SPEC, document
`NUMidBYfgop4BExlfracPc1nnfb`, revision 101, read on 2026-09-03.

## Repository and worktree inventory

| Role                       | Repository / remote                                                                             | Branch                                 | Local SHA                                  | Remote SHA                                                     | Worktree state                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Product                    | `marchpure/open-connector`, `git@github.com:marchpure/open-connector.git`                       | `codex/dwv1-i0-p0-product-baseline`    | `e8251a3dd96af1af6692bb2e95217acf2745641d` | same SHA on `fork/codex/dwv1-i0-p0-product-baseline`           | clean canonical product worktree; local and remote SHA equal                                                                    |
| Product candidate retained | `marchpure/open-connector`                                                                      | `feat/data-workshop-p0-connection-ecs` | `496a230e8507fff50a43977c5cfaec3e9da3367e` | `fork/feat/data-workshop-p0-connection-ecs` same SHA           | clean; no unpushed commits                                                                                                      |
| Original user worktree     | `marchpure/open-connector`                                                                      | `codex/web-action-chain`               | `50884f764c13a0629600dc38cae0616c1ec7c382` | branch not present on fork remote                              | dirty; 43 entries; preserved unchanged                                                                                          |
| Product                    | `marchpure/veadk-data-studio`, `https://github.com/marchpure/veadk-data-studio.git`             | `main`                                 | `9766b3a5e810c12edcfbe3ba43d9a3e0419c2275` | same SHA on `veadk-data-studio/main`                           | clean; no unpushed commits                                                                                                      |
| Product                    | `marchpure/data-workshop-skill-agent`, `git@github.com:marchpure/data-workshop-skill-agent.git` | `main`                                 | `713e755bff80f9c3d0160b6888742a5a6f314f85` | same SHA on `canonical/main`                                   | clean private canonical repository; local and remote SHA equal; initial skeleton was `473f4c2722aca1e5e176a05c7853f41d43da82fb` |
| SDK dependency only        | `volcengine/veadk-python`, `https://github.com/volcengine/veadk-python.git`                     | `main`                                 | local checkout dirty and behind            | public upstream pin `ba5cd8ea2eabbf84961674802278f38fd1b8e9ce` | source not copied; W5 skeleton pins this commit                                                                                 |

The historical AutoSkill commit
`b036a94cfc49a35cae855ac705904c3c9d2e443f` is audit evidence only and was not
merged or copied.

The audit manifest is tracked on `fork/codex/dwv1-i0-p0-baseline`. The branch
tip is verified by the final `git ls-remote` check; manifest-only commits must
not be mistaken for a product code base.

## Capability disposition

| Capability          | Directory-level evidence                                                                                                      | Baseline disposition                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| OAuth compatibility | `src/server/api/oauth-compat.ts` in the new P0 commit                                                                         | retained in OpenConnector P0 commit                                     |
| JWT verifier        | `src/identity/oauth-jwt-verifier.ts` in the new P0 commit; existing runtime JWT remains under `src/server/api/runtime-jwt.ts` | retained as verifier capability; claims-to-RuntimeGrant remains W2 work |
| VeFaaS              | existing OpenConnector runtime/server entrypoints and container definitions; no deployment performed                          | retained as runtime deployment capability; W4 owns environment config   |
| DRC/APIG            | no product code added; route contract is recorded below                                                                       | W4 only; proxy performs routing/stream passthrough, not authorization   |
| Connection Provider | OpenConnector `src/providers/`, catalog, connection service                                                                   | retained from clean OpenConnector base                                  |
| OpenViking          | Data Studio main has an existing knowledge provider, but no confirmed `adapters/openviking` path on this base                 | W6 adapter remains future owned work; no self-hosting                   |
| Native veADK Agent  | W5 canonical skeleton contains `agentkit.yaml` and explicit contract-only entrypoint                                          | W5 canonical repository; business implementation remains W5-owned       |
| ZIP validator       | No validator implementation copied into the skeleton; AutoSkill remains historical evidence only                              | W5 future-owned capability; not claimed as implemented                  |

## Frozen shared contract

- P0 publication mode is `direct_userpool_jwt`; `agentkit_gateway` is V1.1
  and is not implemented.
- Publication fields are `connection_id`, action policy,
  `identity_binding_id`, `allowed_client_ids`, `auth_mode`, canonical
  endpoint, and status.
- `ResourceRef` distinguishes `connection` and `knowledge`; an OpenViking
  Profile never silently becomes an OpenConnector Connection.
- Success responses use `data` and `meta.request_id`; errors use
  `error.code`, `error.message`, and `error.retryable`.
- Mutating requests carry `ClientToken` or `Idempotency-Key`.
- States are `DRAFT`, `VALIDATING_SOURCE`, `CONFIGURING_USERPOOL`,
  `CONFIGURING_PUBLIC_ROUTES`, `VERIFYING`, `PUBLISHED`, `FAILED`,
  `DISABLING`, and `REVOKED`.
- Secret red line: no JWT, authorization code, refresh token, Runtime Token,
  client secret, API key, or data-source password in browser storage, URL,
  Git, logs, traces, artifacts, ZIPs, fixtures, or evidence.

## Ownership and stable interfaces

- W1: OpenConnector `state/storage/runtime-role/infra` only.
- W2: OpenConnector `publication/identity/authorization/mcp-runtime` only.
- W3: Data Workshop shell, BFF core, contracts, and OpenConnector adapter only.
- W4: `dev` DRC/APIG/VeFaaS infrastructure only.
- W5: independent `marchpure/data-workshop-skill-agent` repository only.
- W6: Data Workshop `adapters/openviking`, knowledge pages, and corresponding
  tests only.
- Reserved local ports: OpenConnector control plane `8787`, runtime `8788`;
  Data Workshop web `5173`, BFF `8790`. Health contract is `GET /health` and
  `GET /ready` per role.
- Shared route contract for W4 is `/mcp/publications/*`,
  `/.well-known/*`, and `/oauth/*` to one runtime origin. The proxy does not
  validate JWTs or derive RuntimeGrants.

## W1–W6 handoff

W1 base: OpenConnector P0 code commit `e8251a3dd96af1af6692bb2e95217acf2745641d`.
Modify only state,
storage, runtime-role, and infra. Do not edit the original dirty worktree.

W2 base: OpenConnector P0 code commit `e8251a3dd96af1af6692bb2e95217acf2745641d`.
Modify only publication,
identity, authorization, and MCP runtime. Do not implement Gateway or ABAC.

W3 base: Data Studio `9766b3a5e810c12edcfbe3ba43d9a3e0419c2275`. Modify only
shell, BFF core, contracts, and OpenConnector adapter. Do not edit W6 paths or
generated assets.

W4 base: no product-code commit; infrastructure is environment-owned. Modify
only dev DRC/APIG/VeFaaS configuration and preserve methods, headers, statuses,
and stream passthrough.

W5 base: exact canonical repository
`marchpure/data-workshop-skill-agent` is canonical at
`713e755bff80f9c3d0160b6888742a5a6f314f85`; modify only that repository.

W6 base: Data Studio `9766b3a5e810c12edcfbe3ba43d9a3e0419c2275`. Modify only
`adapters/openviking`, knowledge pages, and corresponding tests. Do not
self-deploy OpenViking or edit BFF core.

## Verification

- P0 OpenConnector: `npm run typecheck` passed; targeted auth/runtime/OAuth
  tests passed: 118 tests; `git diff --check` passed.
- Data Studio: clean local/remote SHA equality verified; Python compilation and
  `git diff --check` passed, with existing `return in finally` warnings.
  Existing security/storage tests passed: 49 tests in
  `tests/test_storage_config.py`, `tests/test_tool_redaction.py`, and
  `tests/test_redaction_service.py`.
- W5 skeleton: one skeleton test passed; no product implementation claimed.
- The original dirty OpenConnector worktree was not edited, staged, committed,
  reset, or cleaned.
- Secret scan was rerun from each repository root over
  `git ls-files -co --exclude-standard`, with stderr preserved. High-confidence
  provider-token patterns matched only existing provider definition
  placeholders (OpenConnector: three files) and a test connection fixture
  (Data Studio: one file); no private-key or provider-token literal was
  confirmed. Generic field names and test fixtures were not treated as
  secrets, and no secret content was emitted.

Canonical W5 recovery is complete: the private repository
`marchpure/data-workshop-skill-agent` exists with default branch `main` at
`713e755bff80f9c3d0160b6888742a5a6f314f85`, equal to the clean local skeleton.
