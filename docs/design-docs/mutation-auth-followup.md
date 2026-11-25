# Auth mutation follow-up

Date: 2026-11-21 (client timezone; native logs continue into 2026-11-22 UTC).

## Scope and implementation

The change adds 101 cases in
[`auth-policy.unit.test.ts`](../../tests/unit/auth-policy.unit.test.ts).
Production `src/auth.ts`, mutation configuration, thresholds, exclusions, and
existing skips are unchanged. Existing behavior passed the new assertions; no
production defect was reproduced or fixed in this scope.

The tests use the real official SDK and public MCP transport with recording
transports. Unexpected external fetches fail locally. Factory construction tests
replace fetch with valid authorization responses and verify actual outbound
credentials, user agent, and test realm. They do not replace authorization
results or SDK retry decisions with mocks.

The asserted contracts include:

- Complete flattened authorization metadata; SDK client/configuration wiring;
  factory restrictions outside the test runtime; native and Partner user agents.
- The exact 23-hour cache boundary, including timestamp zero; SDK endpoint
  refresh; invalidation and a force refresh of an already populated cache.
- URL guard propagation and lockdown after authorization and SDK realm changes.
- Cleanup of abort listeners after shared authorization success/failure; null
  abort reasons; independent caller cancellation and later healthy callers.
- All 20 no-replay endpoint names and supported prefixed/versioned URL shapes.
- All three HTTP-date forms, including two-digit asctime days, malformed dates,
  and exact/beyond-50-year RFC850 dates across a century boundary. The expected
  cutoff follows [RFC 9110 section 5.6.7](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7).
- Response adapters, successful response capture, and original body-error causes.
- Retry accounting for all configured retryable statuses, terminal statuses,
  network failures, different supported body kinds, and equivalent empty bodies.
- Definitive non-2xx statuses with unreadable bodies, including 199 and 300;
  successful read-body failures retain their original error rather than being
  classified as an unknown write outcome.

Deferred authorization fixtures attach rejection handlers immediately. Their
`finally` blocks always settle and drain the shared operations. An ignored abort
is observed within one event-loop turn so the assertion can fail while cleanup
still runs. This matters because assertion failures are expected during mutation
testing.

## Reproduction and evidence

The isolated source baseline is commit
`69c3f1d640f3fc9302e495ae2f1ea810c697c597` with frozen dependencies,
Node 22.23.1, pnpm 11.20.0, Stryker 10.0.0, and Vitest 4.1.12.

```sh
npm exec --yes --package=node@22.23.1 -- pnpm install --frozen-lockfile
npm exec --yes --package=node@22.23.1 -- pnpm exec vitest run \
  --config vitest.config.mts --project=unit tests/unit/auth-policy.unit.test.ts
npm exec --yes --package=node@22.23.1 -- pnpm run typecheck
npm exec --yes --package=node@22.23.1 -- pnpm exec biome check \
  tests/unit/auth-policy.unit.test.ts
npm exec --yes --package=node@22.23.1 -- pnpm exec cspell \
  tests/unit/auth-policy.unit.test.ts
npm exec --yes --package=node@22.23.1 -- pnpm run test:mutation -- \
  --mutate=src/auth.ts --concurrency=2 --reporters=json,clear-text,progress
```

The fresh before run used concurrency 1. Each run instrumented the same 486
mutants. Reports must be joined by mutant ID; Stryker changes the array order
when import-time mutants are deferred to the end of a run.

| Completed measurement | Killed | Timeout | Survived | No coverage | Errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fresh baseline, suspension affected | 286 | 16 | 179 | 5 | 0 |
| First complete improvement, 89 cases | 403 | 13 | 67 | 3 | 0 |
| 101 cases, timing affected; not definitive | 417 | 21 | 45 | 3 | 0 |
| Final integrated 101 cases, sleep inhibited | 424 | 13 | 46 | 3 | 0 |

The first complete improvement retained all 286 baseline assertion kills and
converted 113 baseline survivors, two uncovered mutants, and two baseline
timeouts into assertion kills. One baseline timeout survived; a timeout is a
detection category, not an assertion proving the behavior.

The observed baseline is fresh but not a pristine timing reference: macOS power
logs show an Idle Sleep from 00:16:49 to 00:25:36 (local UTC-03:00) overlapping the
baseline's 23:49:26 to 00:35:05 log interval. Its 62.14% reported score and
timeouts therefore retain that limitation. The completed 89-case measurement
(00:27:40 to 00:43:37) had no overlapping sleep event, making it the clean
comparison for the final 12 added cases. A second lengthy baseline is not
needed to verify the current policy assertions.

The 101-case run has a host-clock discontinuity: progress was around 12 minutes
before a roughly hour-long jump; the native completion reports 77m57s. Compared
with the completed 89-case measurement, 21 survivors became assertion kills,
but seven previous assertion kills became timeouts (IDs 36, 37, 38, 39, 41, 75,
487), and survivor 482 became a timeout. The other 13 timeouts were unchanged.
Its reported 90.12% score must not be treated as a reliable final improvement
based on those eight extra timeouts.

The campaign confirmed host Sleep/DarkWake events in macOS power logs and preserves
this report as timing-affected evidence. An integrated attempt with idle-only
inhibition (`/usr/bin/caffeinate -i`) subsequently timed out during its initial
dry run after maintenance sleep; it produced no completed mutation measurement.
Its log is preserved as `mcp-all-auth-final-awake.log`.

The corrected integrated scope uses transient, process-scoped idle and system
sleep inhibition while on AC (`/usr/bin/caffeinate -is`); the campaign verified
both power assertions belong to that process. It changes no permanent power
settings or product behavior. The authoritative completed integrated raw report
is retained at `reports/mutation/final-integrated/mutation.json`.
This is a bounded repair of the observed timing anomaly, not repeated execution
until a preferred score appears.

Raw isolated evidence is gitignored under `reports/mutation/`:

- `before/mutation.json`: fresh baseline.
- `after-first-complete/mutation.json`: completed 89-case improvement.
- `timing-affected/mutation.json`: timing-affected 101-case run.
- `auth-isolated-audit.json`: all 486 mutant IDs with before, first-complete,
  and timing-affected statuses, plus measurement caveats and frozen hashes.

Local logs are under `/tmp/mutation-audit-20261121/mcp-auth-*.log`. Two earlier
incomplete runs were cancelled after review found deferred-fixture cleanup
weaknesses. Their cancellation logs are retained; their progress counters are
not measurements. Initial fixture corrections (SDK-required metadata, valid
error JSON, exported SDK types, and readonly fields) are not production bugs.

## Retained mutants and limits

The following groups describe bounded reasons for retaining the 45 survivors
from the timing-affected report, plus the previously surviving ID 482. The fresh
integrated report is authoritative about final statuses. None is suppressed or
excluded from mutation testing. These are not claims of universal equivalence
for arbitrary invalid objects, alternative transports, or future SDK versions.

| IDs | Retained behavior or limitation |
| --- | --- |
| 50 | A missing endpoint cannot be a member of the string-only no-replay set. |
| 91, 93, 99, 102 | Diagnostic reason extraction/structured log fields. Recognition already restricts ordinary reasons; no exact diagnostic-shape assertions were added solely for score. |
| 107 | Changes the configurability of the preserved error `cause` descriptor; original cause identity is asserted. |
| 128, 129, 130, 132 | JSON null round-trips to null; undefined cloning falls back to the original value. |
| 173, 174, 175, 180, 182, 183, 184, 351, 352 | Defensive body-context guards/reset paths. The public wrapper supplies context, resets each attempt, and records the definitive status before body handling; several mutations converge on the same outer error. No private context is injected to manufacture differences. |
| 193, 198, 206, 208 | Paired missing-path guards and catch-return behavior converge on undefined for malformed/non-B2 paths. Changing either missing-index guard alone leaves the other guard intact. |
| 278 | For the remaining standard body kinds, constructor-name/length versus object-tag keys preserve the tested identity partition. This is not a claim about arbitrary body subclasses. |
| 294 | The first century-adjustment loop overshoots, then the second loop reaches the same allowed year for bounded supported dates. |
| 304, 317, 319, 323 | Standard Headers trims surrounding whitespace; regex alternatives determine field presence; omitted asctime padding parses to the same date; the invalid fallback remains invalid. |
| 355, 376 | The outer public transport injects a signal before the inner budget transport runs. |
| 413, 414, 415, 416, 420, 421, 425, 426, 431, 432 | Promise settlement and abort-listener cleanup make these settled/once/extra-handler variations redundant for ordinary AbortSignal delivery. No artificial redispatch or private-state assertion was added. |
| 439, 443 | The normalized SDK authorization contract requires `storageApi.allowed`. |
| 470, 482, 484 | Normal manager/SDK cache transitions maintain the paired cache/time lifecycle invariant. ID 482 was previously a survivor and became an anomalous timeout in the timing-affected run. |

Three mutants remain **uncovered defensive branches**, not proven globally
unreachable and not evidence of complete auth coverage:

- **74:** the non-Error abort fallback. Ordinary errors through the supported
  SDK boundary are canonicalized; an alternative error-producing integration
  could still warrant a future test.
- **135:** the failed JSON-clone fallback. Cyclic or otherwise non-JSON payloads
  cannot originate from parsing valid wire JSON, but a custom response could
  supply one.
- **440:** absent capabilities fallback. The pinned SDK's normalized
  `AllowedInfo.capabilities` field is required. An SDK contract change could
  make this branch relevant.

The scoped focused suite passes all 101 cases. Typecheck, Biome, and spellcheck
pass. The integrated required verification and final auth native measurement
are recorded in the campaign report so the cross-module result has one owner.

Frozen SHA-256 values:

- `src/auth.ts`: `440ce7606ef4fea377c3e88da9a69657b6bd2bbfe6c6e8a92d5a798cf6ab07f5`
- `tests/unit/auth-policy.unit.test.ts`: `a2151dbee366834cc9d9ca45338d761b175bbace3135542a9fe7f08067b51941`

## Authoritative integrated result

The corrected full auth scope completed successfully in 14m8s: 424 assertion
kills, 13 watchdog detections, 46 survivors, three uncovered branches, and zero
runner errors. Its total score is 89.92% (90.48% of covered mutants). The source
hash matches the isolated reports; this run includes the final combined policy
tests and source fixes from the other subtasks.

Compared with the clean 89-case measurement, all 403 prior assertion kills and
13 watchdog detections were retained, and 21 former survivors became assertion
kills. All seven anomalous prior-kill timeouts returned to assertion kills;
ID 482 returned to a survivor. The retained groups above therefore describe the
final 46 survivors. All three uncovered defensive branches remain explicit.

`reports/mutation/final-integrated/` retains the raw native report, completed
log, and ID-joined verification manifest. The sleep-affected run is preserved
separately and contributes no extra detections to this authoritative result.
