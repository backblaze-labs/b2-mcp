# Testing And Quality Gates

Owner: Sophie / Quality Keeper (QK) (`@sophiecarreras`). Implementation owner: Gonza
(`@goanpeca`).

Status: active. Test selection is based on explicit filename suffixes, not broad
directory sweeps.

## Deterministic PR Gate

The PR gate must not require real B2 credentials. The complete local
no-credential gate is:

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

`pnpm run verify` runs typecheck, build, Biome lint, doc-comment lint, local
Markdown link validation, Node-based bundled skills-pack validation, the Biome-supported
format check, spelling, and listener diagnostics across the fast non-live
layers. Coverage, slow lifecycle, and packed-package installation evidence stay
in distinct scripts and CI jobs so their failures do not mask each other.
Use `pnpm run smoke:local` for deterministic runtime-startup evidence without a
deployed endpoint or real B2 credentials; CI runs it after the primary
verification gate and again on the Node.js 22.3.0 runtime floor.
The individual deterministic layers are:

| Command                 | Layer                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `pnpm test`              | Typecheck, then `pnpm run test:unit`.                                                |
| `pnpm run lint`          | Biome lint for source, test, and script code.                                        |
| `pnpm run lint:docs`     | TSDoc/JSDoc doc-comment syntax and hygiene gate for non-test `src/**/*.ts` files.    |
| `pnpm run lint:links`    | Deterministic local Markdown link validation for repository docs.                    |
| `pnpm run test:unit`     | Fast source unit tests.                                                              |
| `pnpm run test:contract` | Deterministic MCP/package/schema/document/workflow contracts.                        |
| `pnpm run test:protocol` | Aggregate protocol gate (`test:protocol:modern` + `test:protocol:legacy`).           |
| `pnpm run test:slow`     | Deterministic high-cost lifecycle tests with explicit timeout and one Vitest worker.  |
| `pnpm run test:package`  | Builds, packs, installs through an npm consumer, and verifies installed entry points. |
| `pnpm run test:coverage` | Coverage for all deterministic non-live layers.                                      |
| `pnpm run test:diagnostics` | Builds first, then checks unit/protocol layers for MaxListeners and open-handle warnings. |
| `pnpm run smoke:local`  | Builds, starts local HTTP MCP on 127.0.0.1:0, validates discovery/tools, and stops.   |

Local scripts can call each deterministic layer independently. Required PR jobs
keep the major evidence classes distinct so coverage regression, contract drift,
protocol failure, production-audit findings, package-budget drift, and broken
package installs fail independently. The Linux deterministic Node matrix is
exactly Node.js 22.23.1, 24, and 26. Slow lifecycle tests run in a dedicated
bounded job with one Vitest worker, and the cross-platform fast suite runs on
Linux, Windows, and macOS at Node.js 22.23.1. A separate runtime engine floor job
runs the packed-consumer install smoke on Node.js 22.3.0. A separate container
image job runs `scripts/smoke-container-image.mjs`, which builds the Docker
image and smokes HTTP readiness with and without server-held credentials. The
release workflow reuses the same smoke script before publishing the signed
multi-platform GHCR manifest. The coverage aggregate disables file parallelism
so contract fixture reports, dist rebuilds, and package packing do not race each
other.

The stable required PR check names are:

- `format/lint/typecheck`
- `docs/spelling/links`
- `unit/coverage`
- `MCP contract`
- `modern and legacy protocol/transport`
- `package install smoke`
- `runtime engine floor`
- `production dependency audit`
- `package budget`
- `container image`
- `supply-chain audit`
- `CodeQL/workflow security`
- `slow/lifecycle`
- `cross-platform minimum`

Global V8 coverage must remain at or above 90.5% statements, 81.8% branches,
94.6% functions, and 93.8% lines. Raise these floors as coverage improves;
lowering them requires explicit review and justification. Coverage collection is source
only: `src/**/*.ts`, excluding `dist/`, declarations, generated files, and test
files. The current Phase 1 floor is a ratchet: when `coverage/coverage-summary.json`
shows every global percentage at least two points above the floor for three
consecutive main-branch runs, raise the matching threshold in `vitest.config.mts`,
the README badge, this document, and the CI summary text in the same PR. Lowering
a threshold requires a time-bounded exception in the PR description and a
follow-up issue.

Critical modules have direct branch tests or documented invariants in addition
to the global floor:

| Area                 | Modules                                                                                     | Phase 1 target                  |
| -------------------- | ------------------------------------------------------------------------------------------- | ------------------------------- |
| Credentials          | `src/credentials.ts`, `src/auth.ts`                                                         | No secret echo; 90%+ statements |
| Secret redaction     | `src/utils/secret-sanitizer.ts`, audited tool wrapping                                      | Canary redaction branch tests   |
| Destructive actions  | `src/utils/destructive-gate.ts`, bucket/object/multipart delete handlers                    | Confirm/block/allow branches    |
| Filesystem boundary  | `src/utils/fs-guard.ts`, S3 local file upload/download paths                                | Root escape and symlink tests   |
| Logger destination   | `src/utils/logger.ts`                                                                       | `B2_LOG_FILE` import safety, async file/stderr routing, redaction, POSIX owner-only permissions, Windows rejection, symlink/FIFO/hard-link rejection, SIGHUP reopen, stderr fallback, and startup/shutdown tests |
| Transport boundary   | `src/http-server.ts`, `src/utils/node-web-bridge.ts`, stdio and HTTP protocol suites        | Close/abort/listener tests      |

The v1.0.0 target is 90% statements, 80% branches, 90% functions, and 90% lines
globally, with credential/redaction/destructive/filesystem modules kept at 95%+
statements or covered by explicit invariant tests. The SDK reference baseline is
tracked as comparison evidence for test design, especially simulator behavior,
retry ownership, pagination, and cancellation. Matching SDK parity is not a
release blocker for this MCP package; regressions in this repository's critical
boundaries are.
CI installs with `pnpm install --frozen-lockfile` and verifies package install
behavior, coverage, protocol, and production dependency audit evidence on the
required Node.js matrix. The `format/lint/typecheck` job runs the same
`pnpm run verify` entry point used locally, and `pnpm run check:runtime-policy`
fails if workflow or metadata runtime policy drifts. Cross-platform coverage
stays lean: the fast stdio, installed CLI/bin, CLI port parsing, local-path
policy, and request shutdown/signal suite runs on Linux, Windows, and macOS at
Node.js 22.23.1.

TypeScript is intentionally constrained to the `6.0.x` line while
the toolchain validates support on Node.js 22, 24, and 26. Widen the
TypeScript range only with a matching typecheck and lint toolchain upgrade.
The TypeScript 7 native compiler decision and trigger are recorded in
[`TYPESCRIPT_7_MIGRATION.md`](TYPESCRIPT_7_MIGRATION.md).

Biome is also the only formatter. `pnpm run format` and `pnpm run format:check`
cover Biome-supported file types; Markdown and YAML files are not part of the
automated format gate.

## File Naming Convention

Test files must use these suffixes so scripts do not depend on accidental paths:

| Suffix                                                | Command owner               |
| ----------------------------------------------------- | --------------------------- |
| `tests/unit/*.unit.test.ts`                           | `test:unit`                 |
| `tests/contract/*.contract.test.ts`                   | `test:contract`             |
| `tests/protocol/*.modern-protocol.test.ts`            | `test:protocol:modern`      |
| `tests/protocol/*.legacy-protocol.test.ts`            | `test:protocol:legacy`      |
| `tests/runtime-security/*.runtime-security.test.ts`   | `test:runtime-security`     |
| `tests/slow/*.slow.test.ts`                           | `test:slow`                 |
| `tests/package/*.package.test.ts`                     | `test:package`              |
| `tests/live/*.integration.live.test.ts`               | `test:live:b2-integration`  |
| `tests/live/*.contract.live.test.ts`                  | `test:live:b2-contract`     |

Do not put credential-free assertions in live files. Source unit tests must
import `src/`; only the slow/package layers may build or inspect `dist/`.

## Test Reports

All pnpm Vitest layer commands run through `scripts/run-vitest-layer.mjs`. The runner
preserves the normal terminal reporter and writes machine-readable summaries
without raw failure messages. Deterministic layers write JUnit XML only when no
B2 credential environment variables are present. Any layer running with B2
credentials suppresses the JUnit reporter.

- JUnit XML: `reports/junit/<layer>.xml`
- Vitest JSON summary: `reports/vitest/<layer>.json`
- Coverage summary: `coverage/coverage-summary.json` from `pnpm run test:coverage`
- HTML coverage report: `coverage/index.html` from `pnpm run test:coverage`
- LCOV info: `coverage/lcov.info` from `pnpm run test:coverage`
- Cobertura XML: `coverage/cobertura-coverage.xml` from `pnpm run test:coverage`

If a selected layer has zero executed tests because every case was skipped, the
runner exits nonzero and prints the summary path. A skipped-only run is visible
evidence, not an authoritative pass.

The owned `ci-green` marker advances only on successful `main` pushes after the
required deterministic, package, audit, package-budget, supply-chain, workflow
security, runtime floor, slow lifecycle, and cross-platform jobs pass. It is not
a PR deploy path. Leak diagnostics remain part of `pnpm run verify` and fail on
`MaxListenersExceededWarning`, EventEmitter leak warnings, or Vitest close-timeout
open-handle warnings until teardown is clean. Node.js 22.23.1, 24, and 26 are all
required CI evidence for Phase 1, with Node.js 22.3.0 exercised by the runtime
engine floor package smoke.

Branch protection for `main` must require the stable check names above, require
at least one approving review, dismiss stale approvals when new commits are
pushed, require branches to be up to date before merge, and block force pushes.
CODEOWNER review is mandatory for protected workflow, package metadata, and
lockfile policy changes.
The reviewed settings are recorded in
[`../.github/branch-protection-main.json`](../.github/branch-protection-main.json).
Do not add B2 credential requirements to normal pull-request checks. This
rollout is blocked until a repository admin applies the checked-in policy and
reads it back from GitHub matching the committed contexts and review settings.

## MCP Protocol Matrix

Protocol tests cover the SDK v2 serving matrix used in production:

| Area  | Coverage                                                                                   |
| ----- | ------------------------------------------------------------------------------------------ |
| HTTP  | Modern `2026-07-28` POST requests for `tools/list` and `tools/call` without MCP sessions.  |
| HTTP  | Stateless 2025-era `initialize` compatibility through `createMcpHandler(..., { legacy })`. |
| HTTP  | Header/body validation for `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name`.           |
| HTTP  | GET/DELETE rejection, ignored `Mcp-Session-Id`, no event replay from `Last-Event-ID`.      |
| HTTP  | Runtime-security regressions in `pnpm run test:runtime-security` for issue #197.          |
| stdio | `serveStdio` factory wiring, including degraded capability lookup behavior.                |

The modern HTTP path uses one `createMcpHandler` wrapped once by the
repository-owned Node HTTP bridge. Tests assert request abort propagation,
stream completion, and dependency-graph exclusion of `@modelcontextprotocol/node`
and `@hono/node-server`, while body-size, Host, Origin, credential, rate-limit,
in-flight, and shutdown behavior stays outside the MCP handler and the SDK owns
protocol validation and modern result metadata.

Tool-surface tests inspect the repository-owned registration registry, not SDK
private fields. The registry is sorted by tool name and mirrors the public
`registerTool()` calls made at server construction.

## Deterministic Local Runtime Smoke

The local runtime smoke is the credential-free startup check for clean
checkouts and QK runtime evidence:

```bash
pnpm install --frozen-lockfile
pnpm run smoke:local
```

`smoke:local` builds `dist/`, starts the built HTTP MCP server in a sanitized
child process bound to `127.0.0.1` on an ephemeral port, connects with a minimal
modern HTTP MCP client, validates `server/discover` and `tools/list` against
the frozen full profile, sends a missing-credential request and expects a
JSON-RPC error, blocks non-loopback runner egress and outbound B2 network access
in the server worker, and shuts the child process down with a bounded timeout.
It does not read `MCP_URL` and does not require real Backblaze B2 credentials.

## Supplemental External Client Smoke

The external-client checks below remain supplemental: `pnpm run verify`, the
protocol layers above, and `pnpm run smoke:local` are the repo-native
credential-free evidence. External clients are advisory evidence until they
prove deterministic enough for CI.

Manual Inspector compatibility is pinned by the repository wrapper to
`@modelcontextprotocol/inspector@2.1.0`. That Inspector release requires
Node.js 22.19.0 or newer, so it is supplemental evidence for the patched Node
22 LTS development/runtime pin. Install project dependencies, build from a
non-serving checkout, then run the locked Inspector CLI through the wrapper:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run smoke:inspector
```

`smoke:inspector` uses `pnpm exec mcp-inspector` from the committed lockfile, an
isolated temporary home/cache, fake B2 credentials, and the same no-network
server guard as `smoke:client`.

The non-interactive external client smoke uses the official
`@modelcontextprotocol/client@2.0.0` SDK over stdio. It sends fake test
credentials, sets `B2_REGISTER_ALL_TOOLS=true` so startup performs no B2
capability-discovery network call, validates `server/discover`, server
name/version, instructions, and `tools/list`, then compares the returned surface
to `tests/fixtures/tool-contract/full.modern.json` and
`docs/tool-profile-contract.json`.

```bash
pnpm run build
pnpm run smoke:client
```

`smoke:client` uses the already-built `dist/` artifact and does not remove or
rewrite it. It fails clearly when `dist/index.js` or `dist/tool-contract.js` is
missing. On a deployment host, run it only from a non-serving checkout or from a
copied release artifact, not from the active checkout used by a supervised
service.

The command records the SDK client's negotiated protocol era and revision, for
example:

```text
negotiatedEra=modern negotiatedProtocol=2026-07-28
```

The smoke process starts as a small bootstrap that strips sensitive environment
variables before importing the MCP client SDK. The server child runs with fake
B2 credentials, `B2_REGISTER_ALL_TOOLS=true`, and a no-network preload guard; if
capability discovery or another B2 network path is attempted, the smoke fails.

Modern HTTP can be checked with the same SDK client pattern. Start a local HTTP
server with fake server-mode credentials:

```bash
pnpm run build
B2_HTTP_CREDENTIAL_MODE=server \
B2_REGISTER_ALL_TOOLS=true \
B2_APPLICATION_KEY_ID=external-smoke-key-id \
B2_APPLICATION_KEY=external-smoke-key-secret \
B2_ALLOWED_HOSTS=127.0.0.1 \
node dist/http-server.js --port 3333
```

Then connect with a modern-pinned SDK HTTP client and record negotiation:

```bash
node --input-type=module <<'JS'
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client(
  { name: "b2-mcp-http-smoke", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } }, defaultCacheTtlMs: 0 },
);
const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3333/mcp"));
try {
  await client.connect(transport, { timeoutMs: 10_000 });
  await client.listTools(undefined, { cacheMode: "refresh", timeoutMs: 10_000 });
  console.log(
    JSON.stringify({
      era: client.getProtocolEra(),
      protocolVersion: client.getNegotiatedProtocolVersion(),
      server: client.getServerVersion(),
    }),
  );
} finally {
  await client.close().catch(() => undefined);
}
JS
```

Claude client smoke remains supplemental. Record one dated Claude Desktop or
Claude.ai Custom Connector run after the selected Claude surface exposes the
`2026-07-28` protocol; do not make that vendor run a required gate.

## Tool Result Serialization

Credential-free unit tests cover the structured result serializer:

- default compact JSON text output preserves the same `structuredContent`;
- `B2_MCP_OUTPUT_FORMAT=toon` round-trips through the repo-owned encoder and
  official `@toon-format/toon@4.1.0` dev/test decoder in a sanitized child
  process while preserving the same `structuredContent`;
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
pnpm run test:live:b2-integration # requires B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY
pnpm run test:live:b2-contract    # requires B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY
pnpm run test:live:b2             # runs both live suites
```

## Networked Security Gate

The full lockfile audit is release-gate evidence, a pull-request CI gate, and
part of the `mark-green` deploy gate on `main` pushes:

```bash
pnpm run audit:supply-chain
```

The first phase of that command is the repository denylist/IOC gate for active
npm supply-chain incidents:

```bash
pnpm run audit:supply-chain:denylist --packlist
```

CI fetches the protected `origin/main` ref and scans the tested ref plus
`origin/main` before `ci-green` can advance:

```bash
pnpm run audit:supply-chain:denylist --ref HEAD --ref origin/main --packlist
```

For incident triage across all fetched branches, run the same command with
`--all-branches` from a fresh clone. For downloaded GitHub workflow artifacts or
publish tarballs, expand the artifacts and pass each root with
`--artifacts-dir`, or pass package tarballs directly with `--tarball`. The
detailed branch, artifact, and tarball workflow is in
[`SUPPLY_CHAIN_SECURITY.md`](SUPPLY_CHAIN_SECURITY.md).

Known exceptions must live in `audit-policy.json` with an expiry, maximum
severity, dependency path, lockfile version/integrity, and rationale. The
current policy has no exceptions; adding one requires explicit security-owner
review.

`scripts/audit-supply-chain.mjs` always runs a real `pnpm audit` outside
`NODE_ENV=test`, refuses environment-injected audit fixtures in CI, sets bounded
npm fetch retry options, and retries transient registry/network failures before
evaluating advisories. `scripts/check-supply-chain-denylist.mjs` runs without
executing package lifecycle scripts, reports scanner/infrastructure failures
separately from real detections, and also scans the `npm pack --dry-run` file
list when `--packlist` is passed. Expired advisory exceptions fail the audit on pull
requests and on the `main` deploy-gating path required by `mark-green`; the
`ci-green` ref must not advance after an exception expiry without an affirmative
policy update or exception removal. `B2_MCP_AUDIT_EXPIRED_EXCEPTION_MODE=warn`
is reserved for non-gating reminder jobs or local operator checks and emits a
GitHub `::warning` annotation.

The production npm advisory gate is separate from the full pnpm lockfile audit
because npm audit requires an npm lockfile. CI runs `pnpm run audit:production`,
which prepares a production-only audit root in `.audit/npm-production`, derives
its `package-lock.json` from the committed `pnpm-lock.yaml`, sets bounded npm
fetch retry options, and evaluates `npm audit --json --omit=dev
--audit-level=moderate` through `audit-policy.json` exceptions. Release
publishing uses the same script through `pnpm run release:sbom` to audit the
shipped pnpm-locked graph and generate the CycloneDX SBOM attached to the
GitHub release without installing or re-resolving dependencies.

`mark-green` intentionally fail-closes on npm registry/advisory-service
availability because `supply-chain-audit` makes a live `npm audit` call and the
package install smoke performs a cold lockfile-less consumer `npm install`. If a
sustained npm outage blocks an urgent unrelated production hotfix, the emergency path is: get
release-owner and security-owner approval in the incident record, verify the
same commit passed every non-registry gate locally or in CI, confirm the commit
is still `refs/heads/main`, then have a maintainer with write access advance
`ci-green` to that exact SHA and immediately open a follow-up PR or issue that
records the override. Do not use this path for new dependency changes or any
audit-policy expiry.

## Live And Integration Test Credentials

The default deterministic gate must stay credential-free. Local direct Vitest
selection skips live cases when B2 credentials are absent, but trusted hosted
Vitest live-suite jobs set `B2_REQUIRE_LIVE_TESTS=1`; with that flag set,
missing or partial `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` credentials
fail the live layer instead of reporting skipped tests as a pass.

For the integration and request-shape contract suites, use the
`live-b2-contract` GitHub Environment:

- Buckets to pre-create: NONE. The tests create and delete their own run-owned
  buckets through `b2_create_bucket` in `tests/live/support/contract-buckets.ts`,
  with strict cleanup by the live B2 janitor.
- Keys: one non-master B2 application key. Because it creates buckets, it cannot
  be scoped to a single bucket; it is account-wide. Capabilities:
  `bypassGovernance`, `deleteBuckets`, `deleteFiles`, `listBuckets`,
  `listFiles`, `listKeys`, `readBucketEncryption`, `readBucketRetentions`,
  `readBuckets`, `readFileLegalHolds`, `readFileRetentions`, `readFiles`,
  `writeBucketEncryption`, `writeBucketNotifications`, `writeBucketRetentions`,
  `writeBuckets`, `writeFileLegalHolds`, `writeFileRetentions`, and
  `writeFiles`. Do not grant `writeKeys`, `deleteKeys`, master-key access, or
  account-admin capabilities.
- Secrets: `LIVE_B2_KEY_ID` and `LIVE_B2_KEY` (mapped to `B2_APPLICATION_KEY_ID`
  and `B2_APPLICATION_KEY`), plus `LIVE_B2_MASTER_KEY_ID` and `LIVE_B2_MASTER_KEY`
  (mapped to `B2_MASTER_KEY_ID`/`B2_MASTER_KEY`) for the Partner read paths, all
  wired through `.github/workflows/contract.yml`.
- Variables: `B2_LIVE_TEST_ACCOUNT_ID`, `B2_REGION` (the account's S3 region,
  e.g. `us-east-005`), `B2_LIVE_NOTIFICATION_BUCKET`, and the workflow-generated
  `B2_MCP_LIVE_RUN_PREFIX`.
- Event Notifications (required): the notification write-shape contract runs
  against a pre-provisioned, notifications-enabled bucket. Create a bucket in the
  test account, have Backblaze enable Event Notifications on it (a per-bucket
  entitlement), and set `B2_LIVE_NOTIFICATION_BUCKET` to its name. The test sets
  then clears rules and never deletes the bucket, and the key holds
  `writeBucketNotifications`.
- Partner API (required): provide the account master key via
  `LIVE_B2_MASTER_KEY_ID`/`LIVE_B2_MASTER_KEY`; the account must have Partner API
  access. Partner endpoints reject non-master keys, so this is separate from the
  non-master application key.
- Use a dedicated, disposable key in an isolated test account. A bucket-creating
  key is account-wide, so the test account is the isolation boundary.

For the deployed MCP smoke, use the `live-b2-smoke` GitHub Environment. This
path needs a reviewed deployment from issue #137 before it can provide release
evidence.

- Buckets to pre-create: ONE. The smoke probes a known bucket with
  `s3_head_bucket` in `scripts/smoke-test.mjs`; it does not create a bucket.
  Put that bucket name in `B2_SMOKE_BUCKET`.
- Keys: `LIVE_B2_KEY_ID` / `LIVE_B2_KEY`, which the smoke client sends to the
  deployed MCP, and `LIVE_B2_APP_KEY_ID` / `LIVE_B2_APP_KEY`, a non-master key
  for the S3 path because B2's S3 endpoint rejects master keys. Both pairs can
  point at the same non-master key when the primary key is already non-master.
  They only need read access to the smoke bucket: `listBuckets`, `listFiles`,
  and `readFiles`; they may be bucket-scoped.
- Also required as variables or secrets: `MCP_URL`,
  `B2_MCP_EXPECTED_TOOL_PROFILE`, `B2_MCP_REQUIRE_SMOKE_BUCKET=1`, and
  `MCP_AUTHORIZATION` / `VERCEL_PROTECTION_BYPASS` according to the deployment.

Remove obsolete repository-level B2 secrets named `B2_KEY`, `B2_KEY_ID`,
`B2_APP_KEY`, and `B2_APP_KEY_ID` in the GitHub UI. The live workflows use the
environment-scoped secrets above and do not reference those repository-level
secrets.

## Live B2 Smoke Gate

Live B2 evidence is required before release sign-off but must be isolated from
normal PRs and untrusted forks.

Required properties:

- dedicated live B2 test account, not a customer account;
- dedicated account-level application key with the bucket, file, Object Lock,
  notification, and lifecycle capabilities needed by the suite; it must not be
  bucket- or prefix-restricted, and the dedicated account is the isolation
  boundary. The workflow validation step and fixture helpers both enforce the
  `B2_LIVE_TEST_ACCOUNT_ID` allowlist before live fixture mutation or cleanup;
- unique `B2_MCP_LIVE_RUN_PREFIX` for every run, rooted at `mcp-contract-`;
- test-owned buckets, objects, multipart uploads, and notification rules only;
  live tests must never choose an arbitrary listed bucket as writable;
- Object Lock live fixtures use only governance-mode retention with short
  retain-until windows, never compliance mode, so cleanup can clear retention
  with the required `bypassGovernance` capability;
- best-effort test `afterAll` cleanup plus strict workflow cleanup through
  `scripts/live-b2-janitor.mjs`; leaked buckets or cleanup errors fail the run
  that caused them;
- best-effort log hygiene redacting B2 credentials, account IDs, presigned URLs,
  live run prefixes, and smoke bucket names. This is not a containment boundary;
  live secrets must never share a job with unreviewed pull-request code.

The live path runs through `.github/workflows/contract.yml` and
`.github/workflows/smoke.yml`. Both run on manual dispatch from `main` and
trusted scheduled paths; smoke also runs on successful deployment status events
using the deployed SHA after checking that the deployment environment is approved
from a repository or organization variable and the SHA is reachable from
protected `main` or `ci-green`. Neither workflow runs on `pull_request`,
because live credentials must not be exposed to PR-head code. Trusted Vitest
live-suite runs set `B2_REQUIRE_LIVE_TESTS=1` and
`B2_INTEGRATION_REQUIRE_CREDENTIALS=1` together; the workflow validation step
fails if either flag is not set to `1`. Smoke uses its own credential scheme and fails
loudly through the `Validate live B2 smoke environment` steps and
`B2_MCP_REQUIRE_SMOKE_BUCKET=1`. Missing credentials or required variables fail
trusted live jobs; a skipped-only trusted run is not accepted as release
evidence. The contract validation step and janitor both
require `B2_LIVE_TEST_ACCOUNT_ID` and refuse to proceed when the authorized
account ID does not match that dedicated test-account allowlist. The protected
live matrix is serialized on Node.js 22.23.1, Node.js 24, and Node.js 26.

Release publication uses `.github/workflows/publish.yml`, which resolves the
publish tag against `ci-green` and then calls the protected live contract
workflow through `workflow_call` before npm publish. The caller passes only the
reviewed checkout SHA. The called workflow's jobs bind `live-b2-contract` and
resolve `LIVE_B2_KEY_ID`, `LIVE_B2_KEY`, and `B2_LIVE_TEST_ACCOUNT_ID` there;
those values must not be duplicated or forwarded from repository or
`npm-publish` secrets. GitHub Release publication events are not pre-release
gates and are not used for live contract evidence.
