# Testing And Quality Gates

Owner: Sophie / Quality Keeper (QK) (`@sophiecarreras`). Implementation owner: Gonza
(`@goanpeca`).

Status: skeleton. Issues #50, #51, #52, #60, #61, and #63 own the test-gate
implementation.

## Deterministic PR Gate

The PR gate must not require real B2 credentials. The current credential-free
gate is:

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
```

The current CI check names are `lint` and `test`. If branch protection is added,
use those names, not the retired matrix names `test (20)` or `test (22)`.

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

## Future Credential-Free Contract Gate

These commands are required Phase 1 work, but they must not be added to the
deterministic PR gate until they run without live B2 credentials:

```bash
npm run test:integration
npm run test:contract
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
