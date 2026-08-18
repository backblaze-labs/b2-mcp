# Architecture

This document records the Phase 1 runtime architecture decisions that are broad
enough to affect implementation, contract tests, packaging, and release review.

## B2 Integration Boundary

The official Backblaze TypeScript SDK is the required integration boundary for
B2 behavior. The reviewed adoption contract is
[`SDK_ADOPTION_CONTRACT.md`](SDK_ADOPTION_CONTRACT.md), which is normative for
issue [#71](https://github.com/backblaze-labs/b2-mcp/issues/71).

Direct B2 HTTP calls are not allowed in runtime code. AWS SDK calls to B2's
S3-compatible endpoint are the permanent S3 data-plane implementation and must
stay anchored through the SDK `/s3` helper.

The approved implementation order is:

1. public high-level `@backblaze-labs/b2-sdk` facade;
2. documented `@backblaze-labs/b2-sdk/raw` API;
3. documented `@backblaze-labs/b2-sdk/partner` API;
4. documented `@backblaze-labs/b2-sdk/s3` helper;
5. composition of public SDK operations.

No runtime code may import SDK private modules, package-internal files, or
unpublished branches.

## Tool Backing Taxonomy

The public 40-tool surface is documented by backing category, not by separate
functional buckets. Every tool belongs to exactly one of three categories:

1. Native B2 SDK (`@backblaze-labs/b2-sdk`) for B2 control-plane operations the
   S3 API has no equivalent for, including buckets, application keys, Object
   Lock, event notifications, and Partner/Groups operations.
2. AWS S3 SDK (`@aws-sdk/client-s3`) for the S3-compatible data plane:
   objects, presigning, multipart uploads, bucket reachability/location, and S3
   lifecycle operations.
3. Neither SDK for repository-owned MCP analytics, such as usage growth, egress
   leaders, largest files, and unfinished uploads, where no SDK exposes the
   requested aggregate operation as a primitive.

Availability is orthogonal to backing. Durable-secret-producing tools are
sink-backed: on stdio the default file sink makes `b2_create_key` and
`b2_create_group_member` available (and `b2_reserve_trial_create_account` only in
explicit inline mode), while HTTP/serverless defaults to `off` and keeps them as
non-secret unavailable stubs until a reviewed sink is configured. Either way they
keep their Native B2 SDK backing category.

## Runtime Dependency Budget

The server keeps normal npm package semantics and is not bundled to hide package
count or dependency ownership. `package-budget.json` is the reviewed Phase 1
runtime budget and records each direct production dependency from
`dependencies` or `optionalDependencies`, its purpose, the reviewed version, npm
registry URL, integrity, current package-footprint baseline, and the ceiling
that CI enforces. Clean consumer install measurements are generated from the
committed production lock graph so an unchanged SHA does not drift with new
registry releases.

The package-budget gate rejects unapproved direct production dependencies, Axios
runtime imports, SDK private or unpublished imports, Git/path SDK dependencies,
unpinned or provenance-mismatched direct dependencies, production lockfile
entries without npm registry provenance and integrity, and AWS runtime imports
outside `src/s3/aws-sdk-adapter.ts`. The AWS adapter is the permanent
repository-owned S3 data-plane boundary for `s3_*` object, multipart, bucket,
lifecycle, and presigned URL operations against B2's S3-compatible endpoint.
Partner/Groups tools use the SDK `/partner` boundary and remain gated by master
key/Partner entitlement plus the no-durable-secret policy for account-creation
flows.

New runtime dependencies must not exist solely for Node.js 18/20, browser, Bun,
Deno, stream, abort, retry, or HTTP-client compatibility. Prefer Node.js 22+
built-ins, the official MCP server package, and public
`@backblaze-labs/b2-sdk` exports.

## MCP Runtime Boundary

The MCP runtime targets the `2026-07-28` serving model. The implementation uses
the stable SDK v2 package split pinned at `2.0.0`:

- `@modelcontextprotocol/server` for `McpServer`, `createMcpHandler`, and
  `serveStdio`;
- `@modelcontextprotocol/client` for protocol/package tests.

`src/http-server.ts` owns Node HTTP listen/shutdown and delegates each request
to the runtime-neutral `src/http-fetch-handler.ts` pipeline. Its
repository-owned Web bridge helpers live in `src/utils/node-web-bridge.ts`;
they translate Node `IncomingMessage` objects to Web `Request`s, resume unread
request bodies, and stream Web `Response`s back to `ServerResponse` while
preserving request aborts and response backpressure. `@modelcontextprotocol/node`
is intentionally absent: its `2.0.0` release pulls a vulnerable Node adapter
transitively, and a package manager override would protect this checkout
without protecting consumers of the published package.

The monolithic `@modelcontextprotocol/sdk` v1 package is not a direct or
runtime dependency and must not be imported by production or test code. Its only
allowed lockfile presence is a dev-only transitive of the locked Inspector CLI.
HTTP serving is stateless and per request: Host, Origin, caller authentication,
B2 credential resolution, rate/concurrency limits, body-size limits, drain, and
shutdown checks run outside the SDK handler; protocol header/body validation
remains inside `createMcpHandler`.

The HTTP serving pipeline passes only an allowlisted MCP/header set to the SDK
handler; B2 credential headers and caller `Authorization` are consumed by
repository-owned credential resolution before the SDK handler boundary.
Per-request credential state is then carried into the SDK factory by
`AsyncLocalStorage` and fails closed when absent. The repository tracks each SDK
server built for the request and closes it after the Node response lifecycle
completes; local HTTP tests cover
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

Backblaze B2 through MCP is the product contract. The compatibility `s3_*`
data plane is implemented by the permanent AWS S3 SDK adapter configured
against B2's S3-compatible endpoint through the official SDK `/s3` helper.
That adapter owns object, presigned URL, multipart, endpoint reachability,
location, lifecycle, upload-part-copy, and usage-report object-read paths.
