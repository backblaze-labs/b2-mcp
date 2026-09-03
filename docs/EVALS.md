# LLM Eval Suite

Owner: Sophie / Quality Keeper (QK) (`@sophiecarreras`). Implementation owner: Gonza
(`@goanpeca`).

Status: active. This runbook covers the deterministic eval harness, the opt-in
LLM-backed provider evals, and the provider pass-rate plus transport-parity
coverage added for issues [#251](https://github.com/backblaze-labs/b2-mcp/issues/251)
and [#270](https://github.com/backblaze-labs/b2-mcp/issues/270).

## What The Suite Covers

The eval suite lives under [`../evals/`](../evals/) and uses the built stdio
server from `dist/index.js` plus the built Streamable HTTP server from
`dist/http-server.js`. The deterministic tests
exercise the harness, provider adapters, prompt-to-tool assertions, provider
comparison logic, report validation, and full-profile case definitions. They do
not call Anthropic, OpenAI, or live Backblaze B2.

The live provider tests are opt-in and run the same MCP eval case definitions
through real LLM APIs. The harness starts b2-mcp with marker B2 credentials,
`B2_ALLOW_LOCAL_FILES=false`, `B2_SECRET_SINK=off`, and a default
`B2_DESTRUCTIVE_POLICY=block`. Tool-shape cases that must pass through a
destructive handler can only opt into `destructivePolicy: "allow"` through typed
eval case options. The child-process environment is validated before spawn, so
live provider evidence still avoids real B2 credentials. HTTP eval runs bind the
spawned server to `127.0.0.1`, set matching Host/Origin allowlists, and connect
through Streamable HTTP on localhost.

## Local Deterministic Run

Use this for normal PR work and before changing eval code:

```bash
pnpm install --frozen-lockfile
pnpm run evals
```

`pnpm run evals` builds the package and runs `vitest` with
[`../evals/vitest.config.mts`](../evals/vitest.config.mts). Leave
`RUN_LLM_EVALS` unset for this mode. Provider-backed cases skip, while the
deterministic harness and adapter tests still run.

## Local LLM Runs

Set `RUN_LLM_EVALS=1` plus the provider key for the live provider you want to
exercise:

```bash
RUN_LLM_EVALS=1 \
ANTHROPIC_API_KEY=your-anthropic-api-key \
pnpm run evals
```

```bash
RUN_LLM_EVALS=1 \
OPENAI_API_KEY=your-openai-api-key \
pnpm run evals
```

Setting both provider keys runs both single-provider live suites:

```bash
RUN_LLM_EVALS=1 \
ANTHROPIC_API_KEY=your-anthropic-api-key \
OPENAI_API_KEY=your-openai-api-key \
pnpm run evals
```

Single-provider live suites iterate over `FULL_PROFILE_EVAL_CASES`, so expect
them to take longer and consume more provider quota than the deterministic run.
Provider failures, rate limits, model behavior drift, and timeouts are real
failures in this mode.

## Provider Comparison

The provider comparison has a separate gate so ordinary live provider runs do
not automatically re-run the comparison matrix. The pass-rate runner covers
whichever providers have keys configured, and runs each one over both stdio and
Streamable HTTP. CI is Anthropic-only while OpenAI billing is unavailable, so it
asserts Claude stdio/HTTP transport parity. To run the CI-shaped bounded
comparison locally, build first so the harness evaluates the current `dist/`
output:

```bash
pnpm run build
RUN_LLM_EVALS=1 \
RUN_LLM_PROVIDER_COMPARISON=1 \
ANTHROPIC_API_KEY=your-anthropic-api-key \
ANTHROPIC_EVAL_MODEL=claude-haiku-4-5-20251001 \
LLM_EVAL_CASE_SET=ci-no-b2 \
LLM_EVAL_CASE_LIMIT=5 \
LLM_EVAL_BLOCK_SERVER_NETWORK=1 \
LLM_EVAL_PASS_RATE_REPORT=reports/evals/provider-pass-rates.json \
pnpm run evals:provider-comparison
```

For a full local comparison, omit `LLM_EVAL_CASE_SET` and
`LLM_EVAL_CASE_LIMIT`, or set `LLM_EVAL_CASE_SET=full` explicitly. Keep
`LLM_EVAL_BLOCK_SERVER_NETWORK=1` for the `ci-no-b2` case set; it imports
[`../scripts/no-network-guard.mjs`](../scripts/no-network-guard.mjs) inside the
server child process while still allowing provider API calls from the test
runner. Omit it for full-profile runs that intentionally exercise the native B2
and S3 invalid-credential error paths. If `OPENAI_API_KEY` is also configured,
OpenAI runs over both transports without changing the harness. Re-run
`pnpm run build` after source changes before collecting provider comparison
evidence.

## Required Environment

| Variable | Required for | Notes |
| --- | --- | --- |
| `RUN_LLM_EVALS=1` | All live LLM evals | Enables provider-backed cases. Leave unset for deterministic PR work. |
| `ANTHROPIC_API_KEY` | Anthropic live evals and provider comparison | Required by the Anthropic driver. |
| `OPENAI_API_KEY` | OpenAI live evals and provider comparison | Required by the OpenAI driver. |
| `RUN_LLM_PROVIDER_COMPARISON=1` | Provider pass rates and transport parity | Required in addition to `RUN_LLM_EVALS=1`. |
| `ANTHROPIC_EVAL_MODEL` | Anthropic model override | Defaults to `claude-haiku-4-5-20251001`. |
| `OPENAI_EVAL_MODEL` | OpenAI model override | Defaults to `gpt-5-nano`. |
| `LLM_EVAL_CASE_SET` | Provider comparison case selection | Defaults to `full`; CI uses `ci-no-b2`. |
| `LLM_EVAL_CASE_LIMIT` | Provider comparison case cap | Positive integer; applied after case-set selection. |
| `LLM_EVAL_BLOCK_SERVER_NETWORK=1` | Server child-process network guard | Recommended for provider comparison and CI parity. |
| `LLM_EVAL_PASS_RATE_REPORT` | Provider comparison report path | Defaults to `reports/evals/provider-pass-rates.json` in the CLI. |

Do not set real `B2_APPLICATION_KEY_ID`, `B2_APPLICATION_KEY`,
`B2_MASTER_KEY_ID`, or `B2_MASTER_KEY` for eval runs. The harness replaces them
with marker values and refuses non-marker B2 credentials in the server child
process.

## Model Selection

The Anthropic driver defaults to `claude-haiku-4-5-20251001`. Override it with:

```bash
ANTHROPIC_EVAL_MODEL=claude-haiku-4-5-20251001
```

The OpenAI Chat Completions driver defaults to `gpt-5-nano`. Override it with:

```bash
OPENAI_EVAL_MODEL=gpt-5-nano
```

When changing defaults, update the provider driver, the deterministic tests, the
CI workflow environment in [`../.github/workflows/evals.yml`](../.github/workflows/evals.yml),
and this document in the same PR. Record whether pass-rate changes come from
model behavior, eval case changes, or harness changes.

## CI

The LLM eval workflow is [`../.github/workflows/evals.yml`](../.github/workflows/evals.yml).
It is intentionally not a pull-request or push workflow because provider secrets
must not run against unreviewed code. It runs only on:

- Manual `workflow_dispatch` runs on `main`.
- The scheduled weekly run on `main`.

> **OpenAI is temporarily disabled.** The OpenAI account has no API credits, so
> scheduled and manual runs cover Anthropic only. The pass-rate runner degrades
> to whichever provider keys are configured (`evals/run-provider-comparison.ts`
> via `providersWithConfiguredKeys`). Re-enable OpenAI by restoring
> `OPENAI_API_KEY` to the guard's required secrets and to the eval step env in
> [`../.github/workflows/evals.yml`](../.github/workflows/evals.yml); no code
> change is needed.

The guard job checks that the repository is `backblaze-labs/b2-mcp`, the ref is
`refs/heads/main`, and the `ANTHROPIC_API_KEY` repository secret is present.
Because scheduled and manual CI evals are canonical-main only, a missing
`ANTHROPIC_API_KEY` is treated as repository misconfiguration: the guard emits a
GitHub Actions error and fails the workflow. `OPENAI_API_KEY` is not required by
CI while OpenAI evals are disabled.

The eval job installs with the pinned package manager, builds once, then runs:

```bash
RUN_LLM_EVALS=1 \
RUN_LLM_PROVIDER_COMPARISON=1 \
ANTHROPIC_EVAL_MODEL=claude-haiku-4-5-20251001 \
LLM_EVAL_CASE_SET=ci-no-b2 \
LLM_EVAL_CASE_LIMIT=5 \
LLM_EVAL_BLOCK_SERVER_NETWORK=1 \
LLM_EVAL_PASS_RATE_REPORT=reports/evals/provider-pass-rates.json \
pnpm run evals:provider-comparison
```

The workflow validates the JSON report, writes a Markdown summary to the GitHub
step summary, uploads the `claude-pass-rate-report` artifact for 14 days, and
fails the job if the pass-rate command did not succeed.

## Coverage Guard

The full-profile coverage guard is
[`../tests/contract/eval-coverage.contract.test.ts`](../tests/contract/eval-coverage.contract.test.ts).
It runs in `pnpm run test:contract`, which is a distinct deterministic layer and
not part of `pnpm run verify`; run `pnpm run test:contract` explicitly to
exercise the guard.

The guard checks that:

- Every full-profile tool in [`tool-profile-contract.json`](generated/tool-profile-contract.json)
  has at least one eval case.
- Eval cases do not reference tools outside the full profile.
- Each case is bound to exactly one expected tool and all required arguments.
- MCP error expectations include stable, non-empty text snippets.
- Every destructive `confirmTools` entry is covered under the default `block`
  and `confirm` policies, with destructive shape cases opting into `allow`
  only through typed eval server options.

When adding, renaming, or removing a tool, update [`../evals/cases.ts`](../evals/cases.ts)
with the tool's eval case in the same PR. If the CI comparison should exercise
the tool without live B2 access, also update `CI_PROVIDER_COMPARISON_EVAL_CASES`.

## Reading Pass-Rate Comparisons

The comparison summary has this shape:

```text
Pass-rate comparison (Claude vs OpenAI) across 5 shared case(s): Claude: 5/5 (100.0%); OpenAI: 5/5 (100.0%).
```

Read it as a same-case-set comparison, not as independent provider samples. For
Anthropic-only CI runs, the shape is:

```text
Pass-rate comparison (Claude/stdio vs Claude/http) across 5 shared case(s): Claude/stdio: 5/5 (100.0%); Claude/http: 5/5 (100.0%).
```

Read either shape as a same-case-set comparison, not as independent samples. The
denominator is the selected eval case count, after `LLM_EVAL_CASE_SET` and
`LLM_EVAL_CASE_LIMIT` are applied. The pass-rate threshold for the CLI is 100%.
Any provider error also fails the comparison, even if a relaxed pass-rate
threshold would otherwise pass. When multiple transports are present, the CLI
also asserts equivalent normalized tool-selection, argument, and typed-result
outcomes across transports.

The JSON report includes:

- `schemaVersion`: `2` for transport-aware reports. The validator still accepts
  legacy schema version `1` reports that do not contain transport fields.
- `providers[]`: provider name, optional transport, model, passed count, total
  count, and decimal `passRate`. The optional `transport` field is emitted only
  when the run includes more than one transport; explicit `["stdio"]` has the
  same report shape as the default single-stdio run.
- `results[]`: sanitized per-provider, optional-transport, per-case status
  entries with `passed`, `failed`, or `errored`.
- `sensitivity`: the fields intentionally omitted from the artifact.

`failed` means the provider ran the case but the eval assertion did not pass.
`errored` means the provider call, harness, timeout, or setup failed before a
valid case result could be evaluated. Raw model responses, tool result payloads,
B2 marker credentials, and provider API keys are intentionally omitted from the
artifact.

Use the summary for the high-level comparison, then inspect `results[]` to find
the specific provider and case name that failed. A provider that accumulates
three provider errors stops receiving new calls, and remaining cases for that
provider are marked errored so bad credentials, rate limits, or repeated
timeouts fail fast.
