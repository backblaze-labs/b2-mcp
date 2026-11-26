# Credentials module survivor audit

Date: 2026-11-23. Related tracking:
[demand-side-ai #2006](https://github.com/backblaze-labs/demand-side-ai/issues/2006).

## Decision and scope

Retain all eight recorded `src/credentials.ts` survivors. This pass challenged
the earlier equivalence rationales against actual public provider calls,
canonical header forms, optional credential pairs, principal-map state changes,
and the built-in startup validator. It found no supported counterexample that
justified an additional test or production change. Retention is bounded to
these current contracts, not a claim about arbitrary private helper inputs or
future provider policies.

The source in cumulative validation seed
`69c8f35fcd3ce02c2bab40156dab456ecbc8173e` exactly matches the saved full native
report: SHA-256
`13525d806116ff719aa2010a96c1d2ec363a12f9f819a54775f4b1f7aae6920b`.
That report contains 430 mutants: 422 assertion kills, eight survivors, zero
uncovered, timeout, or error mutants, and a 98.14% mutation score. This pass
reuses that same-source measurement; it does not claim a fresh native run or a
higher score.

## Exact survivors and contract challenges

IDs refer to the saved credentials report, not other modules or later source.

| ID | Exact mutation | Contract review and disposition |
| --- | --- | --- |
| 31 | `config.credentialFingerprint ?? fingerprintConfig(config)` becomes `config.credentialFingerprint && fingerprintConfig(config)` | Each call comes immediately after the private material-to-config builder assigns a fresh, nonempty fingerprint from that same config. Public providers accept material or requests, not an externally mutated intermediate config. The recomputed fingerprint is therefore identical. Retain; reconsider if an external config path or mutation hook is introduced. |
| 81 | `id && key` becomes `id || key` | The earlier truthiness comparison has already rejected a partial strict pair or returned the fallback for a partial permissive pair. Both remaining string values have matching truthiness, including empty values. Existing tests cover strict refusal and permissive fallback. Retain. |
| 157 | Remove the `value !== undefined` filter from the header map chain | Each canonical field has one accepted header name. Keeping its one absent value yields a final undefined result, just as removing it does. The following flatMap is retained, so duplicate string arrays still flatten and conflicting values still refuse. Existing duplicate-header tests cover those supported forms. Retain; reconsider if multiple aliases enter a field's name list. |
| 160 | Replace the filter predicate `value !== undefined` with true | This is the same current single-name absent-value convergence as 157. It does not mutate Array.isArray or remove the following flatMap. Retain. |
| 251 | Replace the startup context containing an empty-header request with an empty context | The built-in server provider rejects credential headers only when supplied and derives principal scope only from supplied auth info. Both contexts have neither. Credential loading and validation are identical. No production subclass consumer relying on the incidental context shape was found; an invented override would not establish a supported hook contract. Retain with that limitation. |
| 314 | Replace the principal-map cache-hit guard with false | Repeated calls parse and normalize the same environment JSON instead of returning the cached internal map. The map itself is not exposed to brokers or callers. Changed environment strings already trigger parsing in the original implementation; invalid maps are not installed. Functional routing stays the same. Retain as performance-only. |
| 330 | Replace the internal not-an-object message with an empty string | The enclosing catch discards this Error and throws the fixed public CredentialResolutionError. Shape refusal, public code/status/message, and absence of broker lookup stay the same. Retain. |
| 343 | Replace the internal normalized-reference-collision message with an empty string | The same enclosing catch replaces this Error; the conflicting map is rejected before resolution. The internal text has no logging or cause consumer. Retain. |

The header explanations deliberately use exact source fragments: 160 concerns
the undefined filter predicate, not array flattening. No support is inferred for
non-Node header values, fabricated private name lists, monkey-patched built-ins,
or externally changed private caches.

## Performance and verification limits

The [prior performance audit](https://github.com/backblaze-labs/b2-mcp/blob/7b037410dc8ec0e478f422faedafa2af465e3102/docs/design-docs/mutation-performance-contract-followup.md)
measured principal-map recomputation through public resolution. It established
extra work but no accepted map-size workload or latency objective from which to
derive a reliable gate. This pass preserves the existing optimization and adds
no private parse-count assertion, timing threshold, or budget change.

The existing credentials and credentials-policy unit suites passed **146
cases across two files, zero skips**, for this documentation-only audit. They already exercise all provider modes,
independent fingerprints, secret rotation, partial credential pairs, duplicate
headers, missing auth, malformed maps, normalization collisions, map refresh,
and startup refusal. Commands use Node.js 22.23.1 and an isolated frozen
pnpm 11.20.0 install in a checkout without spaces. Exact observed results and
commands are retained in ignored `reports/mutation/module-sweep-credentials/`.

No tests or production files changed. This uses the shared TDD policy's
documentation exception rather than manufacturing a red test. No fresh full
mutation, required combined gate, deployed runtime, or live B2 operation is
claimed by this module pass. No commits, remote writes, thresholds, exclusions,
existing skips, dependencies, or performance budgets changed.
