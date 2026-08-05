# Supply Chain Security Workflow

Owner: Sophie / Quality Keeper (QK) (`@sophiecarreras`). Release owner: Gonza
(`@goanpeca`).

Issue #89 tracks the keyv/cacheable npm compromise response and the repository
controls that remain in force after the incident.

## Current Exposure Snapshot

As of 2026-08-05, this repository's `package-lock.json` includes these related
transitive packages through the ESLint toolchain:

- `file-entry-cache@8.0.0`
- `flat-cache@4.0.1`
- `keyv@4.5.4`

Those are not the denied malicious versions recorded in
[`../supply-chain-denylist.json`](../supply-chain-denylist.json). The current
lockfile and publish packlist are checked by:

```bash
npm run audit:supply-chain:denylist -- --packlist
```

## Normal Install Policy

Lifecycle scripts are disabled by default in [`.npmrc`](../.npmrc). Normal
developer, CI, and packed-consumer installs must keep `ignore-scripts=true`
unless a documented release step explicitly opts in.

Use `npm ci` from a clean checkout rather than `npm install` for verification.
Do not run `npm update` during an active package compromise unless the update is
the reviewed remediation itself and the resulting lockfile passes the denylist
and audit gates.

## Denylist And IOC Gate

The repository-owned denylist gate blocks:

- exact malicious package versions from the keyv/cacheable incident;
- known SHA-256 hashes for the npm preinstall loader, repository persistence
  loader, and second-stage payload;
- denied versions in `package.json`, `package-lock.json`, `npm-shrinkwrap.json`,
  `pnpm-lock.yaml`, and `yarn.lock`.

The default supply-chain audit runs the denylist gate before the live npm audit:

```bash
npm run audit:supply-chain
```

CI also scans every fetched branch ref before `ci-green` can advance:

```bash
git fetch --prune --no-tags origin '+refs/heads/*:refs/remotes/origin/*'
npm run audit:supply-chain:denylist -- --all-branches --packlist
```

When reviewing historical or downloaded workflow artifacts, expand them first
and scan the extracted directory:

```bash
gh run download --repo backblaze-labs/b2-mcp --dir /tmp/b2-mcp-artifacts
npm run audit:supply-chain:denylist -- --artifacts-dir /tmp/b2-mcp-artifacts
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

- the package name and exact denied version;
- the source URL used for the update;
- the review date;
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
- requires a protected `npm-publish` environment;
- checks out the `ci-green` commit only after proving the requested `v*` tag
  points at `ci-green`;
- runs `npm ci` with lifecycle scripts still disabled;
- re-runs the denylist and audit gates;
- uses npm trusted publishing with `id-token: write`;
- enables lifecycle scripts only for the final
  `npm publish --provenance --access public --ignore-scripts=false` command.

Do not publish from a developer workstation or from a workflow that has not
first resolved the exact `ci-green` commit.
