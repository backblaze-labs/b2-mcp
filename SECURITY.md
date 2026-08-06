# Security Policy

Security-response owner: Backblaze Security. Repository security-review owners:
Gonza (`@goanpeca`) and Sophie / Quality Keeper (QK) (`@sophiecarreras`).

## Supported Versions

The latest minor version on `main` is supported. Earlier releases are not
patched in place — upgrade to the latest version to receive fixes.

## Reporting a Vulnerability

**Do not file a public GitHub issue for a security vulnerability.**

Instead, report it privately via GitHub Security Advisories:

1. Go to the [Security tab](https://github.com/backblaze-labs/b2-mcp/security/advisories/new) of this repository
2. Click **Report a vulnerability**
3. Provide a clear description, reproduction steps, and impact assessment

You can also email **security@backblaze.com** if you cannot use GitHub
Security Advisories.

## What to expect

- Acknowledgement within 3 business days
- Initial assessment within 7 business days
- Coordinated disclosure once a fix is available

## Scope

In scope:

- Authentication, authorization, or credential-handling flaws in the MCP
  server itself
- Code execution, SSRF, or denial-of-service vulnerabilities reachable via
  the documented MCP transport surface
- Exposure of Backblaze application keys, tokens, or session state to
  unauthorized callers

Out of scope:

- Vulnerabilities in the Backblaze B2 service itself — report those to
  Backblaze directly
- Self-hosted deployment misconfigurations (missing TLS, weak nginx config,
  exposed credentials in environment) — see [`docs/DEPLOY.md`](docs/DEPLOY.md)
  for recommended hardening
- Issues requiring root or local access on the machine running the server

## MCP Secret Output Policy

Default MCP tools must not return durable B2 secrets. Operations that create
one-time application-key material, including `b2_create_key`,
`b2_create_group_member`, and `b2_reserve_trial_create_account`, are not
registered until a reviewed out-of-band secret sink exists. Tool responses,
structured logs, thrown errors, snapshots, and CI artifacts are covered by a
central sanitizer that redacts known B2 credential, authorization-token, upload
token, notification signing-secret, and secret-header fields.

Structured successful tool results use `structuredContent` as the canonical
sanitized JSON value. The LLM-facing text block may be TOON or compact JSON, but
it is generated only after the same sanitization and tool-specific result bounds
have run. TOON is not a protocol content type and must not be used to bypass
JSON validation, redaction, or output-size controls.

TOON serialization does not execute third-party package code in the
credential-bearing server process. The runtime encoder is reviewed
repository-owned code for TOON spec `4.1`; `@toon-format/toon@4.1.0` is retained
only as a dev/test decoder oracle. TOON mode is preflighted during config
validation and falls back to compact JSON for bounded encode failures, so an
optional text optimization must not turn a successful structured tool result
into a failed B2 operation.

Presigned S3 URLs are short-lived bearer capabilities, not durable B2
application keys. Tools may return them only with operation and expiry metadata;
operators and clients must treat the URL as sensitive until `expiresAt`.

## SDK Credential Trust Boundary

`@backblaze-labs/b2-sdk` is inside the credential trust boundary: it receives
the plaintext B2 application key, performs `b2_authorize_account`, stores the
current authorization response in its `AccountInfo`, owns URL-guarded transport
requests, and retries expired-token or transient upstream failures. The server
therefore pins the SDK to an exact reviewed version in `package.json`, verifies
the package-lock integrity hash in tests, and treats every SDK version bump as a
security-reviewed dependency change rather than an automated floating update.

## npm Supply-Chain Incident Response

Lifecycle scripts are disabled for normal installs via `.npmrc`, and
`npm run audit:supply-chain` runs the repository denylist gate before the live
npm advisory audit. The denylist gate blocks the checked-in keyv/cacheable IOC
snapshot, quarantined namespaces, known malicious payload hashes, missing
lockfile integrity, and unexpected package lifecycle scripts from issue #89.

If a denied package or IOC is found, treat the host as compromised, rebuild it
from a clean image, revoke reachable GitHub/npm/cloud/CI credentials, revoke any
reachable B2 application keys, and audit source control plus npm publishing
history before restoring automation. The full runbook is
[`docs/SUPPLY_CHAIN_SECURITY.md`](docs/SUPPLY_CHAIN_SECURITY.md).
