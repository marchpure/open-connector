# Data Workshop V1 I0 baseline manifest

Status: `DWV1_I0_BASELINE_BLOCKED`

This manifest is an auditable preparation record. It is not a frozen
three-product baseline because the canonical W5 repository is unavailable.
No business feature work was started and no cloud or production state was
changed.

Design authority: Data Workshop V1 implementation SPEC, document
`NUMidBYfgop4BExlfracPc1nnfb`, revision 101, read on 2026-09-03.

## Repository and worktree inventory

| Role | Repository / remote | Branch | Local SHA | Remote SHA | Worktree state |
|---|---|---|---|---|---|
| Product | `marchpure/open-connector`, `git@github.com:marchpure/open-connector.git` | `codex/dwv1-i0-p0-baseline` | `e8251a3dd96af1af6692bb2e95217acf2745641d` | to be verified after push | clean independent worktree; derived from clean `496a230e8507fff50a43977c5cfaec3e9da3367e` |
| Product candidate retained | `marchpure/open-connector` | `feat/data-workshop-p0-connection-ecs` | `496a230e8507fff50a43977c5cfaec3e9da3367e` | `fork/feat/data-workshop-p0-connection-ecs` same SHA | clean; no unpushed commits |
| Original user worktree | `marchpure/open-connector` | `codex/web-action-chain` | `50884f764c13a0629600dc38cae0616c1ec7c382` | branch not present on fork remote | dirty; 43 entries; preserved unchanged |
| Product | `marchpure/veadk-data-studio`, `https://github.com/marchpure/veadk-data-studio.git` | `main` | `9766b3a5e810c12edcfbe3ba43d9a3e0419c2275` | same SHA on `veadk-data-studio/main` | clean; no unpushed commits |
| Product skeleton only | intended `hydra-agent/data-workshop-skill-agent` | `main` | `713e755bff80f9c3d0160b6888742a5a6f314f85` | none | clean local-only recovery skeleton; not formal product baseline |
| SDK dependency only | `volcengine/veadk-python`, `https://github.com/volcengine/veadk-python.git` | `main` | local checkout dirty and behind | public upstream pin `ba5cd8ea2eabbf84961674802278f38fd1b8e9ce` | source not copied; W5 skeleton pins this commit |

The W5 local skeleton intentionally does not substitute for the missing
canonical repository. The historical AutoSkill commit
`b036a94cfc49a35cae855ac705904c3c9d2e443f` is audit evidence only and was not
merged or copied.

## Capability disposition

| Capability | Directory-level evidence | Baseline disposition |
|---|---|---|
| OAuth compatibility | `src/server/api/oauth-compat.ts` in the new P0 commit | retained in OpenConnector P0 commit |
| JWT verifier | `src/identity/oauth-jwt-verifier.ts` in the new P0 commit; existing runtime JWT remains under `src/server/api/runtime-jwt.ts` | retained as verifier capability; claims-to-RuntimeGrant remains W2 work |
| VeFaaS | existing OpenConnector runtime/server entrypoints and container definitions; no deployment performed | retained as runtime deployment capability; W4 owns environment config |
| DRC/APIG | no product code added; route contract is recorded below | W4 only; proxy performs routing/stream passthrough, not authorization |
| Connection Provider | OpenConnector `src/providers/`, catalog, connection service | retained from clean OpenConnector base |
| OpenViking | Data Studio main has an existing knowledge provider, but no confirmed `adapters/openviking` path on this base | W6 adapter remains future owned work; no self-hosting |
| Native veADK Agent | only local W5 skeleton exists; canonical product repo missing | blocked; no AutoSkill code copied |
| ZIP validator | only historical AutoSkill evidence exists | blocked with W5; no validator claimed as product baseline |

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
- W5: independent `data-workshop-skill-agent` repository only.
- W6: Data Workshop `adapters/openviking`, knowledge pages, and corresponding
  tests only.
- Reserved local ports: OpenConnector control plane `8787`, runtime `8788`;
  Data Workshop web `5173`, BFF `8790`. Health contract is `GET /health` and
  `GET /ready` per role.
- Shared route contract for W4 is `/mcp/publications/*`,
  `/.well-known/*`, and `/oauth/*` to one runtime origin. The proxy does not
  validate JWTs or derive RuntimeGrants.

## W1–W6 handoff

W1/W2 base: OpenConnector P0 commit
`e8251a3dd96af1af6692bb2e95217acf2745641d`; W1 may edit only state, storage,
runtime-role, and infra; W2 may edit only publication, identity,
authorization, and MCP runtime. Do not edit the original dirty worktree.

W3/W6 base: Data Studio `9766b3a5e810c12edcfbe3ba43d9a3e0419c2275`; W3 owns
shell/BFF/contracts/OpenConnector adapter, W6 owns only OpenViking adapter,
knowledge pages, and tests. Do not edit generated assets across lanes.

W4 has no product-code base; it owns only dev DRC/APIG/VeFaaS configuration and
must preserve methods, headers, statuses, and stream passthrough.

W5 has no formal base: canonical
`hydra-agent/data-workshop-skill-agent` must be created or access granted.
The local-only skeleton SHA is `713e755bff80f9c3d0160b6888742a5a6f314f85`;
it may be offered as a seed, not declared as the product base.

## Verification

- P0 OpenConnector: `npm run typecheck` passed; targeted auth/runtime/OAuth
  tests passed: 118 tests; `git diff --check` passed.
- Data Studio: clean local/remote SHA equality verified; Python compilation and
  `git diff --check` passed, with existing `return in finally` warnings.
- W5 skeleton: one skeleton test passed; no product implementation claimed.
- The original dirty OpenConnector worktree was not edited, staged, committed,
  reset, or cleaned.
- Secret scan was rerun from each repository root over
  `git ls-files -co --exclude-standard`; high-confidence private-key and
  provider-token patterns are recorded without emitting matched content.
  Generic field names and test fixtures were not treated as secrets.

## Unique external blocker

Owner: Integration Owner / `hydra-agent` repository owner.

Required repository: `hydra-agent/data-workshop-skill-agent`.

Minimum action: create that exact repository or grant access to its canonical
remote, then provide its default branch and a clean remote commit containing
the native veADK Agent, validation, Revision/Artifact/Manifest, and
secret-free WorkBuddy ZIP contract. Do not substitute another organization or
the local skeleton. Until that remote SHA exists and is verified, the required
state is `DWV1_I0_BASELINE_BLOCKED`, not `DWV1_I0_BASELINE_FROZEN`.
