# Decision Record — B2 MCP tool-surface trim (v2.0.0)

*Date: 2026-06-24. Status: implemented, verified, pre-release.*

> **UPDATE (2026-06-24, same day): superseded in part by an S3-first pivot.** This
> record describes the first trim (85 → 42, *keeping native* and dropping S3
> duplicates). Management then directed the MCP toward an **S3-first** surface, so
> the data plane was re-pointed to S3: the final shipping surface is **36 tools —
> 17 native (control plane: buckets, keys, Partner/Groups provisioning, Object
> Lock, notifications) + 19 S3 (object data plane)**. The *reasoning* below still
> holds and is why the split landed where it did — S3 has no equivalent for key
> creation, provisioning, notifications, or Object-Lock retrofit, so those stayed
> native; object byte operations moved to S3 as the forward-compatible surface.
> See CHANGELOG `[2.0.0]` for the final surface.

## Context

Review feedback: the MCP exposed ~78 tools (actually **85** in shipped code), and
because an MCP client loads every tool's name + schema into context at session
start, the catalog consumed **~15–25k tokens of standing context before any work
began**. The suggestion was to "make it a skill so it only loads when called."

That diagnosis is correct about the cost; the proposed cure is incomplete. A
**skill is procedural knowledge that loads on demand; it cannot call the B2 API**
on its own — it needs either MCP tools or a credentialed shell. Putting the B2
key in a shell the model drives collapses the trust boundary (a prompt-injected
agent then has the credential). So the fix is **trim the MCP, not delete it**, and
keep the existing skills pack as the on-demand procedural layer on top.

## Decision

Reduce the tool surface **85 → 42 (−51%, ~−40% startup context)**:

| Family | Before | After | Why |
|---|---|---|---|
| `b2_*` native | 38 | **38 kept** | The core value; includes Partner/Groups provisioning needed for **white-label** sub-account creation |
| `s3_*` | 45 | **4 kept** | 41 duplicated native `b2_*`; the 4 kept have no native equivalent |
| `bz_*` Computer Backup | 2 | **0** | Different product (endpoint backup), not B2 storage; no skill used them |

**The 4 S3 tools kept**, each justified by a capability gap an adversarial review
confirmed has no native equivalent:
- `s3_get_presigned_url` — S3 presigned PUT/GET (browser/CORS direct upload).
- `s3_head_bucket` — S3-endpoint reachability probe (S3-compatibility validator).
- `s3_get_bucket_location` — region/location-constraint probe.
- `s3_put_bucket_lifecycle` — S3 `AbortIncompleteMultipartUpload` (the native
  lifecycle API cannot express aborting incomplete *S3-multipart* uploads).

## How we decided — adversarial review

Before any deletion, three independent adversarial reviewers attacked the plan:
1. **Skills-breakage realist** — proved "drop all 45 S3 tools cleanly" was false:
   4 S3 tools fill real gaps (above), and skills 09/29 lose capability/assurance,
   not just duplicate text. → drove the keep-4 decision.
2. **Radical minimalist** — showed the true credential-broker core is ~6 tools
   (+5 provisioning), but reaching it needs scoped-credential plumbing + rewriting
   many skills; rushing it would re-weaken the boundary via over-scoped creds. →
   deferred as future direction (Tier-3), not done now.
3. **Trust-boundary security** — found the **biggest issue wasn't bloat**:
   `b2_create_key` let a hijacked agent mint an all-powerful, non-expiring key and
   exfiltrate it, with zero server-side gating. → became the security work below.

## Security: `b2_create_key` lockdown

Implemented in `src/b2/keys.ts`, both transports, **safe by default, env opt-out**:
- Rejects key-management capability grants (`listKeys`/`writeKeys`/`deleteKeys`) —
  the self-perpetuating backdoor. Override: `B2_ALLOW_KEY_MGMT_GRANTS=true`.
- Rejects unscoped keys with write/delete caps (forces a bucket scope). Override:
  `B2_ALLOW_UNSCOPED_KEYS=true`.
- Optional `B2_MAX_KEY_DURATION_SECONDS` caps validity and forbids non-expiring
  keys.

B2 independently enforces that a key cannot exceed the creating key's own
capabilities; these controls stack on top of that.

## Verification gate (re-run after any tool change)

- `cd b2-mcp-server && npm run build && npm test` → expect **335 pass / 25 suites**
  (`tests/unit/tools-schema.test.ts` asserts exact counts: 42 / 38 `b2_` / 4 `s3_`
  / 0 `bz_`). `npm test` now runs `npm run typecheck` first (a `pretest` hook) which
  compiles `src` **and** `tests` (incl. integration) via `tsconfig.typecheck.json`,
  so test-file compile errors are caught without credentials.
- `cd mcp_skills_pack && python3 scripts/validate_pack.py` → expect **PASS, 29
  skills** (every tool a skill cites must exist in `scripts/known_tools.txt`).

## Honest notes for inspectors

- **The gate caught an under-scoping mistake, not initial analysis.** The first
  scan of affected skills was truncated by a `head` and reported 7 skills; the
  validator revealed the real blast radius was **14**. All 14 were fixed and
  re-validated. Treat `validate_pack.py` + the unit count assertions as the
  source of truth, not prose.
- **Disclosed behavior changes:** removed S3 tools return "tool not found" if
  called; `b2_create_key` now rejects broad/unscoped/non-expiring keys by default
  (env overrides exist); skill 29 no longer does native-vs-S3 reconciliation.

## Open follow-ups

1. **Server-side confirmation gate for destructive tools** — ✅ **DONE.** Added
   `src/utils/destructive-gate.ts` (policy `B2_DESTRUCTIVE_POLICY`: `confirm`
   default / `block` / `allow`), enforced inside the handlers of `b2_delete_bucket`,
   `b2_delete_file_version`, `b2_delete_key`, `b2_cancel_large_file`,
   `b2_eject_group_member`, and `b2_update_bucket` (conditional on public-flip /
   lock-weakening). Server-side, so it holds for clients without the skills layer.
   14 unit tests (`tests/unit/destructive-gate.test.ts` + a handler-wiring test).
   `confirm` is defense-in-depth — `block` is the hard control for untrusted/
   unattended deployments.
2. **Live integration validation** — *partially done.* A live run against real B2
   passed **31 integration tests** (native `b2_*` surface confirmed). It also
   caught a regression — `tests/integration/live.test.ts` failed to compile
   because the test cleanup removed `partnerIt`/`HAS_PARTNER` but left their
   usages (now fixed). The unit gate compiled only `src`, so it missed this —
   **addressed:** added `npm run typecheck` (`tsconfig.typecheck.json`, src + all
   tests) wired as a `pretest` hook, so this regression class is now caught with no
   credentials. **S3 now validated:** with a valid non-master application key,
   `live.test.ts` passes 28/2-skipped and **3 of the 4 kept `s3_*` tools are
   confirmed live** (`s3_head_bucket`, `s3_get_bucket_location`,
   `s3_get_presigned_url`). `s3_put_bucket_lifecycle` (mutating write) has no
   integration test — build/schema only. (B2's S3 endpoint rejects **master**
   keys, which was the earlier `Malformed Access Key Id`.) Still environmental, not
   the trim: `contract.test.ts` Object-Lock test needs a lock-enabled bucket; some
   native tests exceed the 60s timeout under slow network.
3. **Reconcile canonical spec docs** — the `.docx` Technical Specification /
   Internal Testing Guide still describe the 78/85-tool surface; regenerate them
   or declare the README/CHANGELOG the source of truth.
4. **Credential-broker core (Tier-3)** — optional future move to ~6 broker tools +
   skills-with-scoped-creds for bulk data ops.
