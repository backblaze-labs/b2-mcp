# Tool Contract

Owner: Gonza (`@goanpeca`). Quality reviewer: Sophie / QK
(`@sophiecarreras`).

Status: skeleton. Issue #49 owns the deterministic fixture and drift-test
implementation. Issue #59 owns the MCP SDK v2 and protocol-era migration.

## Phase 1 Source Of Truth

The normative Phase 1 tool-profile decisions live in [`V1_SCOPE.md`](V1_SCOPE.md).
This document will become the stable public contract once the fixture work lands.

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
- Tests for credential redaction, destructive-operation gating, and unsupported
  capability behavior.

Until this document is filled out, [`V1_SCOPE.md`](V1_SCOPE.md) remains the
normative contract source.
