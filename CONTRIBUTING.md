# Contributing

Thanks for your interest in the Backblaze B2 MCP Server. This document covers how
to set up, test, and submit changes.

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Development setup

The package engine floor is `>=22.3.0` because it matches the official B2 SDK.
For local development and deployed 22.x hosts, use the patched Node 22 LTS
release pinned in `.nvmrc` (`22.23.1` at the time of writing) or a later patched
22.x release. CI verifies the production dependency graph at Node 22.3.0 and
runs the full toolchain on Node.js 22.23.1, 24, and 26.

```bash
corepack enable pnpm
corepack prepare 'pnpm@11.20.0+sha256.34e198cb1e43237517ecedfd31f9ae26a6c0a3e5366ce58a2d05f4b21fb5f19a' --activate
pnpm install --frozen-lockfile
pnpm run build        # clean + tsc → dist/
pnpm test             # typecheck, then fast unit suite
pnpm run verify       # full no-credential local gate
pnpm run lint         # Biome lint for src/, tests/, and scripts/
pnpm run format:check # checks Biome-supported formatting
```

For the version/build-pinned conda bootstrap:

```bash
mamba env create -f environment.yml
mamba run -n b2-mcp node --version
mamba run -n b2-mcp pnpm install --frozen-lockfile
```

Live tests need real B2 credentials and are not run in the default suite. Use
`pnpm run test:integration:live` for live integration behavior and
`pnpm run test:contract:live` for live request-shape checks; both require
`B2_APPLICATION_KEY_ID` and `B2_APPLICATION_KEY`.

Biome is the sole formatter in this repository. The `format` and `format:check`
scripts intentionally cover Biome-supported file types; Markdown and YAML files
are outside the automated formatting gate.

Test files must follow the layer suffix convention documented in
[`docs/TESTING.md`](./docs/TESTING.md): `*.unit.test.ts`,
`*.contract.test.ts`, `*.modern-protocol.test.ts`, `*.legacy-protocol.test.ts`,
`*.slow.test.ts`, `*.package.test.ts`, `*.integration.live.test.ts`, or
`*.contract.live.test.ts`.

## Pull requests

- Branch off `main`; keep changes focused.
- `pnpm run verify` must pass before opening a PR. CI runs the bundled
  deterministic coverage and slow layers on Node.js 22.23.1, 24, and 26, checks
  production-only dependency installation at the Node.js 22.3.0 engine floor,
  and runs a patched Node 22 LTS cross-platform suite. A separate package-install
  job stays off the deploy-gating path.
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

## Dependencies and `pnpm audit`

Production dependencies ship in `dist/`, and development dependencies run in
CI, so review the full lockfile with `pnpm run audit:supply-chain` before
release. `audit-policy.json` holds narrow, expiring exceptions for known
upstream advisories; the current policy has no exceptions. Do not add untracked
high or critical production or development-toolchain findings.

Runtime dependency ownership and package footprint are gated by
`package-budget.json`:

```bash
pnpm run build
pnpm run check:package-budget
```

The budget records every direct production dependency from `dependencies` or
`optionalDependencies` and the approved limits for total production packages,
packed tarball size, unpacked package size, clean consumer install footprint,
and duplicate runtime package versions. CI and `prepublishOnly` reject an
unapproved direct dependency, Axios runtime import, SDK private/unpublished
import, Git/path SDK dependency, unpinned or provenance-mismatched direct
dependency, production lockfile entry without npm registry provenance and
integrity, or AWS import outside the temporary `src/s3/aws-sdk-adapter.ts`
boundary. The clean consumer install is measured from the committed production
lock graph, not from lockfile-less semver resolution.

To intentionally raise the budget, update `package-budget.json` in the same PR,
include the reason, policy, reviewed version, resolved URL, integrity, and owner
for any new direct dependency, link an upstream SDK gap for temporary adapters,
run the package-budget check, and call out the metric delta in the PR. Do not
add compatibility packages for Node.js 18/20, browsers, Bun, Deno, HTTP, stream,
abort, retry, or schema wrapping when Node 22+ built-ins, the MCP server
package, or public B2 SDK exports cover the need.

`@types/node` tracks the Node 22.3.0 runtime floor so TypeScript does not allow
newer Node standard-library APIs that would fail for minimum-supported
consumers. Node 24 and 26 remain covered by execution tests in CI.

## Reporting security issues

Do not open public issues for security vulnerabilities. Follow the process in
[SECURITY.md](./SECURITY.md).
