# Contributing

Thanks for your interest in the Backblaze B2 MCP Server. This document covers how
to set up, test, and submit changes.

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Development setup

The package engine floor is `>=22.3.0` because it matches the official B2 SDK.
For local development and deployed 22.x hosts, use the patched Node 22 LTS
release pinned in `.nvmrc` (`22.23.1` at the time of writing) or a later patched
22.x release. CI keeps a Linux `22.3.0` leg only as minimum-floor evidence and
also covers Node.js 24 and 26.

```bash
npm ci
npm run build        # clean + tsc → dist/
npm test             # typecheck via pretest, then fast unit suite
npm run verify       # full no-credential local gate
npm run lint         # eslint src tests
npm run format:check # prettier
```

For the version/build-pinned conda bootstrap:

```bash
mamba env create -f environment.yml
mamba run -n b2-mcp node --version
mamba run -n b2-mcp npm ci
```

Live tests need real B2 credentials and are not run in the default suite. Use
`npm run test:integration:live` for live integration behavior and
`npm run test:contract:live` for live request-shape checks; both require
`B2_APPLICATION_KEY_ID` and `B2_APPLICATION_KEY`.

Test files must follow the layer suffix convention documented in
[`docs/TESTING.md`](./docs/TESTING.md): `*.unit.test.ts`,
`*.contract.test.ts`, `*.modern-protocol.test.ts`, `*.legacy-protocol.test.ts`,
`*.slow.test.ts`, `*.package.test.ts`, `*.integration.live.test.ts`, or
`*.contract.live.test.ts`.

## Pull requests

- Branch off `main`; keep changes focused.
- `npm run verify` must pass before opening a PR. CI runs the bundled
  deterministic coverage and slow layers on Node.js 22.3.0, 24, and 26, plus a
  patched Node 22 LTS cross-platform suite. A separate package-install job stays
  off the deploy-gating path.
- Add or update unit tests for any behavior change. New tools need a schema entry
  in `tests/contract/tools-schema.contract.test.ts` and at least one handler test.
- Update `CHANGELOG.md` under the appropriate heading.

## Safety requirements for new tools

This server is built for an untrusted (possibly prompt-injected) caller, so new
tools must respect the existing guardrails:

- **Any irreversible or protection-removing action must be wired to the
  destructive-operation gate** (`src/utils/destructive-gate.ts`): add a detector
  and call `checkDestructive(...)` at the top of the handler, returning
  `toolError` when `!ok`. Add gate coverage to `tests/unit/destructive-gate.unit.test.ts`.
- **Bulk object data must not flow through the server.** Use presigned URLs for
  uploads and downloads; the inline object paths are capped at 1 MiB for small
  control-plane payloads only.
- **Never log credentials, tokens, presigned URLs, or signing secrets**, and
  redact any secret a B2 response echoes back before returning it to the model.

## Dependencies and `npm audit`

Production dependencies ship in `dist/`, and development dependencies run in
CI, so review the full lockfile with `npm run audit:supply-chain` before
release. `audit-policy.json` holds narrow, expiring exceptions for known
upstream advisories, including the current moderate `@hono/node-server` finding
from stable MCP SDK v2. Do not add untracked high or critical production or
development-toolchain findings.

`@types/node` intentionally tracks Node 26 for forward-compatibility review,
while the runtime floor remains `>=22.3.0`. Source code must stay compatible
with the floor; the Node 22.3.0 CI leg builds and runs the deterministic suite
as the runtime backstop for APIs that TypeScript 26 types would otherwise allow.

## Reporting security issues

Do not open public issues for security vulnerabilities. Follow the process in
[SECURITY.md](./SECURITY.md).
