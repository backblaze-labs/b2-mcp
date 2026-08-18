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

1. Capture scope: source, destination bucket and prefix, object count, estimated bytes, metadata preservation, Object Lock requirements, encryption expectations, and cutover deadline.
2. Verify destination reachability with `b2_list_buckets` and `s3_head_bucket`. List existing destination keys with `s3_list_objects_v2` to identify collisions before any write URL is minted.
3. Choose transfer mode. Use `s3_copy_object` for applicable B2/S3-compatible server-side copy paths. Use `s3_get_presigned_url` for simple direct uploads and multipart tools for large objects.
4. Require confirmation before write-capable presigned URL batches. Keep URLs short-lived and hand them only to the migration worker that will PUT directly to B2.
5. Validate by sampling and summarizing `s3_head_object` metadata, object counts, sizes, checksums where available, and application-level probes. Do not read object bodies into the model.
6. Plan cutover in phases: initial sync, delta sync, freeze, final validation, application switch, read-only observation, rollback window, and deferred cleanup.
7. Close with a migration report: transferred count, skipped count, failed keys, validation method, cutover status, and cleanup tasks that still require a separate approval.
