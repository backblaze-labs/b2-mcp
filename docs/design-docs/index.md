# Design Docs

Owner: Gonza (`@goanpeca`). Quality owner: Sophie / Quality Keeper (QK) (`@sophiecarreras`).

This index covers design documents in this subtree. The full documentation map
lives in [`../README.md`](../README.md).

| Document | Owner | Purpose | Status | Issues |
| --- | --- | --- | --- | --- |
| [`sdk-adoption-contract.md`](sdk-adoption-contract.md) | Gonza | Official B2 SDK adoption and Native B2 SDK/AWS S3 SDK/custom tool parity matrix | active | #71, #132 |
| [`tool-contract.md`](tool-contract.md) | Gonza | Tool/prompt profile contract policy, backing taxonomy, and fixture requirements | frozen for Phase 1 | #49, #59, #166 |
| [`security-review.md`](security-review.md) | Sophie / QK | Pre-public secret scanning, provenance, and legal review checklist | skeleton | #62, #66, #67 |
| [`supply-chain-security.md`](supply-chain-security.md) | Sophie / QK | npm/GHCR compromise denylist, branch/artifact scan, and incident runbook | active | #89, #106 |

## Maintenance Rule

When a PR changes runtime support, tool names, tool counts, transport behavior,
credential handling, release metadata, or security posture, update the affected
contract document in the same PR or link a blocking follow-up issue.
