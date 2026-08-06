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
for `pnpm run lint:docs`, where it validates TSDoc syntax and JSDoc hygiene for
the exported TypeScript tool/handler surface that Biome cannot validate. The
direct doc-lint packages are exact-pinned in `package.json`; the lockfile
snapshot above remains unchanged after reintroducing that narrow ESLint path.
The `@typescript-eslint/visitor-keys` override keeps its `eslint-visitor-keys`
resolution on a Node.js 22.3-compatible release so the full lockfile still
installs under the advertised package engine floor with `pnpm install --frozen-lockfile`.

Those are not the denied malicious versions recorded in the checked-in Wiz IOC
snapshot at [`../security/iocs/keyv-packages.csv`](../security/iocs/keyv-packages.csv)
and loaded through [`../supply-chain-denylist.json`](../supply-chain-denylist.json).
The current lockfile and publish packlist are checked by:

```bash
pnpm run audit:supply-chain:denylist --packlist
```

`pnpm run lint:docs` uses the repository-owned
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
- accepts only a `vMAJOR.MINOR.PATCH[-prerelease]` tag and checks it out only
  after proving it is reachable from the current `ci-green` history;
- runs `pnpm install --frozen-lockfile` with lifecycle scripts still disabled;
- builds explicitly, enforces the reviewed runtime package budget, requires
  `dist/index.js` in the packlist, runs the npm production audit and CycloneDX
  SBOM flow through `pnpm run release:sbom`, creates an npm tarball with
  lifecycle scripts disabled, scans that exact tarball through the safe denylist
  extractor, and uploads the tarball plus SBOM as seven-day artifacts for
  protected environment approval;
- runs the protected live B2 contract suite on the exact publish ref before the
  npm publish job can start;
- requires a protected `npm-publish` environment only for the final publish job;
- verifies the tarball SHA-256 before publishing;
- verifies the SBOM SHA-256 and attaches the SBOM to the GitHub release before
  publishing;
- uses npm trusted publishing with `id-token: write` and an OIDC preflight;
- publishes the prebuilt tarball with lifecycle scripts disabled:
  `npm publish <tarball> --provenance --access public --ignore-scripts`.

Do not publish from a developer workstation or from a workflow that has not
first proved the release tag is reachable from `ci-green`.
