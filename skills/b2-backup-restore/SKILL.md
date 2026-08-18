---
name: b2-backup-restore
description: Plan and run B2 backup and restore workflows with presigned or multipart data paths and explicit recovery validation.
---

# B2 Backup And Restore

## When to use

- The user asks to back up a directory, application export, database dump, model artifact, or media set to Backblaze B2.
- The user asks to restore or verify previously backed up B2 objects.
- The user needs a repeatable backup runbook that separates metadata planning from object byte transfer.

## Byte path

- Object data MUST move directly between the client or workload runner and B2 using presigned URLs, multipart upload URLs, or an external B2/S3 client.
- MUST NOT route object data through the model or MCP server. Use MCP only for bucket discovery, metadata checks, presigned URL creation, manifest planning, and bounded status.
- Inline object helpers are only acceptable for small, non-sensitive manifests or sidecars under the server inline limit; never use them for bulk backup or restore bytes.

## Safety gates

- Pause and ask for explicit confirmation before minting a write-capable bearer URL with `s3_get_presigned_url` using `operation: "PutObject"`.
- Pause and ask for explicit confirmation before aborting incomplete multipart state with `s3_abort_multipart_upload`; uploaded parts are discarded.
- Pause and ask for explicit confirmation before overwrite, retention change, lifecycle deletion, or any cleanup step that uses a server-gated destructive tool. Re-invoke the identical call only after the user approves the target and intent.
- Treat restored data as sensitive. Do not print object contents; write restores to user-approved paths or provide direct B2 download URLs.

## Tools used

- `b2_list_buckets`
- `s3_head_bucket`
- `s3_list_objects_v2`
- `s3_head_object`
- `s3_get_presigned_url`
- `s3_create_multipart_upload`
- `s3_presign_upload_part`
- `s3_complete_multipart_upload`
- `s3_list_parts`
- `s3_abort_multipart_upload`

## Playbook

1. Confirm the bucket, prefix, retention target, restore point objective, and restore time objective. Verify the destination bucket with `b2_list_buckets` and `s3_head_bucket`.
2. Build a manifest outside the model context: object keys, sizes, checksums if available, content type, encryption expectation, retention expectation, and source path. Keep secrets and file contents out of chat.
3. For small controlled writes, mint a short-lived PutObject URL with `s3_get_presigned_url` only after the safety gate. For large objects, create multipart state with `s3_create_multipart_upload`, mint part URLs with `s3_presign_upload_part`, have the client upload parts directly to B2, then finish with `s3_complete_multipart_upload`.
4. Verify each uploaded object with `s3_head_object` and, when useful, `s3_list_objects_v2` over the prefix. Compare size, ETag or checksum metadata, retention metadata, and expected key count.
5. For restore, list the restore prefix with `s3_list_objects_v2`, inspect targets with `s3_head_object`, then mint short-lived GetObject URLs with `s3_get_presigned_url`. The client downloads directly from B2.
6. If multipart work is abandoned, inspect with `s3_list_parts` and pause for confirmation before `s3_abort_multipart_upload`.
7. Close with a concise backup or restore report: bucket, prefix, object count, total planned bytes, completed objects, skipped objects, verification method, and any follow-up manual checks.
