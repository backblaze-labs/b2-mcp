# Security Policy

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
