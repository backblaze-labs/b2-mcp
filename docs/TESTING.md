# Testing And Quality Gates

Owner: Sophie / QK (`@sophiecarreras`). Implementation owner: Gonza
(`@goanpeca`).

Status: skeleton. Issues #50, #51, #52, #60, #61, and #63 own the test-gate
implementation.

## Deterministic PR Gate

The PR gate must not require real B2 credentials. The intended gate is:

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:integration
npm run test:contract
npm audit --omit=dev
```

`test:integration` and `test:contract` are tracked as required Phase 1 work
until they are deterministic, credential-free, and wired into CI.

## Live B2 Smoke Gate

Live B2 evidence is required before release sign-off but must be isolated from
normal PRs and untrusted forks.

Required properties:

- scoped, non-master application key;
- throwaway bucket or tightly scoped prefix;
- one controlled write/read/delete round trip when the key allows writes;
- teardown that cannot affect unrelated objects;
- logs and tool responses checked for credential redaction.

The live path runs through `.github/workflows/smoke.yml` or a protected manual
equivalent.
