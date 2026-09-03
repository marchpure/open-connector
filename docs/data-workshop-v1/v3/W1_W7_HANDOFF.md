# W1–W7 implementation handoff

All work starts from the frozen clean source pin. “Done” below is a future
implementation gate, not a claim made by I0.

## W1 — OpenConnector core

- I0 status: source capabilities audited; V3 implementation not started.
- Base: `marchpure/open-connector:main@0fa2c728dfbf957735da2843ec2b8a4f3425b105`.
- Deliver: durable Connection/Action/Trace stores, Provider lifecycle, MCP
  runtime authorization hooks, `/health`, `/ready`, and the relevant `/v1/*`.
- Gate: restart and multi-instance tests; real Oracle-equivalent discovery,
  read Action, and redacted Trace; no in-memory-only success path.
- Boundary: W2 supplies identity and decisions. Do not add Publication.

## W2 — identity and access

- I0 status: contract frozen; implementation not started.
- Base: same OpenConnector pin.
- Deliver: IdentityProviderConfig, JWT/JWKS validation, SubjectResolver,
  AccessGrant/RoleDefinition, policy engine, invalidation, preview and audit.
- Gate: signature/issuer/audience/expiry/not-before/tenant/sub/groups cases;
  direct plus group grants; explicit deny; immediate revoke; filtered list and
  re-authorized call.
- Boundary: stable UserPool IDs only. Do not model natural users as API keys.

## W3 — Data Workshop shell and access UI

- I0 status: contract frozen; implementation not started.
- Base: `marchpure/veadk-data-studio:main@9766b3a5e810c12edcfbe3ba43d9a3e0419c2275`.
- Deliver: product shell, same-origin OpenConnector launch session/embed,
  access UI, `/connections/docs`, and all V3 connection routes.
- Gate: deep links, reload/back/forward, redirect matrix, 1440×900,
  1280×800, and 390×844; browser sees no admin token.
- Boundary: top-level navigation has no MCP item.

## W4 — HTTPS MCP deployment

- I0 status: route/deployment contract frozen; no environment change made.
- Base: frozen OpenConnector pin plus environment-owned deployment repository.
- Deliver: stable dev HTTPS `POST /mcp`, TLS, WAF/rate limiting, Streamable HTTP
  pass-through, WorkBuddy OAuth integration and operational evidence.
- Gate: non-empty identity-filtered `tools/list`, real read call, deny cases,
  JWKS rotation, restart/multi-instance, and zero-token log scan.
- Boundary: edge components do not calculate Connection/Action permissions.

## W5 — native veADK Skill Creator agent

- I0 status: clean contract-only scaffold; implementation not started.
- Base:
  `marchpure/data-workshop-skill-agent:main@495d52e218bcde1b5386c01bcd4be04dc95852d3`.
- Deliver: create/update single-target agent, controlled delegated validation,
  Revision, Artifact, manifest, and safe ZIP.
- Gate: no identity returns `BLOCKED_AUTH`; validation precedes artifact; path
  traversal, symlink, duplicate-entry, size, compression-ratio, and secret
  checks pass; ZIP root is `<slug>/SKILL.md`.
- Boundary: depend on public veADK SDK; do not place product code in the SDK.

## W6 — hosted OpenViking workspace

- I0 status: donors audited; migration not started.
- Base: frozen Data Studio pin.
- Donors:
  `d203bfb89a36baa908d0e60ef49f6175dd623942` and
  `7ab6a8697a04cbbfdea7f88aaa27d6c117663fc2`.
- Deliver: Profile, resource/content, imports, tasks, four retrieval modes,
  Watch, ResourceRef, lazy production chunks.
- Gate: hosted service only, encrypted/masked key, failure recovery, all import
  types, retrieval and Watch, no MCP/publication surface.
- Boundary: Connection import is a knowledge source and does not change object
  ownership.

## W7 — Skill UI and BFF

- I0 status: donor audited and contract frozen; migration not started.
- Base: frozen Data Studio pin.
- Donor: `9c025a977800bc2abb026ec059813d0a37cd0add`.
- Deliver: Skill list, new/existing three-column workbench,
  sessions/messages/events, context binding, Revision/Artifact/Diff/download.
- Gate: one successful target per session; artifact pane absent before an
  Artifact exists; refresh/resume works; validated ZIP installs and executes in
  a new WorkBuddy OAuth session; no secrets.
- Boundary: W5 owns generation and validation; W7 owns orchestration and UX.

## Integration order

1. I1: W1 + W2.
2. I2: W4 and WorkBuddy OAuth end to end.
3. I3: W3 Connection → AccessGrant → docs journey.
4. I4: W5 + W7 Skill → WorkBuddy.
5. I5: W6 OpenViking → Knowledge Context → Skill, then structured-data
   regression.
