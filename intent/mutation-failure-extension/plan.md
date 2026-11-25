# Mutation failure profiles: publication plan

Status: Implemented; pending human review. No approval is recorded by this plan.
Owner: Sophie / Quality Keeper. Tracking: private task linked in the PRs.

This records the publication plan for work implemented before the repository
adopted its current SDLC guidance in main `51abefd`. Bug fixes follow observed
failing tests; the human-directed task remains the tracking record.

1. Publish JWKS/cache contracts and the minimal authorization-metadata copy
   repair, committing failing tests before runtime changes. Proof:
   `tests/unit/jwks-cache-failure-policy.unit.test.ts`, including real RSA
   verification and introspection controls; `tests/unit/mutation-profiles.unit.test.ts`.
2. Publish durable ledger contracts and repairs for owned-lock sync failure,
   replay boundaries and undefined-value serialization failures, again committing
   observed failing tests first. Preserve existing owners, durable claims,
   compensation and raw failure identity. Proof: `tests/unit/ledger-lock-*.unit.test.ts`
   and the neighboring `tests/unit/secret-sink.unit.test.ts` suite.
3. Publish isolated scheduled/manual advisory rows and combined documentation.
   Preserve core artifacts, operators, timeouts and non-blocking status. Proof:
   `tests/unit/mutation-workflow-profiles.unit.test.ts`, which parses the actual
   workflow and loads all five configs.
4. Verify the publication stack on current main using `pnpm run ci`, obtain a
   fresh-context Deep review with a separate security pass, and request the
   designated human code-owner reviews. Each PR targets main for main-filtered
   CI, with explicit parent dependencies. Parent #613 requested changes remain
   a merge blocker. No agent approval or merge substitutes for human review.

Risk: OAuth cache integrity, file durability/ownership and CI configuration need
Deep review under REVIEW.md. No tool schema, dependency or credential selection
contract changes. Source repairs alter mutation fault sets; changed structural
sites and watchdog detections stay separate from assertion kills. Recorded
scores describe the original isolated snapshots, not the whole repository.
Physical crash guarantees, complete oversized legacy records, short reads and
retained assertion gaps remain outside the demonstrated guarantees.

Rollback: revert each final fix/integration commit or the owning PR merge;
there is no data migration. Reverting restored bugs requires the matching
regression tests to remain visible in the revert review.
