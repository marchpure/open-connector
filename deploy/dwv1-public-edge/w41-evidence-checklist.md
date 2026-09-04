# DWV1 W4.1 evidence checklist

Evidence must contain identifiers, hashes, HTTP status codes, redacted claim
summaries, and policy outcomes only. It must never contain passwords, client
secrets, access/refresh/ID tokens, API keys, authorization codes, PKCE
verifiers, database credentials, or connection credentials.

- [ ] W4 input SHA and W4 deployment SHA
- [ ] W4.1 local and remote SHA equality
- [ ] clean worktree
- [ ] immutable image digest
- [ ] control-plane and MCP-runtime released revisions
- [ ] UserPool UID, OAuth client UID, issuer, JWKS URL
- [ ] actual Access Token audience and `typ=access_token`
- [ ] readers and limited group UIDs
- [ ] redacted User A and User B `sub`
- [ ] IdentityProviderConfig persisted and shared after restart
- [ ] AccessGrant summaries and policy version
- [ ] no token / malformed / tampered / issuer / audience / expiry / nbf /
      missing sub / wrong client / wrong pool / cross-tenant negative matrix
- [ ] group UID extraction
- [ ] exact redirect allowlist and rejected arbitrary `workbuddy:` redirect
- [ ] signed state TTL and replay rejection
- [ ] authorization-code PKCE and refresh-token success
- [ ] `/health` 200
- [ ] all OAuth metadata endpoints 200 with expected issuer/resource
- [ ] unauthenticated `/mcp` 401 with exact `WWW-Authenticate`
- [ ] User A and B independent WorkBuddy OAuth sessions
- [ ] per-user `list_connections` and `search_actions` differences
- [ ] authorized `get_action_guide` and safe read-only `execute_action`
- [ ] unauthorized guide/execution rejected before credential resolution
- [ ] explicit deny precedence
- [ ] revoke fails immediately; restore succeeds
- [ ] restart preserves OAuth and RBAC
- [ ] JWKS cache and key refresh
- [ ] audit contains redacted `sub`, group UID, connection ID, action ID,
      allow/deny, policy version, and request ID
- [ ] full tests, typecheck, build, lint, format, and `git diff --check`
- [ ] root and bootstrap production dependency audits
- [ ] repository, image, logs, screenshots, and evidence secret scan
