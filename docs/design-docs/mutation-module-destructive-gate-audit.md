# Destructive gate detector ownership follow-up

Date: 2026-11-23. Tracking: [demand-side-ai #2006](https://github.com/backblaze-labs/demand-side-ai/issues/2006).

## Result and public contract

The saved full native result was 240 generated mutants, all 240 killed by
assertions, with no survivor, uncovered, timeout, ignored, or error mutants
(100%). Its source exactly matched the module sweep seed. Reviewing the public
helper contract nevertheless found a detector ownership bug outside those
recorded mutant identities.

The exported [gate helpers](../../src/utils/destructive-gate.ts) accept string
tool names. Registry membership must mean a registered destructive detector;
`destructiveEffect` promises a string or null. An ordinary Object registry also
inherits names such as constructor, toString, valueOf, hasOwnProperty, and
`__proto__`. The old `in` check incorrectly reported those as detectors.
Effect lookup returned an object for constructor, returned a stringified object
for toString, and threw a TypeError for `__proto__` rather than returning null.

Production currently registers fixed tool names. This is a public-helper
robustness and registry ownership fix; no current registered-tool destructive
bypass was established. An unknown name receiving non-detector treatment here
does not establish that the MCP dispatcher permits an unregistered tool call.

## Test-first change

Five public inherited-name regressions first failed on unchanged production
source. Adding ordinary unknown-name and registered destructive-name controls
retained the same five failures while both controls passed. The tests exercise
membership, effect output, and block-policy results through exported helpers;
no private registry, fabricated SDK context, or mutation-engine phrase is used.

The minimal fix makes membership use Object.prototype.hasOwnProperty.call,
compatible with the configured TypeScript library, and calls a detector only
when that owned membership check succeeds. Valid detector return types remain
string or null. A Fixed release fragment records the behavior.

All seven new cases pass after the fix. Existing gate/consent/elicitation suites
pass alongside them: **225 tests across five files**, zero skips. They cover
all detector effects and policies, independent credential-bound canonical HMAC
vectors, target/tool/credential mismatch refusal, asynchronous consent scope,
and real S3 lifecycle callback refusal with no write-method call. All-test
typecheck and changed-source/test Biome lint/format also passed.

## Mutation scope and provenance

The original source SHA-256 was
`eb60f3b842ce5307e148147ecf3847d421dfa884a621abdb54b87e641ce90dbf`.
The fixed source SHA-256 is
`050c6e3073fa307023029fd3f706568b2d60e6a1b1aefe488a0a61be789b75e7`.
The complete saved 240-mutant signature/status list is retained, not replaced
by a claim that the five regressions killed five pre-existing survivors.
There were none. Source changes generate a different fault corpus.

Before this change, the mutation configuration, wrapper, dedicated Vitest
configuration, and isolated tooling manifest/lockfile exactly matched main
69c3f1d. The configured six-module priority list still includes the complete
destructive-gate file. The saved CLI scope was the complete file, not selected
lines. Coverage analysis remains per-test, static-mutant ignoring remains the
pre-existing setting, and no mutation operator exclusions were added. Every
mutant in the saved gate result had Killed status, including zero ignored
entries. The wrapper still installs reviewed Stryker 10.0.0 using its frozen
isolated lockfile. Advisory score thresholds are unchanged and do not replace
independent review or behavioral evidence.

An isolated no-space checkout used its own frozen dependencies, Node.js
22.23.1, and pnpm 11.20.0. No live B2 credentials or durable operations were
used. The shared TDD policy was read before implementation; observed red/green
results are retained. Ignored `reports/mutation/module-sweep-destructive-gate/`
contains baseline signatures/report, source/configuration hashes, public probe,
red/green and focused logs, final native evidence, and the handoff summary.
The first optional pnpm/tsx probe stalled before output and was stopped; the
direct pinned-Node public probe completed. That setup attempt is not behavioral
red. Root owns combined required verification and package-size review.

## Final full native measurement

The fixed source's complete native run completed successfully in **55 seconds**
with concurrency one and process-scoped sleep inhibition: **238 generated,
238 assertion kills, zero survived, uncovered, ignored, timeout, or error
mutants; 100%**. This is a fresh full-file run. The previously saved 240-mutant
result is the source-matched before snapshot, not a rerun by this module pass.

Owned-only effect lookup changes the generated set from 240 to 238. Exact
source-fragment, operator, replacement, and unchanged-location matching is
recorded in comparison.json; changed and unmatched nodes remain explicit.
The successful public inherited-name regressions are evidence for the new
behavior, independently of the generated-mutant score. All mutation settings,
operator exclusions, static handling, thresholds, dependencies, and existing
skips remain unchanged.
