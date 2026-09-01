# Supply Chain Security Workflow

Owner: Sophie / Quality Keeper (QK) (`@sophiecarreras`). Release owner: Gonza
(`@goanpeca`).

Issue #89 tracks the keyv/cacheable npm compromise response and the repository
controls that remain in force after the incident.

## Current Exposure Snapshot

As of 2026-08-05, this repository's `pnpm-lock.yaml` includes these related
transitive packages through the narrowly reintroduced ESLint doc-comment
toolchain:

- `file-entry-cache@8.0.0`
- `flat-cache@4.0.1`
- `keyv@4.5.4`

Biome remains the owner for code linting and formatting. ESLint is present only
for doc-comment scripts: `pnpm run lint:docs` validates TSDoc syntax and JSDoc
hygiene for the exported TypeScript tool/handler surface that Biome cannot
validate, while `pnpm run lint:tsdoc` is a TSDoc-only local diagnostic through
the same wrapper. The CI and `verify` gates stay on `lint:docs` so there is one
canonical doc-comment lint path. The direct doc-lint packages are exact-pinned
in `package.json`; `@microsoft/tsdoc-config` is pinned directly to make the
configuration reader version explicit, even though `eslint-plugin-tsdoc`
already depends on the same version transitively. The lockfile snapshot above
remains unchanged after reintroducing that narrow ESLint path.
Reviewer-owned dependency overrides live only in
[`../pnpm-workspace.yaml`](../pnpm-workspace.yaml), where the current entries
pin reviewed transitive fixes for packages including `@hono/node-server`,
`brace-expansion`, `eslint-visitor-keys`, and `js-yaml` (alongside the reviewed
Vercel build-toolchain pins) without duplicating override policy in
`package.json`.

Those are not the denied malicious versions recorded in the checked-in Wiz IOC
snapshot at [`../security/iocs/keyv-packages.csv`](../security/iocs/keyv-packages.csv)
and loaded through [`../supply-chain-denylist.json`](../supply-chain-denylist.json).
The current lockfile and publish packlist are checked by:

```bash
pnpm run audit:supply-chain:denylist --packlist
```

`pnpm run lint:docs` and `pnpm run lint:tsdoc` use the repository-owned
[`../scripts/run-doc-lint.mjs`](../scripts/run-doc-lint.mjs) wrapper rather than
executing the ESLint binary directly. The wrapper strips secret-like environment
variables, refuses local checkout credentials such as persisted GitHub
`extraheader` values, and preloads a best-effort lockdown module that denies the
tracked Node network, DNS, listener, child-process, and worker APIs before
ESLint plugins are loaded. This in-process denylist is not a complete sandbox;
review it when the Node runtime is upgraded and add newly exposed egress or code
execution APIs to the lockdown tests. CI jobs that run `lint:docs` also check
out with `persist-credentials: false`.

## Normal Install Policy

Lifecycle scripts are disabled by default in [`.npmrc`](../.npmrc). Normal
developer, CI, and packed-consumer installs must keep `ignore-scripts=true`.
The scanner rejects new `pnpm-lock.yaml` entries with `hasInstallScript`
unless the exact package path/name/version is added to the reviewed
`allowedLifecycleScripts` list, so dependencies that require a postinstall step
fail at the supply-chain gate instead of silently leaving a broken install.

Use `pnpm install --frozen-lockfile` from a clean checkout rather than `pnpm install` for verification.
Do not run `pnpm update` during an active package compromise unless the update is
the reviewed remediation itself and the resulting lockfile passes the denylist
and audit gates.

## Denylist And IOC Gate

The repository-owned denylist gate blocks:

- exact malicious package versions from the keyv/cacheable incident;
- unreviewed namespace additions that match the quarantined `@keyv/*` or
  `@cacheable/*` rules;
- known SHA-256 hashes for the npm preinstall loader, repository persistence
  loader, and second-stage payload;
- denied versions in `package.json`, `pnpm-lock.yaml`, `npm-shrinkwrap.json`,
  and `yarn.lock`;
- missing lockfile integrity on installed packages;
- unexpected lockfile lifecycle scripts;
- denied file hashes in checked-in files, npm packlists, expanded artifacts,
  tarballs, and installed `node_modules` indicator filenames.

The default supply-chain audit runs the denylist gate before the live pnpm audit:

```bash
pnpm run audit:supply-chain
```

CI also prepares an ephemeral npm production audit root under `.audit/` from the
committed `pnpm-lock.yaml` and runs the npm advisory gate required for release
candidates:

```bash
pnpm run audit:production
```

The production npm advisory gate evaluates `npm audit --json --omit=dev
--audit-level=moderate` through the same `audit-policy.json` exception model as
the full pnpm audit. Exceptions must remain scoped to the advisory, affected
package version and integrity, affected nodes, owner-reviewed risk analysis, and
an expiry date; expired or drifted exceptions fail closed on the deploy-gating
path.

Filesystem scan failures are reported as scanner errors instead of aborting the
process. Installed dependency trees are filtered while walking so only package
metadata, lockfiles, and configured indicator filenames are retained for
inspection.

Pull-request and `mark-green` CI scan only the tested ref and the protected
`origin/main` ref so a stale or poisoned side branch cannot block unrelated
deploys:

```bash
git fetch --prune --no-tags origin '+refs/heads/main:refs/remotes/origin/main'
pnpm run audit:supply-chain:denylist --ref HEAD --ref origin/main --packlist
```

During incident triage, run the all-branches scan from a fresh clone and treat
findings on non-protected branches as branch cleanup work unless the branch is a
release input:

```bash
git fetch --prune --no-tags origin '+refs/heads/*:refs/remotes/origin/*'
pnpm run audit:supply-chain:denylist --all-branches --packlist
```

When reviewing historical or downloaded workflow artifacts, expand them first
and scan the extracted directory:

```bash
gh run download --repo backblaze-labs/b2-mcp --dir /tmp/b2-mcp-artifacts
pnpm run audit:supply-chain:denylist --artifacts-dir /tmp/b2-mcp-artifacts
```

`gh run download` extracts GitHub artifact ZIPs by default. If another tool
produces a raw archive, extract it into a temporary directory before scanning.

## If A Denied Package Or IOC Is Found

Treat any host that installed or executed a denied package as compromised. Do
not keep using the host for source checkout, releases, B2 operations, or token
rotation.

Immediate response:

1. Disconnect the host from networks that can reach package registries, source
   control, cloud metadata, or production systems.
2. Preserve volatile evidence only if it does not require running repository or
   package scripts. Keep the lockfile, npm cache metadata, shell history, process
   list, and relevant CI logs.
3. Rebuild the host or runner from a clean image. Do not rely on package removal
   as remediation.
4. From a clean machine, revoke and rotate npm tokens, GitHub personal access
   tokens, GitHub App credentials, SSH keys, cloud credentials, Vault tokens,
   Kubernetes service account tokens, CI secrets, and any B2 application keys
   reachable from the host.
5. Audit GitHub for unexpected repositories, workflow changes, force pushes,
   new tags, or commits that add IDE hooks or lifecycle scripts.
6. Audit npm for unexpected package publishes under any reachable maintainer or
   automation identity.
7. Re-run the all-branches and artifact scans from a fresh clone before
   re-enabling release or deploy automation.

For B2-specific exposure, revoke compromised application keys rather than only
rotating the secret value. Prefer scoped replacement keys and record the affected
key IDs in the incident record.

## Updating The Denylist

Updates to [`../supply-chain-denylist.json`](../supply-chain-denylist.json)
must include:

- a checked-in package-source snapshot, package name/version entry, quarantine
  rule, lifecycle allowlist entry, or file indicator;
- the shared single-incident source URL and review date, or a new incident file
  if the source/provenance differs;
- any payload hashes or file indicators that can be checked without executing
  package code.

During an active incident, prefer exact deny entries and lockfile integrity over
floating "latest" remediation. If a package maintainer account remains
compromised, pin to a known-clean prior version until security owners approve a
newer release.

## Release Publishing Isolation

The only repository workflow allowed to publish npm packages is
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml). It:

- runs only in the canonical `backblaze-labs/b2-mcp` repository;
- pins every marketplace action to a reviewed commit SHA;
- starts from a successful unprivileged `Release Tag Request` workflow for
  `vMAJOR.MINOR.PATCH[-prerelease]` tag pushes or from an explicit manual
  dispatch for an existing tag;
- checks out the resolver from the trusted `ci-green` marker before running
  repository scripts, and checks out the tag only after proving it is reachable
  from the current `ci-green` history;
- verifies tag/package/changelog consistency, then runs
  `pnpm install --frozen-lockfile` with lifecycle scripts still disabled and
  `pnpm run verify`;
- builds explicitly, enforces the reviewed runtime package budget, requires
  `dist/index.js` in the packlist, runs the npm production audit and CycloneDX
  SBOM flow through `pnpm run release:sbom`, creates an npm tarball with
  lifecycle scripts disabled, scans that exact tarball through the safe denylist
  extractor, runs an npm dry-run publish from the tarball's staged package
  directory, writes SHA-256 checksums and versioned release notes, and uploads
  the tarball, SBOM, checksums, pack manifest, and notes as seven-day artifacts
  for protected environment approval;
- runs the protected live B2 contract suite once on the exact publish ref before
  the npm publish job can start;
- requires a protected `npm-publish` environment for npm publishing and a
  protected `ghcr-publish` environment for container publishing, so tag push
  alone cannot publish release artifacts;
- verifies the tarball SHA-256 and npm `dist.integrity` before staging the
  package directory for publishing;
- compares an already-published registry version's integrity to the verified
  local tarball before treating the run as an idempotent success;
- allows matching-integrity idempotent reruns for immutable legacy versions
  `0.1.0` and `0.1.1` with a warning when those versions still expose
  pre-fix `_from` or `_resolved` registry metadata;
- repacks the staged package directory and compares it to the verified tarball
  before invoking npm publish;
- verifies checksums and creates or updates the GitHub Release after npm publish
  and the public GHCR manifest check succeed, from a separate job that does not
  hold npm OIDC permission; the GHCR job is idempotent, so a Docker/GHCR retry
  does not require re-cutting the npm version;
- builds, smokes, and publishes the GHCR image from the same verified checkout
  SHA after npm publish succeeds, using `packages: write` and OIDC only for
  keyless signing, behind the protected `ghcr-publish` environment;
- publishes a multi-platform GHCR manifest for `linux/amd64` and `linux/arm64`,
  attaches BuildKit provenance and SBOM attestation manifests, signs the image
  index digest that contains those manifests with cosign keyless signing in the
  sibling `ghcr.io/backblaze-labs/b2-mcp-signatures` repository, records the
  image digest and pinned Node base digest in release metadata, and refuses to
  overwrite an existing version tag whose manifest revision differs from the
  verified checkout SHA;
- treats an already-published version tag as idempotent only after verifying the
  existing digest's prior cosign signature from this release workflow and
  checking the signed index contains BuildKit provenance and SBOM attestation
  manifests for each required platform; tag-push and manual rerun paths both use
  the protected `main` workflow identity after the same tag-to-`ci-green`
  validation, so the workflow does not sign a digest based only on
  caller-controlled OCI annotations; if a first publish dies after pushing tags
  but before signing, delete the unsigned GHCR package version documented in
  `RELEASE.md` and rerun the same tag;
- verifies the pushed version tag and sibling cosign signature repository
  anonymously before the GitHub Release job can run, so a private first-publish
  GHCR package fails the workflow until an owner sets the relevant package
  visibility to Public and reruns the same tag;
- publishes only immutable container tags: the package version without a leading
  `v` and the matching signed release tag; no mutable `latest` tag is produced;
- uses npm trusted publishing with `id-token: write` and an OIDC preflight;
- publishes the staged package directory with lifecycle scripts disabled:
  `npm publish <staged-package-directory> --provenance --access public --ignore-scripts`;
- verifies the published npm registry metadata does not include local
  `_from` or `_resolved` publish coordinates, using bounded retry for transient
  npm registry errors and short-lived post-publish propagation gaps.

Do not publish from a developer workstation or from a workflow that has not
first proved the release tag is reachable from `ci-green`. Treat
`refs/heads/ci-green` as an owned protected marker: only the `CI` workflow's
green-marker job may advance it after required `main` checks pass.

## Container Base Image Pinning

`Dockerfile` pins the Node.js base image by immutable digest, with the readable
`node:<version>-bookworm-slim` tag retained only as a comment. Treat that digest
as the container equivalent of a lockfile entry.

To update it:

1. Confirm `.nvmrc`, `runtime-policy.json`, and package `engines.node` still
   agree on the supported Node.js line.
2. Resolve the new multi-platform Node image digest:
   `docker buildx imagetools inspect node:<version>-bookworm-slim`.
3. Update every `FROM node:<version>-bookworm-slim@sha256:...` line in
   `Dockerfile` with the same reviewed index digest and update the review date
   comment.
4. Run `pnpm run test:unit`, `pnpm run test:contract`, and the container CI
   smoke path before release. The `container image` tests fail if a future
   `FROM` line uses a floating tag.
