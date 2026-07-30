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

The target MCP revision is `2026-07-28`. The target modern MCP runtime must use
the stable v2 package split through `createMcpHandler` for Streamable HTTP and
`serveStdio` for stdio. Issue
[#59](https://github.com/backblaze-labs/b2-mcp/issues/59) tracks that migration.

Until #59 lands, the current monolithic `@modelcontextprotocol/sdk` v1 imports
and session-bound modern behavior are migration debt, not an allowed final Phase
1 architecture.

## S3-Compatible Surface

Backblaze B2 through MCP is the product contract. S3-compatible behavior is
retained only where S3 semantics are material, such as endpoint reachability,
S3 region checks, presigned URLs, S3 multipart flows, upload-part-copy, and
`AbortIncompleteMultipartUpload` lifecycle rules.

Any `s3_*` compatibility name that can be implemented faithfully through native
SDK operations must either become a compatibility alias over public SDK calls or
be renamed/removed before the public tool contract freezes.
