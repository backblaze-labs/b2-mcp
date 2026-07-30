# Testing And Quality Gates

Owner: Sophie / QK (`@sophiecarreras`). Implementation owner: Gonza
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
that consumes `B2_*` secrets must use a protected GitHub environment, run only
from `main` or protected `v*` tags, serialize live write tests, and reference
only environment-scoped `LIVE_B2_*` secrets.
