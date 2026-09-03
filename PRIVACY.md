# Privacy Policy

Effective date: September 3, 2026

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
  or process environment and stay on your machine.
- In HTTP `headers` mode, credentials arrive in request headers, are consumed by
  the credential resolver, and are stripped before the request crosses into the
  MCP SDK handler boundary.
- In HTTP `server` mode, credentials come from the operator-managed server
  environment or secret store.
- In HTTP `principal` mode, verified caller identity is mapped to
  operator-managed B2 credentials.

Credentials are not persisted by b2-mcp in HTTP mode. The HTTP transport keeps
only bounded, TTL-limited in-memory capability and authorization state for the
running process, keyed and logged with non-secret fingerprints rather than raw
credential values. B2 credentials are sent only to Backblaze B2 API endpoints
needed to perform the requested operation. They are never collected, sold, or
transmitted to the publisher.

## Object Data

b2-mcp is designed as a control-plane-first server. For ordinary object upload,
download, and multipart transfer workflows, the server returns short-lived
presigned URLs and the object bytes move directly between your client or worker
and Backblaze B2. Those bytes do not pass through the b2-mcp server or the model
context.

The inline `s3_put_object` and `s3_get_object` tools are bounded to small
control-plane objects of 1 MiB or less for manifests, sidecars, and tiny
configuration files. Use presigned URL or multipart workflows for real object
data and bulk transfers.

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
cookies, crash reporting, or phone-home behavior. The only routine outbound
identifier added by the software is the User-Agent product token sent to
Backblaze B2, such as `b2-mcp/<version>` for published releases or `b2-mcp/dev`
for source and development builds. If an operator sets `B2_MCP_UA_SUFFIX`, that
operator-supplied deployment tag is appended to the same outbound User-Agent.

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
