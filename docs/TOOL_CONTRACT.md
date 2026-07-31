# Tool Contract

Owner: Gonza (`@goanpeca`). Quality reviewer: Sophie / Quality Keeper (QK)
(`@sophiecarreras`).

Status: skeleton. Issue #49 owns the deterministic fixture and drift-test
implementation, but it is gated on the official SDK parity matrix from #71.
Issue #59 owns the MCP SDK v2 and protocol-era migration.

## Phase 1 Source Of Truth

The normative Phase 1 tool-profile decisions live in [`V1_SCOPE.md`](V1_SCOPE.md).
The normative SDK adoption and tool-parity matrix lives in
[`SDK_ADOPTION_CONTRACT.md`](SDK_ADOPTION_CONTRACT.md). This document will
become the stable public contract once the fixture work lands.

The public contract must define:

- supported MCP protocol era and fallback behavior;
- full, default, and read-only tool profiles;
- exact tool names, counts, and profile hashes;
- input-schema requirements and prohibited credential fields;
- destructive and protection-weakening confirmation rules;
- secret-producing tool policy;
- compatibility rules for stale cached `tools/list` profiles.

## Required Evidence

- Deterministic `tools/list` fixtures for every named profile.
- CI checks that compare fixtures, README counts, and actual registration.
- Tests for credential redaction, durable-secret output sanitization,
  destructive-operation gating, and unsupported
  capability behavior.

Blocking follow-up coverage is tracked in #49 and #61. Until those land, the
remaining fixture and authorization guarantees above are contract requirements
rather than complete CI evidence.

Issue #49 must not freeze tool names, schemas, capability maps, response
fixtures, or profile hashes until #71 and its SDK implementation follow-ups are
complete. The frozen fixture must identify the resolved
`@backblaze-labs/b2-sdk` version and fail if inherited Axios/AWS behavior
silently reappears outside the reviewed SDK boundary.

Until this document is filled out, [`V1_SCOPE.md`](V1_SCOPE.md) remains the
normative contract source.
