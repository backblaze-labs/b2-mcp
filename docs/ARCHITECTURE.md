# Architecture

This document records the Phase 1 runtime architecture decisions that are broad
enough to affect implementation, contract tests, packaging, and release review.

## B2 Integration Boundary

The official Backblaze TypeScript SDK is the required integration boundary for
B2 behavior. The reviewed adoption contract is
[`SDK_ADOPTION_CONTRACT.md`](SDK_ADOPTION_CONTRACT.md), which is normative for
issue [#71](https://github.com/backblaze-labs/b2-mcp/issues/71).

Direct Axios calls to the B2 Native API and direct AWS SDK calls to B2's
S3-compatible endpoint are inherited implementation details. They are not the
default architecture for Phase 1 and must not be expanded for new B2 behavior.

The approved implementation order is:

1. public high-level `@backblaze-labs/b2-sdk` facade;
2. documented `@backblaze-labs/b2-sdk/raw` API;
3. documented `@backblaze-labs/b2-sdk/s3` helper;
4. composition of public SDK operations;
5. a linked upstream SDK gap with an explicit v0.1 disposition.

No runtime code may import SDK private modules, package-internal files, or
unpublished branches.

## MCP Runtime Boundary

The MCP runtime targets the `2026-07-28` serving model. The implementation uses
the stable SDK v2 package split pinned at `2.0.0`:

- `@modelcontextprotocol/server` for `McpServer`, `createMcpHandler`, and
  `serveStdio`;
- `@modelcontextprotocol/node` for the single Node HTTP adapter wrapping the MCP
  handler with `toNodeHandler`;
- `@modelcontextprotocol/client` for protocol/package tests.

The monolithic `@modelcontextprotocol/sdk` v1 package is not a dependency and
must not be imported by production or test code. HTTP serving is stateless and
per request: Host, Origin, caller authentication, B2 credential resolution,
rate/concurrency limits, body-size limits, drain, and shutdown checks run
outside the SDK handler; protocol header/body validation remains inside
`createMcpHandler`.

The Node request adapter receives only an allowlisted MCP/header set; B2
credential headers and caller `Authorization` are consumed by repository-owned
credential resolution before the adapter boundary. Per-request credential state
is then carried into the SDK factory by `AsyncLocalStorage` and fails closed when
absent. The repository tracks each SDK server built for the request and closes
it after the Node response lifecycle completes; local HTTP tests cover
credential-header stripping, concurrent tenant isolation, per-request disposal,
and drain survival for this model.

Supported revision matrix:

| Transport | Modern path                                | Compatibility path                                                        |
| --------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| HTTP      | `2026-07-28` via `createMcpHandler` + POST | SDK v2 `legacy: "stateless"` for supported 2025-era Streamable HTTP POSTs |
| stdio     | `2026-07-28` via `serveStdio`              | SDK v2 stdio legacy serving for supported 2025-era `initialize` clients   |

No production path relies on `initialize`, `notifications/initialized`,
`Mcp-Session-Id`, GET streams, DELETE session termination, `Last-Event-ID`, or
event replay. Legacy initialization is handled only inside the SDK's explicit
compatibility path.

Tool registration is repository-owned: tool modules register through a local
adapter that buffers definitions, wraps callbacks for audit/sanitization, sorts
names deterministically, and then calls the public SDK `registerTool()` API. The
adapter also exposes the test/diagnostic registry; production code never reads
SDK private tool storage.

Structured successful tool results flow through the repository-owned result
serializer in `src/utils/result-serializer.ts`. Tool handlers continue to return
sanitized JSON-compatible values through `toolJson`; the serializer keeps that
value in MCP `structuredContent` and emits exactly one LLM-facing
`TextContent.text` representation. `B2_MCP_OUTPUT_FORMAT=json` is the default
mode and emits compact JSON; `B2_MCP_OUTPUT_FORMAT=toon` opts into the
repo-owned TOON encoder for spec `4.1`. Protocol envelopes, HTTP
`Content-Type`, and MCP
`structuredContent` remain JSON. The server does not claim TOON negotiation or
add an MCP extension because `TextContent` has no media-type field, so rolling
deploys must not mix JSON- and TOON-configured pods unless clients are prepared
for both text shapes.

The serializer runs after tool-specific bounds and the central sanitizer. It
normalizes through JSON serialization before TOON/JSON text emission, so Dates,
non-finite numbers, omitted fields, pagination tokens, request IDs, metadata,
and B2-controlled object names follow the same JSON data model as
`structuredContent`. Field order is the JavaScript insertion order produced by
the B2/S3 SDKs and repository payload builders; the TOON encoder preserves that
order and performs no repository-side key sorting. Text encoding is CPU-bound
with no blocking I/O, but `toolJson` is reserved for bounded control-plane
results after list limits and inline payload caps; bulk object bytes stay on the
streaming, local-file, base64, or presigned-URL paths instead.

## S3-Compatible Surface

Backblaze B2 through MCP is the product contract. S3-compatible behavior is
retained only where S3 semantics are material, such as endpoint reachability,
S3 region checks, presigned URLs, S3 multipart flows, upload-part-copy, and
`AbortIncompleteMultipartUpload` lifecycle rules.

Any `s3_*` compatibility name that can be implemented faithfully through native
SDK operations must either become a compatibility alias over public SDK calls or
be renamed/removed before the public tool contract freezes.
