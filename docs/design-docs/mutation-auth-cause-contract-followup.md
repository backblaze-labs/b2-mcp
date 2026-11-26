# Auth cause configurability contract decision

Date: 2026-11-23. Source baseline: `971e171ce22b13df1b70e9b9341cd0c773928575`.

## Decision

Retain the recorded `auth:107` survivor without a new assertion or production
change. It changes `configurable: true` to `false` on the `cause` installed in
[`raiseUnknownStatusWrite`](../../src/auth.ts). No supported consumer found in
this checkout or its pinned B2 SDK depends on deleting or redefining that
property. This is a bounded contract decision, not a claim of universal
JavaScript equivalence: reflection, deletion, and redefinition can distinguish
the descriptors.

The original error's identity and readable provenance are meaningful contracts.
They already have direct coverage in
[`auth-policy.unit.test.ts`](../../tests/unit/auth-policy.unit.test.ts) and
[`auth-defensive-boundaries.unit.test.ts`](../../tests/unit/auth-defensive-boundaries.unit.test.ts).
A descriptor-only assertion would add an incidental requirement without an
independent consumer requirement. No source, tests, mutation thresholds,
exclusions, skips, or package budgets were changed.

## Consumer evidence

- [`named-error.ts`](../../src/utils/named-error.ts) reads `.cause` and traverses
  chains with cycle detection. [`circuit-breaker.ts`](../../src/utils/circuit-breaker.ts)
  reads the originating interruption to distinguish caller aborts from provider
  failures. Both descriptors permit these reads.
- [`errors.ts`](../../src/utils/errors.ts) constructs normalized response
  objects from status, code, message, and request metadata, or reads a cause
  chain. It does not mutate the input error's cause.
- [`logger.ts`](../../src/utils/logger.ts) sanitizes arguments before passing
  them to Pino. [`secret-sanitizer.ts`](../../src/utils/secret-sanitizer.ts)
  creates fresh objects/errors and copies sanitized enumerable data properties.
  The installed cause is non-enumerable under either descriptor; sanitization
  does not delete or redefine it on the original error. The unknown-outcome
  warning itself receives explicit endpoint/status/code/reason fields.
- [`secret-sink.ts`](../../src/utils/secret-sink.ts) can wrap a failure in a new
  `DurableSecretPostCreateFailure`, retaining the original as its own cause.
  Wrapping does not redefine the cause on the original B2 error.
- Repository source, tests, README, changelog, and docs were searched for cause
  reads, assignments, deletion, descriptor operations, and a promise of cause
  mutability. Existing follow-up docs describe identity/provenance, not deletion
  or redefinition. The package exports its CLI entry point and package metadata;
  it does not export `auth.ts` as a supported package subpath.

The isolated frozen install resolves `@backblaze-labs/b2-sdk` 0.4.0. Its
`dist/errors/index.js` B2Error constructor calls `super(response.message)` and
copies response/retry metadata; it does not install a cause or promise a
configurable one. `dist/http/transport.js` returns B2Error instances unchanged
from the terminal-error catch path. Upload retry normalization likewise returns
an existing B2Error unchanged. SDK cause assignments found by search belong to
constructors for new NetworkError/response-body error instances; other cause
uses read provenance. No delete/redefine consumer was found in the installed
SDK JavaScript.

For context, an exploratory Node 22.23.1 probe observed native
`new Error(message, { cause })` as writable, non-enumerable, and configurable.
The repository's custom installed cause is non-writable, non-enumerable, and
configurable. Native Error options therefore do not establish full descriptor
compatibility for this custom B2Error property. The probe is audit evidence,
not a new test or a reason to change production descriptors.

## Verification and limits

Read the shared TDD policy, repository AGENTS/CLAUDE guidance, and testing guide.
No nested AGENTS/CLAUDE files were present. This documentation-only decision
uses the policy's documentation exception; no behavioral red or implementation
step is claimed.

The no-space execution copy `/tmp/b2-mcp-survivor-cause-contract` used its own
frozen dependencies, Node 22.23.1, and pnpm 11.20.0:

```sh
npm exec --yes --package=node@22.23.1 -- pnpm install --frozen-lockfile
npm exec --yes --package=node@22.23.1 -- pnpm exec vitest run \
  --config vitest.config.mts --project=unit \
  tests/unit/auth-policy.unit.test.ts \
  tests/unit/auth-defensive-boundaries.unit.test.ts \
  tests/unit/circuit-breaker.unit.test.ts tests/unit/errors.unit.test.ts \
  tests/unit/secret-sanitizer.unit.test.ts
```

The five existing files passed: 204 tests, zero skips. These are baseline
consumer checks, not a fresh mutation measurement. No mutation run was warranted
without a legitimate new distinguishing case; old ID 107 is identified by
source/function/BooleanLiteral replacement rather than assumed to retain its ID
in a future scoped report. Ignored audit evidence lives under
`reports/mutation/cause-contract/`.

The focused CSpell check passed with zero issues; `pnpm run lint:links` passed.
Final whitespace review passed. Initial restricted npm attempts stalled without
output and were interrupted; the install and test results above came from the
successful network-enabled invocations.

This audit cannot inventory unknown downstream code or establish its private
requirements. Revisit this decision if a documented supported consumer needs to
delete/redefine cause as part of a real workflow. The combined mandatory gate
is owned by the parent campaign and is not claimed by this isolated audit.
