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

`pnpm run verify` runs typecheck, build, Biome lint, doc-comment lint, the
Biome-supported format check, spelling, and deterministic coverage across all
non-live layers, including slow lifecycle and packed-package installation tests.
The individual deterministic layers are:

| Command                 | Layer                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `pnpm test`              | Typecheck, then `pnpm run test:unit`.                                                |
| `pnpm run lint`          | Biome lint for source, test, and script code.                                        |
| `pnpm run lint:docs`     | TSDoc/JSDoc doc-comment syntax and hygiene gate for non-test `src/**/*.ts` files.    |
| `pnpm run test:unit`     | Fast source unit tests.                                                              |
| `pnpm run test:contract` | Deterministic MCP/package/schema/document/workflow contracts.                        |
| `pnpm run test:protocol` | Aggregate protocol gate (`test:protocol:modern` + `test:protocol:legacy`).           |
| `pnpm run test:slow`     | Deterministic high-cost lifecycle tests with explicit timeout and one Vitest worker.  |
| `pnpm run test:package`  | Builds, packs, installs through an npm consumer, and verifies installed entry points. |
| `pnpm run test:coverage` | Coverage for all deterministic non-live layers.                                      |

Local scripts can call each deterministic layer independently. The Linux Node
matrix runs the bundled coverage and slow deterministic lifecycle layers, while
`test:package` runs in a separate non-blocking package job. The coverage
aggregate disables file parallelism so contract fixture reports, dist rebuilds,
and package packing do not race each other.
Global V8 coverage must remain at or above 82% statements, 72% branches, 86%
functions, and 86% lines. Raise these floors as coverage improves; lowering
them requires explicit review and justification.
CI installs with `pnpm install --frozen-lockfile` and verifies the runtime
package floor with a packed consumer smoke on Node.js 22.3.0. The credential-free full
toolchain gate, including `pnpm run lint:docs`, runs on Linux for Node.js
22.23.1, 24, and 26. It also runs
`pnpm run check:runtime-policy`, which fails if workflow or metadata runtime
policy drifts. Cross-platform coverage stays lean: the fast stdio, CLI port
parsing, local-path policy, and request shutdown/signal suite runs on Linux,
Windows, and macOS at the patched Node 22 LTS pin.

TypeScript is intentionally constrained to the `6.0.x` line while
the toolchain validates support on Node.js 22, 24, and 26. Widen the
TypeScript range only with a matching typecheck and lint toolchain upgrade.

Biome is also the only formatter. `pnpm run format` and `pnpm run format:check`
cover Biome-supported file types; Markdown and YAML files are not part of the
automated format gate.

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

All pnpm Vitest layer commands run through `scripts/run-vitest-layer.mjs`. The runner
preserves the normal terminal reporter and writes machine-readable summaries
without raw failure messages. Deterministic layers write JUnit XML only when no
B2 credential environment variables are present. Any layer running with B2
credentials suppresses the JUnit reporter.

- JUnit XML: `reports/junit/<layer>.xml`
- Vitest JSON summary: `reports/vitest/<layer>.json`
- Coverage summary: `coverage/coverage-summary.json` from `pnpm run test:coverage`
- Cobertura XML: `coverage/cobertura-coverage.xml` from `pnpm run test:coverage`

If a selected layer has zero executed tests because every case was skipped, the
runner exits nonzero and prints the summary path. A skipped-only run is visible
evidence, not an authoritative pass.

The `ci-green` production deploy marker depends on both the Node.js 22.3.0
production-dependency install and the Node 22.23.1 deterministic gate. Node.js
24 and 26 remain required PR checks, but a regression isolated to those
non-production current lines does not freeze the production deploy ref. The
production host is pinned to the patched Node 22 LTS line from `.nvmrc`.

## MCP Protocol Matrix

Protocol tests cover the SDK v2 serving matrix used in production:

| Area  | Coverage                                                                                   |
| ----- | ------------------------------------------------------------------------------------------ |
| HTTP  | Modern `2026-07-28` POST requests for `tools/list` and `tools/call` without MCP sessions.  |
| HTTP  | Stateless 2025-era `initialize` compatibility through `createMcpHandler(..., { legacy })`. |
| HTTP  | Header/body validation for `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name`.           |
| HTTP  | GET/DELETE rejection, ignored `Mcp-Session-Id`, no event replay from `Last-Event-ID`.      |
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

## Supplemental External Client Smoke

The required PR gate remains repo-native: `pnpm run verify` and the protocol
layers above are the correctness oracle. External clients are advisory evidence
until they prove deterministic enough for CI.

Manual Inspector compatibility is pinned to
`@modelcontextprotocol/inspector@2.1.0` in `package.json` and
`pnpm-lock.yaml`. Install with the frozen lockfile, build from a non-serving
checkout, then run the locked Inspector CLI through the repository wrapper:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run smoke:inspector
```

`smoke:inspector` uses `pnpm exec mcp-inspector` from the locked install, an
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
pnpm run test:integration:live # requires B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY
pnpm run test:contract:live    # requires B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY
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

`mark-green` intentionally fail-closes on npm registry/advisory-service
availability because `supply-chain-audit` makes a live `npm audit` call and
`smoke:package` performs a cold lockfile-less consumer `npm install`. If a
sustained npm outage blocks an urgent unrelated production hotfix, the emergency path is: get
release-owner and security-owner approval in the incident record, verify the
same commit passed every non-registry gate locally or in CI, confirm the commit
is still `refs/heads/main`, then have a maintainer with write access advance
`ci-green` to that exact SHA and immediately open a follow-up PR or issue that
records the override. Do not use this path for new dependency changes or any
audit-policy expiry.

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
only environment-scoped `LIVE_B2_*` secrets. Protected live workflows run
serially on patched Node 22 LTS, Node.js 24, and Node.js 26. Release-triggered
live workflows must first prove the `v*` release tag is reachable from
`ci-green`.
