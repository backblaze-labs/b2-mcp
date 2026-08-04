# Testing And Quality Gates

Owner: Sophie / Quality Keeper (QK) (`@sophiecarreras`). Implementation owner: Gonza
(`@goanpeca`).

Status: active. Test selection is based on explicit filename suffixes, not broad
directory sweeps.

## Deterministic PR Gate

The PR gate must not require real B2 credentials. The complete local
no-credential gate is:

```bash
npm ci
npm run verify
```

`npm run verify` runs typecheck, build, lint, format check, deterministic
coverage, deterministic slow tests, and packed-package installation tests. The
individual deterministic layers are:

| Command                 | Layer                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `npm test`              | Typecheck via `pretest`, then `npm run test:unit`.                                   |
| `npm run test:unit`     | Fast source unit tests.                                                              |
| `npm run test:contract` | Deterministic MCP/package/schema/document/workflow contracts.                        |
| `npm run test:protocol` | Aggregate protocol gate (`test:protocol:modern` + `test:protocol:legacy`).           |
| `npm run test:slow`     | Deterministic high-cost lifecycle tests with explicit timeout and one Jest worker.   |
| `npm run test:package`  | Builds, packs, installs offline from npm cache, and verifies installed entry points. |
| `npm run test:coverage` | Coverage for deterministic source-covering suites: unit, contract, and protocol.     |

CI can call each layer independently. The deploy-gating `test` job runs coverage
plus slow deterministic lifecycle checks once; `test:package` runs in a separate
non-blocking package job so npm registry availability cannot stall `ci-green`.
The current CI check names are `lint` and `test`. If branch protection is added,
use those names, not the retired matrix names `test (20)` or `test (22)`.

## File Naming Convention

Test files must use these suffixes so scripts do not depend on accidental paths:

| Suffix                                     | Command owner           |
| ------------------------------------------ | ----------------------- |
| `tests/unit/*.unit.test.ts`                | `test:unit`             |
| `tests/contract/*.contract.test.ts`        | `test:contract`         |
| `tests/protocol/*.modern-protocol.test.ts` | `test:protocol:modern`  |
| `tests/protocol/*.legacy-protocol.test.ts` | `test:protocol:legacy`  |
| `tests/slow/*.slow.test.ts`                | `test:slow`             |
| `tests/package/*.package.test.ts`          | `test:package`          |
| `tests/live/*.integration.live.test.ts`    | `test:integration:live` |
| `tests/live/*.contract.live.test.ts`       | `test:contract:live`    |

Do not put credential-free assertions in live files. Source unit tests must
import `src/`; only the slow/package layers may build or inspect `dist/`.

## Test Reports

All npm Jest layer commands run through `scripts/run-jest-layer.mjs`. The runner
preserves the normal terminal reporter and writes machine-readable summaries.
Deterministic layers also write JUnit XML. Live layers do not load the
third-party JUnit reporter because they run with B2 credentials in the
environment.

- JUnit XML: `reports/junit/<layer>.xml`
- Jest JSON summary: `reports/jest/<layer>.json`
- Coverage summary: `coverage/coverage-summary.json` from `npm run test:coverage`
- Cobertura XML: `coverage/cobertura-coverage.xml` from `npm run test:coverage`

If a selected layer has zero executed tests because every case was skipped, the
runner exits nonzero and prints the summary path. A skipped-only run is visible
evidence, not an authoritative pass.

## MCP Protocol Matrix

Protocol tests cover the SDK v2 serving matrix used in production:

| Area  | Coverage                                                                                   |
| ----- | ------------------------------------------------------------------------------------------ |
| HTTP  | Modern `2026-07-28` POST requests for `tools/list` and `tools/call` without MCP sessions.  |
| HTTP  | Stateless 2025-era `initialize` compatibility through `createMcpHandler(..., { legacy })`. |
| HTTP  | Header/body validation for `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name`.           |
| HTTP  | GET/DELETE rejection, ignored `Mcp-Session-Id`, no event replay from `Last-Event-ID`.      |
| stdio | `serveStdio` factory wiring, including degraded capability lookup behavior.                |

The modern HTTP path uses one `createMcpHandler` wrapped once by
`toNodeHandler` from `@modelcontextprotocol/node`. Tests assert that body-size,
Host, Origin, credential, rate-limit, in-flight, and shutdown behavior stays
outside the MCP handler while the SDK owns protocol validation and modern result
metadata.

Tool-surface tests inspect the repository-owned registration registry, not SDK
private fields. The registry is sorted by tool name and mirrors the public
`registerTool()` calls made at server construction.

## Tool Result Serialization

Credential-free unit tests cover the structured result serializer:

- default compact JSON text output preserves the same `structuredContent`;
- `B2_MCP_OUTPUT_FORMAT=toon` round-trips through the repo-owned encoder and
  official `@toon-format/toon@4.1.0` dev/test decoder while preserving the same
  `structuredContent`;
- unknown output formats fail during config resolution;
- HTTP header-mode readiness rejects unknown output formats and TOON preflight
  failures before serving traffic;
- production serialization does not load the npm TOON package, including in
  TOON mode;
- TOON encode failures and input-bound violations fall back to compact JSON;
- redaction runs before text serialization;
- delimiters, indentation, quotes, backslashes, tabs, CR/LF, Unicode,
  formula-like prefixes, hostile keys, and strings resembling TOON
  headers/comments round-trip through `structuredContent`.

## Live B2 Commands

These live commands are outside the deterministic PR gate and fail fast when the
required credentials are not present:

```bash
npm run test:integration:live # requires B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY
npm run test:contract:live    # requires B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY
```

## Networked Security Gate

The production dependency audit is release-gate evidence and may also become a
CI gate once #62 resolves or risk-accepts current findings:

```bash
npm audit --omit=dev
```

## Live B2 Smoke Gate

Live B2 evidence is required before release sign-off but must be isolated from
normal PRs and untrusted forks.

Required properties:

- scoped, non-master application key;
- throwaway bucket or tightly scoped prefix;
- one controlled write/read/delete round trip when the key allows writes;
- teardown that cannot affect unrelated objects;
- logs and tool responses checked for credential redaction.

The live path runs through `.github/workflows/smoke.yml`,
`.github/workflows/contract.yml`, or a protected manual equivalent. Any workflow
that consumes `B2_*` secrets must use a protected GitHub environment, fail
loudly when manually dispatched outside `main`, check out `ci-green` before any
repository code runs with secrets, serialize live write tests, and reference
only environment-scoped `LIVE_B2_*` secrets. Release-triggered live workflows
must first prove the `v*` release tag points at `ci-green`.
