# Documentation Map

This directory is the repository system of record. Start with this map, then
open the smallest document that covers the task at hand.

## Stable Entrypoints

- [`../README.md`](../README.md) - product overview, quick start, and user-facing reference.
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) - top-level runtime architecture.
- [`AUTHENTICATION.md`](AUTHENTICATION.md) - authentication, OAuth, and credential custody.
- [`DEPLOY.md`](DEPLOY.md) - hosted deployment matrix and provider guide index.
- [`SECURITY.md`](SECURITY.md) - engineering security map.
- [`TESTING.md`](TESTING.md) - deterministic, live, package, and eval test policy.
- [`EVALS.md`](EVALS.md) - LLM eval harness runbook.

## Filename Convention

New documents inside taxonomy subdirectories use lowercase kebab-case. Existing
root-level and top-level `docs/` entrypoints keep their uppercase names because
they are stable public paths; the Phase 1 compatibility aliases under
[`CLIENTS.md`](CLIENTS.md) and [`deployment/`](deployment/) are intentionally
temporary. Generated tool-profile artifacts keep their current names until the
Phase 2 generated-docs move.

## System Of Record

- [`design-docs/index.md`](design-docs/index.md) - design document catalog with owners and status.
- [`design-docs/tool-contract.md`](design-docs/tool-contract.md) - tool and prompt contract policy.
- [`design-docs/sdk-adoption-contract.md`](design-docs/sdk-adoption-contract.md) - SDK adoption and backing taxonomy.
- [`design-docs/security-review.md`](design-docs/security-review.md) - pre-public security and provenance review.
- [`design-docs/supply-chain-security.md`](design-docs/supply-chain-security.md) - supply-chain denylist and incident response.
- [`product-specs/index.md`](product-specs/index.md) - product specification index.
- [`exec-plans/active/typescript-7-migration.md`](exec-plans/active/typescript-7-migration.md) - active TypeScript migration plan.
- [`exec-plans/tech-debt-tracker.md`](exec-plans/tech-debt-tracker.md) - known technical debt tracker.
- [`references/discoverability.md`](references/discoverability.md) - registry and directory listing runbook.
- [`references/deployment/security-and-credentials.md`](references/deployment/security-and-credentials.md) - shared hosted security contract.
- [`references/harness-engineering.md`](references/harness-engineering.md) - taxonomy reference note.

## Phase 2 Holdovers

Generated tool-profile artifacts stay at [`TOOL_PROFILES.md`](TOOL_PROFILES.md)
and [`tool-profile-contract.json`](tool-profile-contract.json) until the Phase
2 generated-docs move.
