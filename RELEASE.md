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
   or 26. Keep CI production-dependency and deterministic workflow evidence on
   Node.js 22.23.1, 24, and 26; live B2 workflow evidence runs on Node.js
   22.23.1, 24, and 26. Build release artifacts on the patched Node 22 LTS pin,
   then run the deterministic local gate:
   `pnpm install --frozen-lockfile`, `pnpm run build`, `pnpm run typecheck`,
   `pnpm run lint`, `pnpm run format:check`, `pnpm test`,
   `pnpm run test:contract`, `pnpm run test:protocol`,
   `pnpm run test:package`, and `pnpm run audit:supply-chain`.
   Also run the production npm advisory gate with
   `pnpm run audit:production`; use `pnpm run release:sbom` when release SBOM
   generation is required.
3. Review `audit-policy.json` and risk-accept only unexpired, documented,
   tightly scoped upstream advisories that have no fixed stable package.
4. Run the supply-chain denylist branch and artifact workflow in
   `docs/SUPPLY_CHAIN_SECURITY.md`.
5. Run the secret scan and legal/provenance review in
   `docs/SECURITY_REVIEW.md`.
6. Confirm the live B2 smoke and contract evidence required by
   `docs/TESTING.md`. A release without the latest successful protected live
   contract run requires an explicit release exception recorded in the release
   issue or PR and approved by the release owner and security owner.
7. Confirm `@backblaze-labs/b2-mcp` is owned by Backblaze on npm and package
   provenance is enabled before publishing or advertising npm install commands.
8. Confirm the live B2 workflow environments have `LIVE_B2_KEY_ID`,
   `LIVE_B2_KEY`, the smoke-suite `LIVE_B2_*` secrets, `MCP_URL`, and
   `B2_SMOKE_BUCKET` populated from the dedicated test account, then manually
   dispatch smoke and contract from `main`. Security owns rotation for the live
   B2 credentials. The live jobs run serially on Node.js 22.23.1, Node.js 24, and
   Node.js 26.
9. Confirm any claimed MCP SDK package split is either implemented or tracked as
   a release-blocking follow-up once the upstream package exists.
10. Create the GitHub Release for the publish tag, then publish only from the
    canonical repository through the protected
    `.github/workflows/publish.yml` workflow. Do not publish from a developer
    workstation. The publish workflow must prove the `v*` tag is reachable from
    `ci-green`, build explicitly, enforce the runtime package budget, scan the
    generated packlist and tarball, generate and verify a CycloneDX production
    SBOM artifact, call the protected live B2 contract workflow as a pre-release
    gate, verify the tarball SHA-256, publish the already-scanned tarball with
    lifecycle scripts disabled, and attach the SBOM to the GitHub Release only
    after npm publish succeeds.
