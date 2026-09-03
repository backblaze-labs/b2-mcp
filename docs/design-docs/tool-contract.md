# Tool Contract

Owner: Gonza (`@goanpeca`). Quality reviewer: Sophie / Quality Keeper (QK)
(`@sophiecarreras`).

Status: frozen for Phase 1. Issue #49 owns the deterministic tool fixtures,
machine-readable contract artifact, and generated profile reference. Issue #166
extends the same generated artifact with opt-in MCP prompt profile fixtures.

## Phase 1 Source Of Truth

The normative Phase 1 tool-profile decisions live in [`../product-specs/v1-scope.md`](../product-specs/v1-scope.md).
The frozen machine-readable contract is
[`../tool-profile-contract.json`](../tool-profile-contract.json), and the generated
human-readable reference is [`../TOOL_PROFILES.md`](../TOOL_PROFILES.md). The
deterministic `tools/list` fixtures are checked in under
[`../../tests/fixtures/tool-contract`](../../tests/fixtures/tool-contract).
The prompt fixtures (prompts are off by default; set `B2_ENABLE_MCP_PROMPTS=true` to enable) are checked in under
[`../../tests/fixtures/prompt-contract`](../../tests/fixtures/prompt-contract).
Each profile entry records the capability input that generated it; each fixture
hash covers the sorted tool names and normalized tool definitions, including
model-visible schema and parameter descriptions.
Prompt fixture hashes cover sorted prompt names, argument JSON schemas,
required available tools, and prompt-specific B2 capability prerequisites.
The artifact and fixtures also identify the resolved MCP SDK packages and
`@backblaze-labs/b2-sdk` version used to produce the snapshot.
Every tool belongs to exactly one backing category: Native B2 SDK
(`@backblaze-labs/b2-sdk`) for B2 operations with no S3 equivalent, AWS S3 SDK
(`@aws-sdk/client-s3`) for the S3-compatible data plane, or neither SDK for
repository-owned MCP analytics that no SDK exposes as a primitive.
The machine-readable contract publishes this as `backingCategories`,
`toolBacking`, and per-profile `backingCounts`.
Partner/Groups read/eject/list handlers are SDK-backed native B2 operations in
the full profile; Partner operations that produce durable secrets remain
non-secret unavailable compatibility stubs until a reviewed sink exists.
Availability is a per-tool annotation, not a separate profile bucket.

The public contract defines:

- supported MCP protocol era and fallback behavior;
- full, default, and read-only tool profiles;
- exact tool names, counts, and profile hashes;
- input-schema requirements and prohibited credential fields;
- structured tool-result text format policy;
- destructive and protection-weakening confirmation rules;
- secret-producing tool policy;
- opt-in prompt names, argument schemas, and workflow prerequisites;
- compatibility rules for stale cached `tools/list` profiles.

## Structured Result Text Contract

Issue #82 adds the pre-release structured-result text contract. MCP transport
messages, JSON-RPC envelopes, and `structuredContent` remain specification
compliant JSON. For structured successful tool results, `structuredContent` is
the canonical sanitized JSON-compatible value; the single `TextContent.text`
block is selected from process configuration during server/request config
resolution by `B2_MCP_OUTPUT_FORMAT`:

| Value  | Text block format | Notes                                                                                               |
| ------ | ----------------- | --------------------------------------------------------------------------------------------------- |
| `json` | Compact JSON      | Default mode for text parsers. Before this contract, text JSON was pretty-printed with 2 spaces.    |
| `toon` | TOON              | Opt-in. Repo-owned encoder for TOON spec `4.1`; preflighted before readiness reports the server up. |

Unknown values are startup/config errors. Errors, validation failures, and
concise status messages remain plain text. The server does not change HTTP
`Content-Type`, add a media-type field to `TextContent`, add per-result format
prefixes, or advertise an unregistered MCP extension.
During rolling deploys, keep all pods on compact JSON unless clients prefer
`structuredContent` or explicitly support both configured text shapes.

The repository-owned serializer runs after tool-specific result bounds and
central secret sanitization. It normalizes the sanitized value through the JSON
data model before text emission and preserves insertion-order field ordering;
the TOON encoder performs no repository-owned key sorting. Format-major TOON
upgrades require explicit contract review before the repo-owned encoder/spec
version changes. In TOON mode, oversized/deep inputs or encode failures degrade
the text block to compact JSON while preserving the canonical
`structuredContent`.

## Required Evidence

- Deterministic modern and legacy `tools/list` fixtures for every named
  profile.
- CI checks that compare fixtures, README counts, generated profile reference,
  V1 scope lists, and official SDK-client `tools/list` output.
- Tests for credential redaction, durable-secret output sanitization,
  destructive-operation gating, and unsupported
  capability behavior.
- Tests for TOON/JSON result text selection, hostile-string round trips, and
  JSON-compatible `structuredContent` preservation.
- A checked-in representative result corpus and benchmark comparing pretty JSON,
  compact JSON, and TOON byte/character/token counts before any future change
  makes TOON the default.

Follow-up behavioral coverage for live authorization, idempotency, and result
corpora remains tracked separately. The contract freeze covers the Phase 1 tool
membership, stable input-schema surface, destructive confirmation fields,
credential-field exclusions, JSON Schema 2020-12 validity, modern cache hints,
and advertised MCP capabilities.
