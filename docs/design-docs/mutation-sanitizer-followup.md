# Sanitizer Remaining-Mutant Follow-up

Date: 2026-11-21 (client timezone; native logs continue into 2026-11-22 UTC). This follow-up is based on pending PR #580 and leaves that
branch untouched. It adds 24 cases and two reproduced fixes.

## Reproduced fixes

A Proxy can legally report a different value for an array's writable length
descriptor, even though the descriptor is not configurable. A safe integer of
`2 ** 32` therefore reached the output array assignment and threw `RangeError`.
The regression failed before the fix. Lengths must now also be at most
`0xffffffff`; tests preserve the valid maximum and reject negative, fractional,
unsafe, string, and object values without coercion. Enumerable secret fields
remain redacted when the output uses an inert length.

Configured secrets matching part of the literal `[redacted]` marker could
corrupt existing markers. The new marker suite initially had seven failures.
The core now precomputes every matching offset within the constant marker and
skips only original matches wholly contained in an intact marker. Additional
work per match is bounded by the marker width, independent of text length.
Tests cover repeated characters, adjacent markers, outside and overlapping
secrets, and real matches crossing either marker boundary.

This is intact-marker preservation, not universal fixed-point normalization.
Replacing a crossing match can expose or form a new textual match; the existing
generic second pass still handles exposed configured-secret fragments. The
implementation does not repeatedly sanitize until stable.

The suite also exercises safe Error fallbacks using a legal self-mutating proxy
that removes only its own target's configurable fields/prototype during
reflection. Global `Error.prototype` and built-in methods remain untouched;
returned metadata is still sanitized.

## Verification and measurement

```bash
pnpm exec vitest run --config vitest.config.mts --project=unit tests/unit/secret-sanitizer-proxy-boundaries.unit.test.ts tests/unit/secret-sanitizer-marker-preservation.unit.test.ts tests/unit/secret-sanitizer-policy.unit.test.ts tests/unit/secret-sanitizer.unit.test.ts tests/unit/secret-sanitizer.property.unit.test.ts
pnpm run test:mutation -- --mutate=src/utils/secret-sanitizer.ts --concurrency=1 --reporters=json,clear-text,progress
```

All five focused suites passed: 182 tests. Typecheck, Biome, spelling, and diff
checks passed. The native Proxy invariant was also checked independently on
Node.js 22.23.1. Red/green replays, source/test hashes, and the four-file patch
are retained under ignored `reports/mutation/` and the campaign log directory.

| Scoped stage | Mutants | Killed | Timeout | Survived | Uncovered | Score |
| --- | --- | --- | --- | --- | --- | --- |
| Fresh PR #580 baseline | 526 | 473 | 6 | 45 | 2 | 91.06% |
| Intermediate array-bound fix | 531 | 483 | 6 | 42 | 0 | 92.09% |
| Final marker and array fixes, integrated tests | 555 | 503 | 6 | 46 | 0 | 91.71% |

The intermediate row excludes the later marker fix and marker suite. The final
row is a completed native scope against the latest source and integrated tests,
using concurrency 2; its raw report is retained in
`reports/mutation/final-integrated-first-pass/mutation.json` in the sanitizer
follow-up checkout. It completed without uncovered mutants or runner errors.
Source changes alter the generated mutant set; timeout detections remain
separate from assertion kills. No thresholds, mutation exclusions, or test
skips were changed.

## Retained mutations

The final 46 survivors remain visible in the score. They include redundant
guards, equivalent ordering/overlap operations, ignored inert candidates, and
performance-only changes under current inputs. Marker-offset prefilter removal
is redundant with the actual secret match and full-marker check. Expanding the
offset loop performs extra checks for long secrets without changing output.
The old exact-marker skip is now redundant with the marker-preservation core.

Three synthetic literal-injection survivors change the configured secret lists
and can over-redact a phrase absent from configuration. These are non-equivalent
presentation differences, retained rather than tested against Stryker's chosen
phrase. No universal fixed-point or complete fault-detection claim is made.
Detailed mutant locations and bounded rationales accompany the raw report.
