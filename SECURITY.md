# Security Policy

Security-response owner: Backblaze Security. Repository security-review owners:
Gonza (`@goanpeca`) and Sophie / Quality Keeper (QK) (`@sophiecarreras`).

## Supported Versions

The latest minor version on `main` is supported. Earlier releases are not
patched in place — upgrade to the latest version to receive fixes.

## Reporting a Vulnerability

**Do not file a public GitHub issue for a security vulnerability.**

Instead, report it privately via GitHub Security Advisories:

1. Go to the [Security tab](../../security/advisories) of this repository
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

Presigned S3 URLs are short-lived bearer capabilities, not durable B2
application keys. Tools may return them only with operation and expiry metadata;
operators and clients must treat the URL as sensitive until `expiresAt`.
