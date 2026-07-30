# Public Contract Documents

Owner: Gonza (`@goanpeca`). Quality owner: Sophie / Quality Keeper (QK) (`@sophiecarreras`).

This register is the public-document skeleton for Phase 1. A document listed
here is part of the customer-facing or release-facing contract and must be kept
current with code, CI, and GitHub release metadata.

| Document                                               | Owner              | Purpose                                                                 | Fill-out issue               |
| ------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------- | ---------------------------- |
| [`../README.md`](../README.md)                         | Gonza              | Product overview, quick start, tool catalog, local development commands | Ongoing                      |
| [`CLIENTS.md`](CLIENTS.md)                             | Gonza              | MCP client configuration contract for stdio and Streamable HTTP         | #66                          |
| [`DEPLOY.md`](DEPLOY.md)                               | Gonza              | Customer-hosted deployment and hardening runbook                        | #65, #66                     |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)                   | Gonza              | Runtime architecture and integration-boundary decisions                 | #71                          |
| [`SDK_ADOPTION_CONTRACT.md`](SDK_ADOPTION_CONTRACT.md) | Gonza              | Official B2 SDK adoption and 40-tool parity matrix                      | #71                          |
| [`V1_SCOPE.md`](V1_SCOPE.md)                           | Gonza              | Phase 1 product, runtime, release, SDK, and protocol decision record    | #55, #71                     |
| [`TOOL_CONTRACT.md`](TOOL_CONTRACT.md)                 | Gonza              | Tool-profile contract skeleton and fixture requirements                 | #49, #59                     |
| [`TESTING.md`](TESTING.md)                             | Sophie / QK        | Deterministic PR gates, contract evidence, and live B2 smoke policy     | #50, #51, #52, #60, #61, #63 |
| [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md)             | Sophie / QK        | Pre-public secret scanning, provenance, and legal review checklist      | #62, #66, #67                |
| [`../SECURITY.md`](../SECURITY.md)                     | Backblaze Security | Vulnerability reporting and support scope                               | #66                          |
| [`../RELEASE.md`](../RELEASE.md)                       | Gonza              | Release process and changelog discipline                                | #64, #67                     |
| [`../CHANGELOG.md`](../CHANGELOG.md)                   | Gonza              | Keep a Changelog release notes                                          | Ongoing                      |

## Maintenance Rule

When a PR changes runtime support, tool names, tool counts, transport behavior,
credential handling, release metadata, or security posture, update the affected
contract document in the same PR or link a blocking follow-up issue.
