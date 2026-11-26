# Six-module survivor sweep

Date: 2026-11-23. Tracking: [demand-side-ai #2006](https://github.com/backblaze-labs/demand-side-ai/issues/2006).

One dedicated subagent reviewed each of the six mutation modules, in overlapping
waves of three workers. Each owned an isolated checkout based on cumulative
validation seed `69c8f35fcd3ce02c2bab40156dab456ecbc8173e`. The six module deltas have separate follow-up branches; existing PR branches
were preserved. The seed includes earlier pending PR changes and is validation
evidence rather than a publication branch.

## Outcomes

| Module | Starting survivors | Outcome |
| --- | ---: | --- |
| Auth | 42 | Two public SDK cache-refresh cases kill the optional cache-access target. No production edit. Fresh same-source native: 434 killed, 13 watchdog detections, 41 survivors, one uncovered; 91.21% to 91.41%. |
| Secret sanitizer | 46 | Ten regression cases and a fix preserve own prototype-named keys in JSON, arrays, and log Errors. Fresh native result: 560 generated, 505 killed, seven watchdog detections, 48 survivors, 91.43%. The two added survivors change helper descriptor flags; all 46 old survivors remain. |
| Destructive gate | 0 | Seven cases and an own-registry lookup fix reject inherited detector names. Fresh native result: 238 killed, zero survivors or uncovered, 100%. |
| Destructive elicitation | 21 | All retained under reviewed JSON/SDK contracts; 138 existing focused cases pass. Reused source-matched native result: 96.15%. |
| Credentials | 8 | All retained with exact-fragment rationales; 146 existing focused cases pass. Reused source-matched native result: 98.14%. |
| Tool capabilities | 1 | Null scopes converge through the operation helper; 93 existing focused cases pass. Reused source-matched native result: 99.58%. |

All retained judgments are bounded to current supported inputs and consumers.
No impossible private states, generated-phrase assertions, private call counts,
or arbitrary timing gates were added to manufacture kills. Mutation thresholds,
operators, scope, exclusions, and existing skips were preserved.

## Behavioral evidence

The sanitizer assigned input property names into fresh objects, arrays, and
Errors. Valid JSON can contain an own `__proto__` field; assignment invoked the
legacy setter instead of preserving that field. Error metadata could also
replace the sanitized Error's prototype. Ten public cases failed before a
shared data-property definition helper fixed all three copy sites. The helper
retains normal writable, configurable, enumerable assignment semantics and
still sanitizes nested actual secrets. This issue was found during the audit,
not established as an old survivor kill.

The destructive registry used inherited membership and property lookup. Public
calls with names such as `constructor`, `toString`, and `__proto__` could be
misclassified, return a non-string effect, or throw. Five regression cases
failed and two controls passed before the owned-only lookup fix; 225 focused
cases passed afterward. The production server currently registers fixed tool
names: no current-tool destructive bypass was established. The old 240/240
score did not model this defect. New source generates 238 mutants; changed
nodes are retained separately in the comparison rather than joined by ID.

Auth invalidation clears caches without revoking or replacing an exposed SDK
client. Authorization started before or after invalidation can repopulate that
client's account cache; the manager must sync it without a third authorization
request. Two tests pass unchanged production source and distinguish the prior
optional-cache-access survivor. A same-source three-mutant measurement changes
from two killed / one survived to three killed / zero survived. No artificial
behavioral failure was introduced for this already-correct behavior.

## Combined verification

The frozen production/test integration passes `pnpm run verify`: **2,907 unit
cases**, 20 existing skips, 58 runtime-security cases, 48 modern protocol cases,
and 12 legacy protocol cases, together with its static and listener checks.
Final observability/logging checks pass 23 cases. This round adds 19 cases:
two auth, ten sanitizer, and seven destructive registry cases.

The package check initially found the final unpacked package 116 bytes over its
existing limit. Exact before/after measurements are:

| Package metric | Cumulative seed | Final source | Change |
| --- | ---: | ---: | ---: |
| Packed bytes | 665,184 | 665,249 | +65 |
| Unpacked bytes | 2,986,590 | 2,987,182 | +592 |
| Packed entries | 281 | 281 | 0 |

All growth is confined to five sanitizer/destructive-gate JavaScript and
source-map artifacts. Dependencies and entry count are unchanged. The measured
baselines were refreshed; only the unpacked limit increased, by exactly 592
bytes to 2,987,658, preserving the seed's 476-byte unpacked headroom. The packed
limit stays 665,350. The original failed report is retained and the updated
package gate passes. This size-baseline update is separate from mutation or
performance thresholds, which were unchanged.

## Audit links and evidence

- [Auth](https://github.com/backblaze-labs/b2-mcp/blob/b51c6d58b0a961105ccde45588588ad4eb4e69df/docs/design-docs/mutation-auth-module-sweep.md)
- [Secret sanitizer](https://github.com/backblaze-labs/b2-mcp/blob/84a21ab46009d441d4fa0d110f3dedfa92e564aa/docs/design-docs/mutation-sanitizer-module-sweep.md)
- [Destructive elicitation](https://github.com/backblaze-labs/b2-mcp/blob/14fc485b09f9df55e08edb12ed1b0fc85e8d6b4c/docs/design-docs/mutation-module-elicitation-audit.md)
- [Credentials](https://github.com/backblaze-labs/b2-mcp/blob/ed62d3354718d4bee9b5f600794fce3efefe63cc/docs/design-docs/mutation-module-credentials-audit.md)
- [Tool capabilities](https://github.com/backblaze-labs/b2-mcp/blob/eddfbb73398c393badb9cba7f790587f8895534d/docs/design-docs/mutation-module-capabilities-audit.md)
- [Destructive gate](https://github.com/backblaze-labs/b2-mcp/blob/5303a16a2fb5cd1e421c3facf50d2aab885ad5aa/docs/design-docs/mutation-module-destructive-gate-audit.md)

Ignored `reports/mutation/` retains six handoffs, exact source hashes, native
reports, matched/changed mutation identities, red/green logs, source/build size
comparisons, and the complete cumulative review patch. All three fresh native runs completed successfully. Unchanged modules
reuse their source-matched full reports; no fresh six-module aggregate score,
live B2 operation or hosted mutation run is claimed. Required PR CI and
independent approval are tracked separately in #2006.

## Final recorded survivor inventory

The six source-matched snapshots contain **119 survivors and one uncovered
mutant**. The starting inventory had 118 survivors: auth kills one existing
survivor, while the sanitizer helper adds two descriptor variants that remain
bounded equivalents under reviewed read/serialization consumers. All 46 old
sanitizer survivors remain. Final per-module survivors are auth 41, sanitizer
48, elicitation 21, credentials eight, capabilities one, and destructive gate
zero. Counts combine separate module snapshots; no fresh six-module score is
inferred. Every retained mutant stays in the raw score.

The final ledger contains 113 bounded-equivalence judgments, two performance-only
mutants, three non-equivalent synthetic sanitizer differences, and one
unsupported cause-descriptor contract mutation. These are audit dispositions,
not universal proofs. The SDK-normalized capability fallback remains uncovered.

Auth completed in 27 minutes 30 seconds: the only change among all 489 identical
mutant signatures is optional cache access 473 from survivor to assertion kill;
all prior assertion kills and 13 watchdog detections are retained. Sanitizer's
fresh unchanged-source run retained all 46 survivors and measured one existing
nontermination mutant as timeout rather than assertion kill; the final changed
source retains those seven timeout detections and adds three assertion kills
plus two descriptor survivors. Sanitizer's 91.71% to 91.43% score change compares
different generated corpora (555 to 560), alongside the demonstrated own-key
preservation fix. The gate's changed corpus contains 238 assertion kills, with
236 exact old/new matches still killed and changed nodes recorded separately.

Package-policy regression checks pass 22 cases after the measured metadata
update. Final configured spelling/local links and changed-file formatting checks
cover the collected reports. An extra explicit spelling scan of package-budget
JSON (outside the configured spelling file set) flagged two pre-existing
advisory-ID fragments; no new dictionary exceptions were added.

## Publication and merge order

The six linked immutable module audits carry independent scoped commits.
This report and package-baseline update depend on sanitizer PR #595 and are
intended to land after the related source fixes. The published branch targets
main so the normal CI workflows run; its temporary inherited parent diff must
be removed after that parent lands, with CI and required review checked again.
The package measurements above describe the validated cumulative source tree,
not this report-only branch in isolation. Runtime source changes remain in the
module-specific PRs. Required independent approval remains a merge prerequisite.
