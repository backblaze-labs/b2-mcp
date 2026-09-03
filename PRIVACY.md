# Privacy Policy

Effective date: September 2, 2026

This policy covers the `@backblaze-labs/b2-mcp` server software published from
the [backblaze-labs/b2-mcp](https://github.com/backblaze-labs/b2-mcp)
repository. The software runs either locally for a user over stdio or in a
self-hosted Streamable HTTP deployment operated by the user or their
organization. Backblaze Labs publishes the software, source code, npm package,
and container image; it does not operate a shared hosted b2-mcp service that
collects end-user data by default.

## Data Controller And Operator

For a local stdio run, the user running the MCP client controls the server
process and the data it handles. For a self-hosted HTTP deployment, the
deployment operator controls the server process, its logs, credential storage,
network boundary, and retention settings.

The publisher does not receive runtime credentials, object data, logs, prompts,
tool inputs, tool outputs, account metadata, or telemetry from normal b2-mcp
use. If you choose to contact the project through GitHub issues, pull requests,
GitHub Security Advisories, or email, the information you provide is used to
respond to that request and is handled by the service you used to send it. Do
not include B2 credentials, bearer tokens, presigned URLs, or other secrets in
public issues or discussions.

## B2 Credentials

b2-mcp uses Backblaze B2 application keys and, for Partner API tools only,
optional master keys to authenticate to Backblaze B2 on your behalf.

- In local stdio mode, credentials are supplied by your MCP client configuration
  or process environment. Credential custody stays on your machine except when
  the server sends them to Backblaze B2 to authorize or perform requested B2
  operations.
- In HTTP `headers` mode, credentials arrive in request headers, are consumed by
  the credential resolver, and are stripped before the request crosses into the
  MCP SDK handler boundary. The running process may keep them in a cached
  credential and authorization manager until cache eviction, TTL expiry, or
  process exit.
- In HTTP `server` mode, credentials come from the operator-managed server
  environment or secret store and stay inside the operator's deployment except
  for outbound calls to Backblaze B2.
- In HTTP `principal` mode, verified caller identity is mapped to
  operator-managed B2 credentials, which stay inside the operator's deployment
  except for outbound calls to Backblaze B2.

Credentials supplied to authenticate b2-mcp HTTP requests are not written to
disk by the HTTP transport. The HTTP transport keeps bounded, TTL-limited
in-memory credential managers, B2 authorization state, and capability state for
the running process. Raw credential values can therefore remain in process
memory after a request until cache eviction, TTL expiry, or process exit, but
cache keys and logs use non-secret fingerprints rather than raw credential
values. B2 credentials are sent only to Backblaze B2 API endpoints needed to
authorize or perform the requested operation. They are never collected, sold, or
transmitted to the publisher.

Generated application-key secrets from `b2_create_key` are handled separately by
the durable secret sink. In local stdio mode on supported POSIX systems, the
default sink is `file`, which writes newly created application-key secrets to
`~/.b2-mcp/secrets.jsonl` unless configured differently. In HTTP and serverless
deployments, the default sink is `off` and the tool returns a compatibility
stub unless the operator explicitly enables a sink mode. If an operator enables
`B2_SECRET_SINK=file` for HTTP or serverless, b2-mcp writes newly created
application-key secrets to the configured operator-controlled JSONL file.

An operator may instead set `B2_SECRET_SINK=inline`, which is the least private
option: it returns the newly generated secret directly in the tool's MCP
response, so the secret enters the model's context and may be retained by your
MCP client. Because of that exposure it is never a default and is refused on
HTTP or serverless deployments unless the operator also sets
`B2_ALLOW_INLINE_SECRETS=true`. The same `file`, `off`, and `inline` sink
behavior governs every credential-producing tool, including the Partner API
tools `b2_create_group_member` and `b2_reserve_trial_create_account`, not just
`b2_create_key`.

## Object Data

b2-mcp is designed as a control-plane-first server. For ordinary object upload,
download, and multipart transfer workflows, the server returns short-lived
presigned URLs and the object bytes move directly between your client or worker
and Backblaze B2. In those presigned workflows, object bytes do not pass through
the b2-mcp server or the model context.

The inline `s3_put_object` tool and response-inline `s3_get_object` reads are
exceptions: they pass object bytes through the b2-mcp process and are bounded to
small control-plane objects of 1 MiB or less for manifests, sidecars, and tiny
configuration files. When local filesystem access is enabled, `s3_get_object`
can also stream a requested object through the b2-mcp process to the configured
`saveToPath` without buffering the full object in memory or returning it to the
model context. HTTP transport disables local-file access by default and requires
an operator-configured filesystem sandbox to enable it. Use presigned URL or
multipart workflows for ordinary object data and bulk transfers.

## Logs

b2-mcp emits structured logs for the local user or deployment operator. Logs are
written to stderr by default or to the operator-selected `B2_LOG_FILE` path.
They are not sent to the publisher.

Log records are passed through the repository's secret-redaction layer. B2
application keys, master keys, authorization tokens, bearer tokens, presigned
URLs, notification signing secrets, custom secret headers, and request bodies
are not intentionally logged. Operators who export or ship logs to another
system are responsible for that system's privacy, access, and retention policy.

## Analytics, Telemetry, And Tracking

b2-mcp does not include analytics, telemetry, advertising pixels, tracking
cookies, crash reporting, or phone-home behavior. Routine outbound request
metadata added by the software is limited to User-Agent metadata sent to
Backblaze B2: the product token, such as `b2-mcp/<version>` for published
releases or `b2-mcp/dev` for source and development builds; the active transport
label, such as `stdio` or `http`; optional S3 tool-surface labels; and, if an
operator sets `B2_MCP_UA_SUFFIX`, that operator-supplied deployment tag.

## Third Parties

Runtime B2 API requests go to Backblaze B2. Backblaze's handling of B2 account
information and stored files is governed by the
[Backblaze Privacy Policy](https://www.backblaze.com/company/policy/privacy)
and the terms for the Backblaze services you use.

For self-hosted HTTP deployments, your chosen hosting provider, proxy,
identity provider, log sink, or monitoring system may process deployment data
according to your configuration and their own policies. The publisher does not
control those systems.

## Data Retention

The publisher does not retain runtime data from b2-mcp because it does not
receive it. Local users and HTTP deployment operators control retention for
their client configuration, process environment, logs, secret stores, generated
presigned URLs until expiry, and any local secret-sink files they enable.
Backblaze B2 retains account data and stored objects according to your
Backblaze account configuration and Backblaze's policies.

Process-local authorization and capability caches expire automatically and are
lost when the server process exits.

## Children

b2-mcp is developer and infrastructure software. It is not directed to children,
and the publisher does not knowingly collect personal information from children
through b2-mcp.

## Security And Contact

For private security reports, use the process in [SECURITY.md](SECURITY.md).
For non-sensitive privacy questions about this project, open a GitHub issue at
[backblaze-labs/b2-mcp](https://github.com/backblaze-labs/b2-mcp/issues).

## Changes To This Policy

Material changes to this policy will be made in this repository and published
with the project documentation. The effective date above will be updated when
the policy changes.
