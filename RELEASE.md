# Release Process

Owner: Gonza (`@goanpeca`). Quality and security reviewer: Sophie / Quality Keeper (QK)
(`@sophiecarreras`).

The canonical first public release line is `v0.1.0`. The inherited `v1.2.x`
draft releases and historical `2.3.0` package version are input from the
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
2. Confirm operators use a patched Node 22 LTS release (`.nvmrc`) or Node.js 24
   or 26. Keep CI minimum-floor evidence on Node.js 22.3.0. Build release
   artifacts on the patched Node 22 LTS pin, then run the deterministic local
   gate: `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint`,
   `npm run format:check`, `npm test`, `npm run test:integration`,
   `npm run test:contract`, `npm run smoke:package`, and
   `npm run audit:supply-chain`.
3. Review `audit-policy.json` and risk-accept only unexpired, documented
   upstream advisories that have no fixed stable package.
4. Run the secret scan and legal/provenance review in
   `docs/SECURITY_REVIEW.md`.
5. Confirm the live B2 smoke evidence required by `docs/TESTING.md`.
6. Confirm `@backblaze-labs/b2-mcp` is owned by Backblaze on npm and package
   provenance is enabled before publishing or advertising npm install commands.
7. Confirm the live B2 workflow environments have `LIVE_B2_*` secrets and
   `MCP_URL` populated, then manually dispatch smoke and contract from `main`.
   The live jobs run serially on patched Node 22 LTS, Node.js 24, and Node.js 26.
8. Confirm any claimed MCP SDK package split is either implemented or tracked as
   a release-blocking follow-up once the upstream package exists.
9. Publish only from the canonical repository:
   `https://github.com/backblaze-labs/b2-mcp`.
