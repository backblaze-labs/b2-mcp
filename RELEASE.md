# Release Process

Owner: Gonza (`@goanpeca`). Quality and security reviewer: Sophie / QK
(`@sophiecarreras`).

The canonical first public release line is `v0.1.0`. The inherited `v1.2.x`
draft releases and `2.3.0` package version are historical input from the
incoming repository, not the Phase 1 release line.

The canonical CLI binary is `b2-mcp`. The inherited `b2-mcp-server` binary is
kept as a transition alias until a later release explicitly deprecates or
removes it.

## Changelog Discipline

- Every user-visible change must update `CHANGELOG.md` under `[Unreleased]`.
- Use Keep a Changelog headings: `Added`, `Changed`, `Deprecated`, `Removed`,
  `Fixed`, and `Security`.
- Move `[Unreleased]` entries into the released version section only when the
  release tag is created.
- Do not publish a GitHub release without a matching changelog section, tag, and
  package version.

## Release Gate

Before publishing `v0.1.0`:

1. Confirm `docs/V1_SCOPE.md` still matches the implemented package, runtime,
   tool profiles, and MCP transport contract.
2. Confirm operators and CI use Node 22, then run the deterministic local gate:
   `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint`,
   `npm run format:check`, and `npm test`.
3. Run or risk-accept the production dependency audit.
4. Run the secret scan and legal/provenance review in
   `docs/SECURITY_REVIEW.md`.
5. Confirm the live B2 smoke evidence required by `docs/TESTING.md`.
6. Publish only from the canonical repository:
   `https://github.com/backblaze-labs/b2-mcp`.
