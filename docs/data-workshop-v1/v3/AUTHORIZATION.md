# Identity and authorization contract

## Authentication

OpenConnector accepts a user OAuth Access Token only through
`Authorization: Bearer` over HTTPS. Authentication must:

1. resolve the tenant's active IdentityProviderConfig;
2. verify JWT signature using the configured JWKS;
3. require the configured issuer and at least one configured audience;
4. reject expired tokens and tokens whose `nbf` is in the future;
5. extract stable `sub`, `groups`, and tenant claims;
6. reject missing required claims and any tenant mismatch;
7. produce AuthContext without retaining the raw token.

JWKS keys are cached for a bounded interval. An unknown `kid` triggers at most
one controlled refresh for that validation attempt. Refresh failure or an
unresolved key denies access. Rotation must not require a process restart.

Client-supplied subject, group, tenant, role, or connection headers never
override signed claims or server-owned state.

## Authorization

For a connection and optional Action:

```text
candidates =
  active grants in AuthContext.tenant_id for connection_id
  where (subject_type=user and subject_id=AuthContext.subject_id)
     or (subject_type=group and subject_id in AuthContext.group_ids)

if any matching deny covers action:
  deny(DENY_EXPLICIT)

granted =
  union(expanded Actions from matching allow roles/grants)
  intersect connection.enabled_actions
  intersect provider.available_actions

if action not in granted:
  deny(reason)

allow, subject to source-native permission at execution
```

`reader` expands only to Actions classified read-only. `operator` expands to
reader plus explicitly platform-approved non-administrative writes. `custom`
uses an explicit stable Action-ID allowlist and cannot use a wildcard.

Connection discovery is deny-by-default. `tools/list`, `list_connections`, and
Action search filter by the current AuthContext. `tools/call` resolves the
target and invokes the Authorizer again, even if the tool was previously
listed. A grant or role change increments `policy_version` and invalidates
cross-request decisions so the next request observes it.

Every grant mutation and every MCP list/call decision produces an immutable,
redacted audit event containing request ID, tenant, stable subject ID,
connection/Action identifiers, allow/deny, matched grant IDs, reason code, and
policy version. It contains no raw token or source credential.

## Separation of concerns

- Agent Identity authenticates users; it does not grant Connection access.
- OpenConnector authenticates and enforces Connection/Action permissions.
- Data Workshop BFF administers and presents grants; it is not the MCP proxy.
- APIG/WAF/LB transports requests; it does not decide business authorization.
- Runtime API keys are a separate M2M compatibility mode and never combine
  with user AccessGrants.
- OpenViking resources are Knowledge ResourceRefs, never MCP tools or
  Connections.
