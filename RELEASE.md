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
8. Confirm `live-b2-contract` has environment secrets `LIVE_B2_KEY_ID` and
   `LIVE_B2_KEY` plus environment variable `B2_LIVE_TEST_ACCOUNT_ID`. Confirm
   `live-b2-smoke` has its four `LIVE_B2_*` environment secrets plus
   environment variables `MCP_URL`, `B2_SMOKE_BUCKET`, and
   `B2_MCP_EXPECTED_TOOL_PROFILE`. If deployment smoke should accept an
   environment other than `production`, set repository or organization variable
   `B2_MCP_SMOKE_DEPLOYMENT_ENVIRONMENT`; do not put it only in
   `live-b2-smoke`. Confirm the contract key authorizes the configured
   `B2_LIVE_TEST_ACCOUNT_ID` and has `bypassGovernance`, `deleteKeys`,
   `listKeys`, and `writeKeys`. Do not duplicate live B2 credentials at
   repository scope or in `npm-publish`; the called contract workflow resolves
   them from `live-b2-contract`. Manually dispatch smoke and contract from
   `main`. Security owns credential rotation. The live jobs run serially on
   Node.js 22.23.1, Node.js 24, and Node.js 26.
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

## First Package Bootstrap

npm trusted publishing cannot be configured until `@backblaze-labs/b2-mcp`
exists. For the first public package only:

1. Have an npm organization owner do a one-time manual bootstrap publish from a
   temporary clean checkout. Set `package.json` to a reserved non-release
   version such as `0.0.0-bootstrap.0`, build, pack, inspect the tarball, and
   publish it with short-lived or interactive npm credentials:

   ```bash
   pnpm install --frozen-lockfile
   pnpm run build
   npm pack --json --ignore-scripts --pack-destination /tmp/b2-mcp-bootstrap
   npm publish /tmp/b2-mcp-bootstrap/backblaze-labs-b2-mcp-0.0.0-bootstrap.0.tgz \
     --access public \
     --ignore-scripts \
     --tag bootstrap
   ```

2. Revoke any bootstrap credential or end the interactive npm session, then
   configure trusted publishing for
   `backblaze-labs/b2-mcp/.github/workflows/publish.yml` and the
   `npm-publish` GitHub environment.
3. Deprecate the bootstrap version with a note that it is a reserved package
   bootstrap and is not supported for installation.
4. Run the publish workflow against the signed `v0.1.0` tag. The workflow must
   publish the verified tarball with OIDC provenance; do not publish a different
   local tarball to bootstrap the package.

## Normal Release

1. Keep `[Unreleased]` for future work and move the release contents into a
   matching `## [x.y.z] - YYYY-MM-DD` changelog section.
2. Commit the version and changelog update, wait for `ci-green`, then create the
   signed `vX.Y.Z` tag at that commit.
3. Dispatch `Publish Package` with the exact tag. The workflow verifies
   tag/package/changelog consistency, runs `pnpm run verify`, requires live
   contract success, builds one tarball, runs an npm dry-run publish, records
   checksums and SBOM, publishes that exact tarball with npm OIDC provenance,
   starts the idempotent GHCR container-image publish from the same verified
   ref, and creates or updates the GitHub Release after npm publish succeeds.
   A Docker/GHCR failure can be retried against the same tag; it must not
   overwrite an existing versioned image whose recorded revision differs from
   the verified checkout SHA.

## Prerelease

Use npm semver prerelease tags such as `v0.2.0-rc.1`. Publish from the same
workflow and tag shape. Validate install commands against the prerelease tag
before advertising the release candidate outside the release issue.

## Rollback

npm package versions are immutable. If a published version is bad, deprecate it
with a direct reason and publish a fixed higher patch or prerelease version from
the protected workflow. If credentials, provenance, or package contents may be
compromised, follow `docs/SUPPLY_CHAIN_SECURITY.md` before publishing again.

## Deprecation

Deprecate only after the replacement version is available and installable:

```bash
npm deprecate @backblaze-labs/b2-mcp@<version> "Use <fixed-version>: <reason>"
```

Record the command, reason, replacement, and affected GitHub Release in the
release issue.
