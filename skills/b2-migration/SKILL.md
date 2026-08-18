---
name: b2-migration
description: Plan source-to-B2 or B2-to-B2 migrations with inventory, direct byte transfer, validation, and rollback checkpoints.
---

# B2 Migration

## When to use

- The user asks to migrate objects from another object store, filesystem, bucket, prefix, or account into B2.
- The user asks for a B2-to-B2 copy, re-keying plan, storage layout change, or cutover checklist.
- The user needs validation evidence before switching an application to B2.

## Byte path

- Object data MUST move directly between the client or workload runner and B2 using presigned URLs, multipart upload URLs, or an external B2/S3 client.
- MUST NOT route object data through the model or MCP server. MCP coordinates inventory, destination checks, presigned write URLs, copy metadata, and validation only.
- Use worker-side S3/B2 clients, direct B2-to-B2 copy where applicable, or multipart presigned uploads for large objects. Keep source credentials and object payloads outside chat.

## Safety gates

- Pause and ask for explicit confirmation before minting write-capable bearer URLs with `s3_get_presigned_url` using `operation: "PutObject"`.
- Pause and ask for explicit confirmation before overwrite, delete, lifecycle, public-access, or retention-weakening work. Do not combine migration and cleanup in one approval.
- Treat migration cutover as a production change: confirm owner, rollback, freeze window, validation threshold, and DNS or application config changes before action.

## Tools used

- `b2_list_buckets`
- `s3_head_bucket`
- `s3_list_objects_v2`
- `s3_head_object`
- `s3_copy_object`
- `s3_get_presigned_url`
- `s3_create_multipart_upload`
- `s3_presign_upload_part`
- `s3_complete_multipart_upload`
- `s3_list_parts`

## Playbook

1. Capture scope: source, destination bucket and prefix, object count, estimated bytes, metadata preservation, Object Lock requirements, encryption expectations, cutover deadline, and explicit collision/overwrite policy. Default to fail-on-collision.
2. Create a durable migration manifest outside chat with source key, destination key, size, checksum if available, metadata, copy or upload mode, status, retry count, continuation cursor, multipart upload ID, completed parts, and validation checkpoint.
3. Verify destination reachability with `b2_list_buckets` and `s3_head_bucket`. List existing destination keys with `s3_list_objects_v2` before any write URL is minted; use pages of at most 1,000 keys, persist continuation tokens, and show at most 50 sampled rows in chat.
4. Choose transfer mode. Use `s3_copy_object` for applicable B2/S3-compatible server-side copy paths. Use `s3_get_presigned_url` for simple direct uploads and multipart tools for large objects, persisting upload IDs, part numbers, ETags, and completed-part checkpoints.
5. Bound retry behavior in the migration worker: exponential backoff with jitter, a declared retry limit per object, and a stop condition that writes failed keys to the manifest instead of looping indefinitely.
6. Require confirmation before write-capable presigned URL batches. Keep URLs short-lived and hand them only to the migration worker that will PUT directly to B2.
7. Resume after restart from the manifest: skip validated objects, continue incomplete multipart uploads from saved state, retry failed objects within the approved limit, and never overwrite destination keys outside the approved collision policy.
8. Validate by sampling and summarizing `s3_head_object` metadata, object counts, sizes, checksums where available, and application-level probes. Do not read object bodies into the model.
9. Plan cutover in phases: initial sync, delta sync, freeze, final validation, completed-manifest checkpoint, application switch, read-only observation, rollback window, and deferred cleanup. Cutover only proceeds from a completed validation checkpoint.
10. Close with a migration report: transferred count, skipped count, failed keys, validation method, manifest location, cutover status, and cleanup tasks that still require a separate approval.
