# Contributing

Thanks for your interest in the Backblaze B2 MCP Server. This document covers how
to set up, test, and submit changes.

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Development setup

The package engine range is `^22.22.2 || ^24 || ^26`: it preserves the official
B2 SDK's Node 22.3.0 baseline, raised to a 22.22.2 floor, and excludes Node.js lines outside opossum's supported
range. For local development and deployed 22.x hosts, use the patched Node 22
LTS release pinned in `.nvmrc` (`22.23.1` at the time of writing) or a later
patched 22.x release. CI runs the full toolchain on Node.js 22.23.1, 24, and 26.

```bash
corepack enable pnpm
corepack prepare 'pnpm@11.20.0+sha256.34e198cb1e43237517ecedfd31f9ae26a6c0a3e5366ce58a2d05f4b21fb5f19a' --activate
pnpm install --frozen-lockfile
pnpm run build        # clean + tsc → dist/
pnpm test             # typecheck, then fast unit suite
pnpm run verify       # fast no-credential quality gate
pnpm run lint         # Biome lint for src/, tests/, and scripts/
pnpm run format:check # checks Biome-supported formatting
pnpm run lint:docs    # Markdown policy and secret-scan lockdown for docs
pnpm run lint:links   # local Markdown link validation
pnpm run spell        # cspell with the central .cspell/project-words.txt dictionary
```

For the version/build-pinned conda bootstrap:

```bash
mamba env create -f environment.yml
mamba run -n b2-mcp node --version
mamba run -n b2-mcp pnpm install --frozen-lockfile
```

Live tests need real B2 credentials and are not run in the default suite. Use
`pnpm run test:live:b2-integration` for live integration behavior and
`pnpm run test:live:b2-contract` for live request-shape checks; both require
`B2_APPLICATION_KEY_ID` and `B2_APPLICATION_KEY`. The required GitHub
Environment secrets, buckets, and key capabilities are documented in
[`docs/TESTING.md#live-and-integration-test-credentials`](./docs/TESTING.md#live-and-integration-test-credentials).

Biome is the sole formatter in this repository. The `format` and `format:check`
scripts intentionally cover Biome-supported file types; Markdown and YAML files
are outside the automated formatting gate.

Test files must follow the layer suffix convention documented in
[`docs/TESTING.md`](./docs/TESTING.md): `*.unit.test.ts`,
`*.contract.test.ts`, `*.modern-protocol.test.ts`, `*.legacy-protocol.test.ts`,
`*.slow.test.ts`, `*.package.test.ts`, `*.integration.live.test.ts`, or
`*.contract.live.test.ts`.

## Verification layers

Use the smallest layer that covers the risk, then run the aggregate gate before
opening a PR when practical:

| Layer | Command | What it proves |
| --- | --- | --- |
| Typecheck | `pnpm run typecheck` | Source and tests compile against the conservative `@types/node` 22.3.0 baseline (below the 22.22.2 engine floor; see the note near the end of this guide). |
| Unit | `pnpm run test:unit` | Fast isolated behavior for handlers, config, adapters, sanitizer, CLI, and utilities. |
| Contract | `pnpm run test:contract` | Public docs, package surface, tool profiles, workflow policy, schema drift, and support claims stay synchronized. |
| Protocol modern | `pnpm run test:protocol:modern` | MCP `2026-07-28` HTTP and stdio behavior, including stateless POST serving. |
| Protocol legacy | `pnpm run test:protocol:legacy` | Explicit SDK v2 stateless compatibility for supported 2025-era clients. |
| Protocol all | `pnpm run test:protocol` | Build plus both protocol layers. |
| Package | `pnpm run test:package` | Packed artifact install, exports, bins, and smoke behavior as a consumer sees them. |
| Slow | `pnpm run test:slow` | Higher-cost deterministic lifecycle and compiled-output checks. |
| Coverage | `pnpm run test:coverage` | Source-covering deterministic suites and coverage floors. |
| Diagnostics | `pnpm run test:diagnostics` | Open-handle and MaxListeners cleanup evidence. |
| Docs lint | `pnpm run lint:docs` | Markdown-policy lockdown and local checkout credential detection. |
| Link lint | `pnpm run lint:links` | Local Markdown links resolve inside the repository. |
| Spell | `pnpm run spell` | Spelling with the central project dictionary. |
| Skills | `pnpm run validate:skills` | Bundled skill pack structure, tool references, and byte-path rules. |
| Package budget | `pnpm run check:package-budget` | Runtime dependencies, npm provenance, package footprint, and SDK/AWS adapter boundaries. |
| Supply chain | `pnpm run audit:supply-chain` | Denylist, lifecycle-script, lockfile, and npm advisory policy. |
| Production audit | `pnpm run audit:production` | npm production advisory gate for published runtime dependencies. |
| Client smoke | `pnpm run smoke:client` | Built artifact can serve a no-credential MCP client smoke. |
| Inspector smoke | `pnpm run smoke:inspector` | Locked MCP Inspector CLI can inspect the built stdio server. |

`pnpm run verify` is the fast no-credential CI-style gate: typecheck, build,
lint, docs lint, link lint, skill validation, format check, spelling, and
diagnostics. It intentionally does not run live B2 tests or the full package,
protocol, coverage, slow, and supply-chain layers; add those when your change
touches the corresponding contract.

## Pull requests

- Branch off `main`; keep changes focused.
- `pnpm run verify` must pass before opening a PR. CI runs deterministic
  coverage, slow lifecycle, and production dependency audit evidence on Node.js
  22.23.1, 24, and 26, runs a patched Node 22 LTS cross-platform suite, and
  exercises the advertised Node.js 22.22.2 engine floor with a packed-package
  smoke. Package-install evidence is a separate required gate.
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

## Dependencies and production audit

Production dependencies ship in `dist/`, and development dependencies run in
CI, so review the full lockfile with `pnpm run audit:supply-chain` before
release. `audit-policy.json` holds narrow, expiring exceptions for known
upstream advisories; the current policy has no exceptions. CI also runs
`pnpm run audit:production`, which derives an npm audit lock from the committed
`pnpm-lock.yaml` and gates on `npm audit --omit=dev --audit-level=moderate`.
That gate currently reports no production vulnerabilities. Do not add untracked
moderate, high, or critical production findings, and do not add untracked high
or critical development-toolchain findings.

To check the production npm audit gate locally:

```bash
pnpm run audit:production
```

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
integrity, or AWS import outside the repository-owned
`src/s3/aws-sdk-adapter.ts` boundary. The clean consumer install is measured
from the committed production lock graph, not from lockfile-less semver
resolution.

To intentionally raise the budget, update `package-budget.json` in the same PR,
include the reason, policy, reviewed version, resolved URL, integrity, and owner
for any new direct dependency, link the upstream SDK gap or architecture
decision for adapter-scoped dependencies, run the package-budget check, and call
out the metric delta in the PR. Do not add compatibility packages for Node.js
18/20, browsers, Bun, Deno, HTTP, stream, abort, retry, or schema wrapping when
Node 22+ built-ins, the MCP server package, or public B2 SDK exports cover the
need.

`@backblaze-labs/b2-sdk` bumps require the complete SDK/MCP no-credential
contract before review: `pnpm run test:contract`, `pnpm run test:protocol`,
`pnpm run test:package`, `pnpm run check:package-budget`, and
`pnpm run audit:supply-chain`. The live contract suite must pass before release
accepts the SDK upgrade.

`@types/node` is pinned to a conservative 22.3.0 baseline (below the 22.22.2 engine floor; @types/node has no 22.22.x release) so TypeScript does not allow
newer Node standard-library APIs that would fail for minimum-supported
consumers. Node 24 and 26 remain covered by execution tests in CI.

## Reporting security issues

Do not open public issues for security vulnerabilities. Follow the process in
[SECURITY.md](./SECURITY.md).
