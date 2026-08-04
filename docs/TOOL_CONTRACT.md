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
- structured tool-result text format policy;
- destructive and protection-weakening confirmation rules;
- secret-producing tool policy;
- compatibility rules for stale cached `tools/list` profiles.

## Structured Result Text Contract

Issue #82 adds the pre-release structured-result text contract. MCP transport
messages, JSON-RPC envelopes, and `structuredContent` remain specification
compliant JSON. For structured successful tool results, `structuredContent` is
the canonical sanitized JSON-compatible value; the single `TextContent.text`
block is selected once at server startup by `B2_MCP_OUTPUT_FORMAT`:

| Value  | Text block format | Notes                                                    |
| ------ | ----------------- | -------------------------------------------------------- |
| `toon` | TOON              | Default. Official `@toon-format/toon@4.1.0`, spec `4.1`. |
| `json` | Compact JSON      | Compatibility mode for clients that parse text as JSON.  |

Unknown values are startup/config errors. Errors, validation failures, and
concise status messages remain plain text. The server does not change HTTP
`Content-Type`, add a media-type field to `TextContent`, add per-result format
prefixes, or advertise an unregistered MCP extension.

The repository-owned serializer runs after tool-specific result bounds and
central secret sanitization. It normalizes the sanitized value through the JSON
data model before text emission and preserves insertion-order field ordering;
the TOON encoder performs no repository-owned key sorting. Format-major TOON
upgrades require explicit contract review before the pinned package/spec version
changes.

## Required Evidence

- Deterministic `tools/list` fixtures for every named profile.
- CI checks that compare fixtures, README counts, and actual registration.
- Tests for credential redaction, durable-secret output sanitization,
  destructive-operation gating, and unsupported
  capability behavior.
- Tests for TOON/JSON result text selection, hostile-string round trips, and
  JSON-compatible `structuredContent` preservation.

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
