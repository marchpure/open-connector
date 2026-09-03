# Error envelope

All versioned REST APIs return:

```json
{
  "error": {
    "code": "ACCESS_DENIED",
    "message": "The requested action is not available to this identity.",
    "retryable": false,
    "details": {}
  },
  "meta": {
    "request_id": "req_01..."
  }
}
```

`details` is optional and must be safe for the caller. It must not reveal
tokens, credentials, stack traces, cross-tenant object existence, or hidden
grant data. HTTP status and stable error code carry machine meaning; `message`
is explanatory and may evolve.

| HTTP | Code                            | Retryable | Meaning                                                                      |
| ---- | ------------------------------- | --------- | ---------------------------------------------------------------------------- |
| 400  | `INVALID_ARGUMENT`              | no        | Request failed schema or semantic validation                                 |
| 401  | `AUTHENTICATION_REQUIRED`       | no        | Bearer token missing                                                         |
| 401  | `TOKEN_INVALID`                 | no        | Signature, issuer, audience, expiry, not-before, or claims invalid           |
| 401  | `JWKS_UNAVAILABLE`              | yes       | Controlled refresh failed and validation could not complete                  |
| 403  | `TENANT_MISMATCH`               | no        | Token tenant does not equal request tenant                                   |
| 403  | `ACCESS_DENIED`                 | no        | No allow, explicit deny, disabled connection/Action, or native source denial |
| 404  | `NOT_FOUND`                     | no        | Object is absent or intentionally hidden across tenant boundaries            |
| 409  | `VERSION_CONFLICT`              | yes       | Optimistic-lock version is stale                                             |
| 409  | `GRANT_CONFLICT`                | no        | Grant set is contradictory or duplicates a unique active grant               |
| 422  | `IDENTITY_PROVIDER_INVALID`     | no        | Identity provider configuration cannot validate                              |
| 424  | `IDENTITY_PROVIDER_UNAVAILABLE` | yes       | UserPool/JWKS dependency is temporarily unavailable                          |
| 429  | `RATE_LIMITED`                  | yes       | Edge or service limit                                                        |
| 500  | `INTERNAL`                      | yes       | Redacted internal failure                                                    |
| 503  | `NOT_READY`                     | yes       | Required state store, Provider, Identity, or JWKS dependency is not ready    |

Success responses use:

```json
{
  "data": {},
  "meta": {
    "request_id": "req_01..."
  }
}
```

MCP `POST /mcp` follows MCP Streamable HTTP and JSON-RPC error rules rather
than wrapping protocol frames in the REST envelope. HTTP authentication errors
occur before MCP initialization and use the REST envelope. MCP method errors
must preserve the same stable code in safe structured error data and the same
request ID in response metadata and audit records.

Mutations accept `Idempotency-Key`. Updates and revoke requests require the
current `version`; stale versions return `VERSION_CONFLICT`.
