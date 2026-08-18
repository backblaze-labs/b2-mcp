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
8. Confirm the GHCR package `ghcr.io/backblaze-labs/b2-mcp` is public before
   advertising Docker run commands. On the first container release, if the
   initial push creates a private package, set the package visibility to Public
   in GitHub Packages and rerun the same publish tag. The workflow fails until
   an anonymous manifest inspection succeeds.
9. Confirm the `ghcr-publish` GitHub environment exists, requires trusted
   release approval, and restricts deployments to protected release refs.
10. Confirm `live-b2-contract` has environment secrets `LIVE_B2_KEY_ID` and
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
11. Confirm any claimed MCP SDK package split is either implemented or tracked as
   a release-blocking follow-up once the upstream package exists.
12. Push the release commit and `v*` tag, then publish only from the canonical
    repository through the protected `.github/workflows/publish.yml` workflow.
    Do not publish from a developer workstation. The tag push first runs the
    unprivileged `Release Tag Request` workflow; `Publish Package` then runs
    from the default-branch workflow, checks out trusted resolver code from
    `ci-green`, and must prove the `v*` tag is reachable from `ci-green`, build
    explicitly, enforce the runtime package budget, scan the generated packlist
    and tarball, generate and verify a CycloneDX production SBOM artifact, call
    the protected live B2 contract workflow as a pre-release gate, verify the
    tarball SHA-256, publish the already-scanned tarball with lifecycle scripts
    disabled, publish and verify the GHCR image, and attach the SBOM to the
    GitHub Release only after npm publish and GHCR publishing succeed.
13. Confirm the release tag ruleset only allows release owners to create
    `v*` tags and does not allow force-updating or deleting release tags.
14. Confirm `refs/heads/ci-green` is treated as an owned protected marker:
    only the `CI` workflow's `mark-green` job may force-push it after all
    required `main` checks pass, and humans must not push it directly.

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
4. Push the signed `v0.1.0` tag to run the publish workflow. The workflow must
   publish the verified tarball with OIDC provenance; do not publish a different
   local tarball to bootstrap the package.

## Normal Release

1. Start from a clean, up-to-date `main`, confirm the intended release content
   is under `[Unreleased]`, and run the deterministic local gate listed above.
2. Confirm release tags will be signed with `git config --get tag.gpgSign`, then
   run `pnpm version patch`, `pnpm version minor`, or `pnpm version major`. If
   `tag.gpgSign` is not enabled in the release checkout, pass
   `--sign-git-tag` to that `pnpm version` command instead. The package
   `version` lifecycle promotes `[Unreleased]` into a dated
   `## [x.y.z] - YYYY-MM-DD` changelog section, stages `CHANGELOG.md`, creates
   the version commit, and creates the matching `vX.Y.Z` tag.
   Release tags are signed.
3. Push the release commit and tag:

   ```bash
   git push --follow-tags
   ```

   The tag push starts `Release Tag Request`, and its successful completion
   starts `Publish Package` from the default branch. The publish workflow waits
   until the tag is reachable from the protected `ci-green` marker, then verifies
   tag/package/changelog consistency, runs `pnpm run verify`, requires live
   contract success, builds one tarball, runs an npm dry-run publish, records
   checksums and SBOM, publishes that exact tarball with npm OIDC provenance,
   publishes and anonymously verifies the idempotent GHCR container image from
   the same verified ref, and then creates or updates the GitHub Release. A
   Docker/GHCR failure can be retried against the same tag; it must not sign an
   existing digest unless that digest already has this workflow's trusted
   signature plus provenance and SBOM attestations, and it must not overwrite an
   existing versioned image whose recorded revision differs from the verified
   checkout SHA.
4. To re-run publishing for an existing tag after a transient external failure,
   use the unprivileged `Release Tag Request` workflow's `workflow_dispatch`
   input with the existing `vX.Y.Z` tag. Its successful completion starts
   `Publish Package` from the default branch. Do not delete, force-move, or
   re-push the tag. Creating or editing a GitHub Release is not a publish
   trigger; the workflow creates or updates the GitHub Release only after npm
   and GHCR succeed.
5. If GHCR has the version/release tags but the retry fails because the digest is
   unsigned or missing trusted attestations, delete that specific GHCR package
   version and rerun the same tag:

   ```bash
   VERSION=0.1.0
   version_id="$(
     gh api orgs/backblaze-labs/packages/container/b2-mcp/versions \
       --jq ".[] | select(.metadata.container.tags[]? == \"${VERSION}\") | .id" \
       | head -n 1
   )"
   gh api --method DELETE "orgs/backblaze-labs/packages/container/b2-mcp/versions/${version_id}"
   ```

## Prerelease

Use npm semver prerelease tags such as `v0.2.0-rc.1`. Publish from the same
`pnpm version prerelease --preid rc` and `git push --follow-tags` flow. Validate
install commands against the prerelease tag before advertising the release
candidate outside the release issue.

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
