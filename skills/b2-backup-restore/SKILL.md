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
- Treat restored data and presigned URLs as sensitive bearer material. Do not print object contents or presigned download URLs into chat; hand URLs only to the out-of-band restore client or worker.

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

1. Confirm the bucket, retention target, restore point objective, restore time objective, and destination ownership model. Default to a unique run prefix. Reuse an existing prefix only when the user confirms exclusive write ownership for the whole run; snapshot metadata checks cannot prevent a concurrent writer from claiming a key after a presigned URL is minted.
2. Build a durable manifest outside chat: object keys, sizes, checksums if available, content type, encryption expectation, retention expectation, source path, desired destination key, status, retry count, and last successful checkpoint. Keep secrets and file contents out of chat.
3. For listings, request pages of at most 1,000 keys, persist continuation tokens to the manifest, stop chat output after 50 sampled rows, and write full inventories to the external manifest or report.
4. For small controlled writes, mint a short-lived PutObject URL with `s3_get_presigned_url` only after the safety gate. For large objects, persist multipart upload ID, part numbers, ETags, and completed-part checkpoints after each part before `s3_complete_multipart_upload`.
5. Use bounded retries with exponential backoff and jitter from the client or worker. Stop and report after the approved retry limit instead of restarting the whole backup from chat.
6. Resume after restart from the manifest: skip verified completed objects, continue incomplete multipart uploads from the saved upload ID and part list, and write only inside the unique run prefix or the confirmed exclusively-owned prefix.
7. Verify each uploaded object with `s3_head_object` and, when useful, `s3_list_objects_v2` over the prefix. Compare size, ETag or checksum metadata, retention metadata, and expected key count before marking the manifest checkpoint complete.
8. For restore, list the restore prefix with `s3_list_objects_v2`, inspect targets with `s3_head_object`, then mint short-lived GetObject URLs with `s3_get_presigned_url` only for the out-of-band restore worker. The client downloads directly from B2.
9. If multipart work is abandoned, inspect with `s3_list_parts`, write the current state to the manifest, and pause for confirmation before `s3_abort_multipart_upload`.
10. Close with a concise backup or restore report: bucket, prefix, object count, total planned bytes, completed objects, skipped objects, retry failures, checkpoint file location, verification method, and any follow-up manual checks.
