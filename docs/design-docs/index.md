# Public Contract Documents

Owner: Gonza (`@goanpeca`). Quality owner: Sophie / Quality Keeper (QK) (`@sophiecarreras`).

This register is the public-document skeleton for Phase 1. A document listed
here is part of the customer-facing or release-facing contract and must be kept
current with code, CI, and GitHub release metadata.

| Document                                               | Owner              | Purpose                                                                 | Fill-out issue               |
| ------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------- | ---------------------------- |
| [`../../README.md`](../../README.md)                   | Gonza              | Product overview, quick start, tool taxonomy, local development commands | Ongoing                      |
| [`../product-specs/clients.md`](../product-specs/clients.md) | Gonza              | MCP client configuration contract for stdio and Streamable HTTP         | #66                          |
| [`../AUTHENTICATION.md`](../AUTHENTICATION.md)         | Gonza              | Caller authentication, OAuth resource-server behavior, and B2 credential custody | #66                          |
| [`../DEPLOY.md`](../DEPLOY.md)                         | Gonza              | Hosted deployment matrix and provider guide index                       | #65, #66, #106, #121         |
| [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)       | Gonza              | Runtime architecture and integration-boundary decisions                 | #71                          |
| [`sdk-adoption-contract.md`](sdk-adoption-contract.md) | Gonza              | Official B2 SDK adoption and Native B2 SDK/AWS S3 SDK/custom tool parity matrix | #71, #132                    |
| [`../exec-plans/active/typescript-7-migration.md`](../exec-plans/active/typescript-7-migration.md) | Gonza              | TypeScript 7 native compiler migration decision and trigger              | #114                         |
| [`../product-specs/v1-scope.md`](../product-specs/v1-scope.md) | Gonza              | Phase 1 product, runtime, release, SDK, and protocol decision record    | #55, #71, #106               |
| [`tool-contract.md`](tool-contract.md)                 | Gonza              | Tool/prompt profile contract policy, backing taxonomy, and fixture requirements | #49, #59, #166               |
| [`../TOOL_PROFILES.md`](../TOOL_PROFILES.md)           | Gonza              | Generated Phase 1 tool and opt-in prompt profile reference              | #49, #166                    |
| [`../TESTING.md`](../TESTING.md)                       | Sophie / QK        | Deterministic PR gates, contract evidence, and live B2 smoke policy     | #50, #51, #52, #60, #61, #63 |
| [`../EVALS.md`](../EVALS.md)                           | Sophie / QK        | LLM eval local and CI runbook                                           | #251                         |
| [`security-review.md`](security-review.md)             | Sophie / QK        | Pre-public secret scanning, provenance, and legal review checklist      | #62, #66, #67                |
| [`supply-chain-security.md`](supply-chain-security.md) | Sophie / QK        | npm/GHCR compromise denylist, branch/artifact scan, and incident runbook | #89, #106                    |
| [`../../SECURITY.md`](../../SECURITY.md)               | Backblaze Security | Vulnerability reporting and support scope                               | #66                          |
| [`../../RELEASE.md`](../../RELEASE.md)                 | Gonza              | Release process and changelog discipline                                | #64, #67, #106               |
| [`../../CHANGELOG.md`](../../CHANGELOG.md)             | Gonza              | Keep a Changelog release notes                                          | Ongoing                      |

## Maintenance Rule

When a PR changes runtime support, tool names, tool counts, transport behavior,
credential handling, release metadata, or security posture, update the affected
contract document in the same PR or link a blocking follow-up issue.
