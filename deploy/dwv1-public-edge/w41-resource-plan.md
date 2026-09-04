# DWV1 W4.1 OAuth/RBAC cloud write plan

Every Volcengine CLI command uses `---profile default`. This plan reuses the
existing W4 PostgreSQL, KMS Secret, TOS bucket, VeFaaS functions, APIG gateway,
service, and upstreams. It does not create or modify ECS, EIP, RDS, another
gateway, `101.126.155.97`, the legacy MySQL OAuth proof of concept, or AgentKit
MCP resources.

The single approval checkpoint covers only:

1. `ve id CreateUserPool` for `dwv1-openconnector-workbuddy-dev`.
2. `ve id CreateUserPoolClient` for
   `dwv1-openconnector-oauth-bridge-dev`, type `WEB_APPLICATION`, with the sole
   upstream callback `<public-origin>/oauth/callback`.
3. Two `ve id CreateGroup` calls for `dwv1-connection-readers` and
   `dwv1-connection-limited`.
4. Up to two `ve id CreateUser` calls, or binding two existing controlled
   UserPool users supplied by UID. Passwords are never accepted through chat,
   command arguments, Git, logs, screenshots, or evidence.
5. Two `ve id AddUsersToGroup` calls using user and group UIDs.
6. One new W4.1 image tag in the existing CR repository.
7. One new version of existing KMS Secret `dwv1/openconnector/dev`, preserving
   all existing values and adding only the seven `OPENCONNECTOR_OAUTH_*` keys.
8. `ve vefaas UpdateFunction` and `ve vefaas Release` for functions
   `6fmb81qa` and `hygmpcqd`.
9. Two `ve apig20221112 CreateRoute` calls on existing service
   `su4f9ugsggenk65g7f7m5` for `/.well-known/*` and `/oauth/*`; existing
   `/mcp`, `/v1/*`, and `/api/*` routes remain on their current upstreams.
10. Authenticated OpenConnector management API writes for one
    IdentityProviderConfig and the minimum AccessGrants required for the two
    test groups. The revocation test temporarily revokes and then restores only
    a test grant.

Before any write, resolve all command schemas from the Volcengine OpenAPI
catalog and run supported dry-run checks. Never print response fields
containing passwords, client secrets, tokens, API keys, or connection
credentials.

The persisted IdentityProviderConfig must use:

```json
{
  "issuer": "<discovered UserPool issuer>",
  "audience": "<aud from a real user Access Token>",
  "jwksUri": "<discovered JWKS URI>",
  "userPoolRef": "<UserPool UID>",
  "subjectClaim": "sub",
  "groupsClaim": "identity_userpool_group_uids",
  "tenantClaim": "<verified stable tenant claim, when present>",
  "tenant": "<verified claim value, otherwise omit both fields>",
  "allowedClientIds": ["<OAuth client UID>"],
  "tokenTypeClaim": "typ",
  "tokenType": "access_token",
  "requireGroupsClaim": true,
  "requireNbf": true,
  "requireUserPoolRefInIssuer": true
}
```

The audience and tenant claim are deliberately not guessed. They are recorded
only after decoding the claims of a real Access Token locally without logging
or persisting the token. Cross-UserPool rejection remains mandatory through
the exact issuer plus `requireUserPoolRefInIssuer`.
