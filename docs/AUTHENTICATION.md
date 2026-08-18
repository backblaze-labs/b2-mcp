# Authentication And Credential Custody

This document is the public contract for caller authentication, B2 credential
custody, and MCP OAuth behavior in b2-mcp.

## Boundary Summary

b2-mcp is an MCP resource server and B2 tool server. It is not an OAuth
authorization server, not a Backblaze-managed credential broker, and not a
hosted multi-tenant control plane.

Caller authentication for OAuth-enabled hosted adapters is performed by the
customer-operated edge, adapter, or resource-server layer before B2 credential
resolution. The standalone Node HTTP entry point (`b2-mcp --transport http` and
`startHttp()`) does not authenticate callers by itself; with
`B2_HTTP_CREDENTIAL_MODE` unset it uses `headers` compatibility mode and expects
B2 credential headers on each request. Do not expose that endpoint without TLS,
host/origin allowlists, and a separate caller-authentication boundary. For the
built-in hosted adapters, `src/oauth-resource-server.ts` validates the bearer
token and passes verified MCP `authInfo` into the shared request pipeline. The
published package does not expose a semver-managed Node HTTP embedding API;
custom deployments should use the documented hosted adapter boundary or
maintain their own source-level adapter that only forwards `authInfo` after
caller authentication.

B2 credential custody is separate from MCP OAuth. OAuth proves who may call the
MCP endpoint. B2 application keys are then selected by one of the credential
modes below and are never ordinary MCP tool arguments.

## Credential Modes

| Mode | Transport | Who holds B2 credentials | Current use |
| --- | --- | --- | --- |
| `stdio-env` | stdio | Local client process environment | Local single-user desktop and IDE use. |
| `headers` | HTTP | MCP client or bridge request headers | Unset runtime default for one-release compatibility. Treat B2 headers as durable secrets in proxies, logs, APM, and fixtures. |
| `server` | HTTP | Customer-operated server process or provider secret store | Recommended explicit single-tenant hosted mode. Clients send no B2 key. |
| `principal` | HTTP | Customer secret broker selected by verified MCP principal | Multi-principal hosted mode. Clients send no B2 key. |

`server` and `principal` reject public B2 credential headers. `principal`
requires verified `authInfo`, derives a stable principal from `iss#sub` or an
equivalent verified introspection `subject` or `principal` claim, looks it up in
`B2_PRINCIPAL_CREDENTIAL_MAP`, and resolves the matching
`B2_CREDENTIAL_<REF>_*` environment-backed secret.

## Credential Flow Diagrams

### Stdio

```text
MCP desktop/IDE client
  | spawns b2-mcp with env
  v
b2-mcp stdio entrypoint
  | reads B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY
  v
B2 SDK and AWS S3 SDK adapters
  | authorized B2/S3 requests
  v
Backblaze B2
```

The local MCP client configuration contains the B2 key. This is intended only
for trusted local use.

### HTTP Server-Side Credentials

```text
MCP client
  | HTTPS + OAuth bearer token, no B2 key
  v
Customer edge or hosted adapter
  | validates caller and attaches verified authInfo
  v
b2-mcp shared HTTP pipeline
  | B2_HTTP_CREDENTIAL_MODE=server
  | reads provider-held B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY
  v
B2 SDK and AWS S3 SDK adapters
  v
Backblaze B2
```

This is the recommended hosted shape for new single-tenant deployments, but it
must be selected explicitly with `B2_HTTP_CREDENTIAL_MODE=server`. OAuth scopes,
B2 key capabilities, and tool-profile filtering are cumulative restrictions.

### HTTP Client-Supplied Credential Compatibility

```text
MCP client or bridge
  | HTTPS with X-B2-MCP-Key-Id and X-B2-MCP-Key headers
  v
b2-mcp shared HTTP pipeline
  | B2_HTTP_CREDENTIAL_MODE=headers
  | consumes headers before the SDK handler boundary
  v
B2 SDK and AWS S3 SDK adapters
  v
Backblaze B2
```

This compatibility mode keeps existing hosted clients working for one release
and is the runtime default when `B2_HTTP_CREDENTIAL_MODE` is unset, but it puts
durable B2 secrets in every HTTP request. New hosted deployments should set
`B2_HTTP_CREDENTIAL_MODE=server` or `principal`.

## MCP OAuth Resource Server

The hosted resource-server implementation supports MCP `2026-07-28` OAuth
Protected Resource Metadata. Supported adapters expose:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server` where the adapter provides
  compatibility authorization-server metadata

Protected Resource Metadata is built from the configured resource URL, issuer,
authorization endpoint, token endpoint, optional introspection endpoint,
optional JWKS URI, service documentation URL, and supported scopes. Responses
are public metadata and are cacheable for a short period.

## OAuth Environment Reference

| Variable | Purpose |
| --- | --- |
| `B2_MCP_PUBLIC_URL` | Public MCP URL used to build metadata-route URLs. |
| `B2_MCP_SERVICE_DOCUMENTATION_URL` | Optional service documentation URL advertised in metadata. |
| `B2_OAUTH_ISSUER` | Trusted authorization-server issuer. |
| `B2_OAUTH_AUTHORIZATION_ENDPOINT` | Authorization endpoint advertised to clients. |
| `B2_OAUTH_TOKEN_ENDPOINT` | Token endpoint advertised to clients. |
| `B2_OAUTH_RESOURCE` | Exact protected resource identifier for this MCP deployment. |
| `B2_OAUTH_AUDIENCE` | Exact audience expected for this MCP deployment. |
| `B2_OAUTH_REQUIRED_SCOPES` | Additional scopes required beyond one `b2:*` deployment scope. |
| `B2_OAUTH_ALLOWED_SUBJECTS` | Optional comma-separated subject allowlist. Values may be `sub` or `issuer#sub`. |
| `B2_OAUTH_ALLOWED_TOKEN_TYPES` | Accepted token types when introspection returns `token_type`. |
| `B2_OAUTH_ALLOWED_ALGORITHMS` | Accepted introspection algorithm claims and JWKS algorithms. |
| `B2_OAUTH_INTROSPECTION_ENDPOINT` | RFC 7662 introspection endpoint for opaque or authoritative token checks. |
| `B2_OAUTH_INTROSPECTION_CLIENT_ID` | Client ID for authenticated introspection. |
| `B2_OAUTH_INTROSPECTION_CLIENT_SECRET` | Client secret for authenticated introspection. |
| `B2_OAUTH_INTROSPECTION_BEARER_TOKEN` | Bearer credential alternative for authenticated introspection. |
| `B2_OAUTH_INTROSPECTION_TIMEOUT_MS` | Per-attempt introspection timeout. |
| `B2_OAUTH_INTROSPECTION_RETRIES` | Introspection retry count. |
| `B2_OAUTH_INTROSPECTION_RETRY_DELAY_MS` | Delay between introspection retries. |
| `B2_OAUTH_INTROSPECTION_CIRCUIT_FAILURES` | Failure count before opening the introspection circuit. |
| `B2_OAUTH_INTROSPECTION_CIRCUIT_OPEN_MS` | Introspection circuit-open duration. |
| `B2_OAUTH_TOKEN_CACHE_MAX_ENTRIES` | Maximum verified-token cache entries. |
| `B2_OAUTH_TOKEN_CACHE_TTL_SECONDS` | Maximum verified-token cache TTL. |
| `B2_OAUTH_TOKEN_CACHE_SKEW_SECONDS` | Expiry skew subtracted from token cache lifetime. |
| `B2_OAUTH_INTROSPECTION_CACHE_MAX_ENTRIES` | Legacy alias for token cache max entries. |
| `B2_OAUTH_INTROSPECTION_CACHE_TTL_SECONDS` | Legacy alias for token cache TTL. |
| `B2_OAUTH_INTROSPECTION_CACHE_SKEW_SECONDS` | Legacy alias for token cache skew. |
| `B2_OAUTH_JWKS_URI` | JWKS URI for local JWT access-token verification. |
| `B2_OAUTH_ALLOWED_JWT_TYPES` | Accepted JWT header `typ` values. |
| `B2_OAUTH_JWKS_CACHE_TTL_SECONDS` | Maximum JWKS cache TTL. |
| `B2_OAUTH_JWKS_CACHE_MIN_TTL_SECONDS` | Minimum JWKS cache TTL floor. |
| `B2_OAUTH_JWKS_TIMEOUT_MS` | Per-attempt JWKS fetch timeout. |
| `B2_OAUTH_JWKS_RETRIES` | JWKS fetch retry count. |
| `B2_OAUTH_JWKS_RETRY_DELAY_MS` | Delay between JWKS retries. |
| `B2_OAUTH_JWKS_CIRCUIT_FAILURES` | Failure count before opening the JWKS circuit. |
| `B2_OAUTH_JWKS_CIRCUIT_OPEN_MS` | JWKS circuit-open duration. |
| `B2_OAUTH_JWKS_REFRESH_COOLDOWN_MS` | Cooldown before forced JWKS refresh for unknown `kid`. |
| `B2_OAUTH_JWT_CLOCK_SKEW_SECONDS` | Clock skew for JWT `exp`, `nbf`, and `iat`. |
| `B2_OAUTH_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL` | Local-test escape hatch for HTTP issuer and metadata URLs. Do not set in production. |
| `B2_OAUTH_DANGEROUSLY_ALLOW_UNAUTHENTICATED_INTROSPECTION` | Local-test escape hatch for unauthenticated introspection. Do not set in production. |

## Token Verification

Hosted OAuth verification accepts either RFC 7662 introspection or local JWT
verification through JWKS. If both are configured, introspection is
authoritative so revocation and opaque-token behavior stay available during
rollout.

The verifier fails closed unless the token satisfies the implemented checks:

- trusted `iss` exactly matches `B2_OAUTH_ISSUER`
- introspection `resource` exactly matches `B2_OAUTH_RESOURCE`
- introspection `aud` exactly matches `B2_OAUTH_AUDIENCE`
- JWT `aud` or `resource` binds to the configured deployment
- token is active and within `exp` / `nbf` / JWT `iat` windows
- token type is allowed when present
- token algorithm is allowed
- JWT header `typ` is accepted for access tokens
- JWT header `kid` selects a JWKS key for local verification
- scopes include at least one of `b2:read`, `b2:write`, or `b2:admin`
- scopes include every value in `B2_OAUTH_REQUIRED_SCOPES`
- subject matches `B2_OAUTH_ALLOWED_SUBJECTS` when configured

Authentication failures return a bearer challenge with the protected-resource
metadata URL. Missing required scopes produce an insufficient-scope challenge;
callers must obtain a token with the requested scope set from their
authorization server.

## Client ID Metadata Documents

b2-mcp does not implement Dynamic Client Registration and does not issue client
credentials. If an MCP client and authorization server use Client ID Metadata
Documents, that exchange belongs to the customer authorization-server boundary.
b2-mcp advertises the resource-server metadata and validates the resulting
access token; it does not trust client metadata as authorization to use B2.

## Durable Secrets And Presigned URLs

Default MCP tools must not return durable B2 secrets. `b2_create_key`,
`b2_create_group_member`, and `b2_reserve_trial_create_account` are registered
only as non-secret unavailable compatibility stubs until a reviewed
out-of-band secret sink exists. Issue #186 will revise this invariant when a
sink-backed profile lands.

Presigned S3 URLs are different. `s3_get_presigned_url` and
`s3_presign_upload_part` may return short-lived bearer URLs with operation and
expiry metadata. Treat the URL as sensitive until `expiresAt`, but it is not a
long-lived B2 application key.

## Destructive Actions And Overwrites

`B2_DESTRUCTIVE_POLICY=confirm` is defense in depth, not authorization. A model
or compromised client can satisfy `confirm: true`, and MCP elicitation responses
are relayed by the client. Internet-facing HTTP deployments should use
`B2_DESTRUCTIVE_POLICY=block` unless a separate trusted interactive boundary has
been reviewed.

Explicit deletes use delete APIs such as `s3_delete_object`,
`s3_delete_objects`, `b2_delete_bucket`, and `b2_delete_key`.
Replacing an unversioned object is an overwrite-capable write: `s3_put_object`,
a presigned `PutObject` URL, multipart completion, or server-side copy can
still make the previous current object inaccessible through ordinary reads even
when the operation is not named "delete".

## Modern And Legacy Protocol Behavior

The modern HTTP path targets MCP `2026-07-28` through `createMcpHandler` and
POST requests to `/mcp`. HTTP serving is stateless: no modern sessions,
`Mcp-Session-Id`, GET event streams, DELETE session termination, or event replay
are part of the production contract. Caller cancellation is propagated through
request abort signals, and only an allowlisted MCP/header set reaches the SDK
handler after credential resolution.

Legacy `2025-03-26` and `2025-06-18` clients are supported only through the SDK
v2 explicit stateless compatibility path. `initialize` and
`notifications/initialized` are compatibility behavior, not a production
dependency on the monolithic v1 SDK.

Roots, Sampling, MCP Logging, Dynamic Client Registration, HTTP+SSE, Tasks,
MCP Apps, list-change subscriptions, and protocol-level sessions are
intentionally not implemented for Phase 1.
