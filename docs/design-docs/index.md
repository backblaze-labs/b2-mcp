# Public Contract Documents

Owner: Gonza (`@goanpeca`). Quality owner: Sophie / Quality Keeper (QK) (`@sophiecarreras`).

This register is the public-document skeleton for Phase 1. A document listed
here is part of the customer-facing or release-facing contract and must be kept
current with code, CI, and GitHub release metadata. For a navigable docs tree,
start with [`../README.md`](../README.md).

| Document | Owner | Purpose | Status | Issues |
| --- | --- | --- | --- | --- |
| [`../../README.md`](../../README.md) | Gonza | Product overview, quick start, tool taxonomy, and local development commands | active | Ongoing |
| [`../product-specs/clients.md`](../product-specs/clients.md) | Gonza | MCP client configuration contract for stdio and Streamable HTTP | active | #66 |
| [`../AUTHENTICATION.md`](../AUTHENTICATION.md) | Gonza | Caller authentication, OAuth resource-server behavior, and B2 credential custody | active | #66 |
| [`../DEPLOY.md`](../DEPLOY.md) | Gonza | Hosted deployment matrix and provider guide index | active | #65, #66, #106, #121 |
| [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) | Gonza | Runtime architecture and integration-boundary decisions | active | #71 |
| [`sdk-adoption-contract.md`](sdk-adoption-contract.md) | Gonza | Official B2 SDK adoption and Native B2 SDK/AWS S3 SDK/custom tool parity matrix | active | #71, #132 |
| [`../exec-plans/active/typescript-7-migration.md`](../exec-plans/active/typescript-7-migration.md) | Gonza | TypeScript 7 native compiler migration decision and trigger | active | #114 |
| [`../product-specs/v1-scope.md`](../product-specs/v1-scope.md) | Gonza | Phase 1 product, runtime, release, SDK, and protocol decision record | active | #55, #71, #106 |
| [`tool-contract.md`](tool-contract.md) | Gonza | Tool/prompt profile contract policy, backing taxonomy, and fixture requirements | frozen for Phase 1 | #49, #59, #166 |
| [`../TOOL_PROFILES.md`](../TOOL_PROFILES.md) | Gonza | Generated Phase 1 tool and opt-in prompt profile reference | Phase 2 holdover | #49, #166 |
| [`../tool-profile-contract.json`](../tool-profile-contract.json) | Gonza | Generated tool-profile contract artifact consumed by tests and packaging | Phase 2 holdover | #49, #166 |
| [`../TESTING.md`](../TESTING.md) | Sophie / QK | Deterministic PR gates, contract evidence, and live B2 smoke policy | active | #50, #51, #52, #60, #61, #63 |
| [`../EVALS.md`](../EVALS.md) | Sophie / QK | LLM eval local and CI runbook | active | #251 |
| [`security-review.md`](security-review.md) | Sophie / QK | Pre-public secret scanning, provenance, and legal review checklist | skeleton | #62, #66, #67 |
| [`supply-chain-security.md`](supply-chain-security.md) | Sophie / QK | npm/GHCR compromise denylist, branch/artifact scan, and incident runbook | active | #89, #106 |
| [`../SECURITY.md`](../SECURITY.md) | Sophie / QK | Engineering security map for security and supply-chain docs | active | #62, #66, #67, #89, #106 |
| [`../../SECURITY.md`](../../SECURITY.md) | Backblaze Security | Vulnerability reporting and support scope | active | #66 |
| [`../../RELEASE.md`](../../RELEASE.md) | Gonza | Release process and changelog discipline | active | #64, #67, #106 |
| [`../../CHANGELOG.md`](../../CHANGELOG.md) | Gonza | Keep a Changelog release notes | active | Ongoing |
| [`../product-specs/index.md`](../product-specs/index.md) | Gonza | Product specification index | active | #372 |
| [`../exec-plans/tech-debt-tracker.md`](../exec-plans/tech-debt-tracker.md) | Gonza | Known technical debt tracker | active | #372 |
| [`../references/discoverability.md`](../references/discoverability.md) | Gonza | Registry and directory listing runbook | active | #372 |
| [`../references/harness-engineering.md`](../references/harness-engineering.md) | Gonza | Harness-engineering taxonomy reference note | active | #372 |
| [`../references/deployment/security-and-credentials.md`](../references/deployment/security-and-credentials.md) | Gonza | Shared hosted security contract for deployment guides | active | #65, #66, #106, #121 |

## Maintenance Rule

When a PR changes runtime support, tool names, tool counts, transport behavior,
credential handling, release metadata, or security posture, update the affected
contract document in the same PR or link a blocking follow-up issue.
