---
name: migration-handoff
description: Move workloads into or within B2 using direct transfer paths, server-side copy, and verification checkpoints.
---

# B2 Migration Handoff

## When To Use

- Trigger: The user asks to migrate data from another object store, local storage, or one B2 bucket or prefix to another.
- Trigger: The user asks for a cutover checklist, preflight validation, or post-migration verification.
- Trigger: The user asks to avoid sending migration payload bytes through the model or MCP server.

## Tools Used

- `b2_list_buckets`
- `b2_create_bucket`
- `b2_update_bucket`
- `s3_head_bucket`
- `s3_get_bucket_location`
- `s3_list_objects_v2`
- `s3_head_object`
- `s3_copy_object`
- `s3_get_presigned_url`
- `s3_create_multipart_upload`
- `s3_presign_upload_part`
- `s3_complete_multipart_upload`
- `s3_upload_part_copy`

## Byte Path

Never route object bytes through the model. Never route object bytes through the MCP server. Use server-side copy when source and destination are in B2 and a direct client-to-B2 transfer path with presigned URLs or multipart upload URLs when bytes must move from an external source.

The MCP server may coordinate buckets, keys, metadata, presigned URLs, and multipart state. The transfer client must stream payload bytes directly to or from B2.

## Safety Gates

Pause for explicit user confirmation before any migration step that can overwrite destination objects, weaken bucket protection, or mint a write-capable bearer URL. The server also enforces `B2_DESTRUCTIVE_POLICY`; when required, repeat the identical tool call only after the user approves `confirm: true`.

- `b2_update_bucket`: use `confirm: true` only when changing public access, Object Lock, lifecycle deletion, default retention, or replication settings.
- `s3_get_presigned_url`: when `operation` is `PutObject`, confirm the destination bucket, prefix, expiry, overwrite plan, and transfer client identity before using `confirm: true`.

Before cutover, pause and confirm the rollback plan, read-only window if any, and verification threshold.

## Playbook

1. Establish migration scope: source, destination bucket and prefix, object count, total bytes, metadata requirements, Object Lock needs, lifecycle rules, downtime tolerance, and rollback plan.
2. Use `b2_list_buckets`, `s3_head_bucket`, and `s3_get_bucket_location` to verify destination readiness. Create a new bucket only when the target policy is clear.
3. Align bucket settings with `b2_create_bucket` or `b2_update_bucket`. Keep Object Lock, encryption, lifecycle, and public/private state explicit.
4. Inventory source and destination with `s3_list_objects_v2`. Use `s3_head_object` for spot checks and metadata verification.
5. Choose the transfer path:
   - B2-to-B2 object: prefer `s3_copy_object` or `s3_upload_part_copy` for large objects when possible.
   - External-to-B2 object: generate PutObject presigned URLs or multipart upload URLs and have the migration client upload directly.
   - Large objects: coordinate `s3_create_multipart_upload`, `s3_presign_upload_part`, client upload, and `s3_complete_multipart_upload`.
6. Verify counts, sizes, and spot-check metadata after transfer. Keep versioning and retention requirements visible when comparing source and destination.
7. For cutover, summarize remaining deltas, DNS or application configuration steps outside B2, rollback trigger, and final read/write switchover timing.
