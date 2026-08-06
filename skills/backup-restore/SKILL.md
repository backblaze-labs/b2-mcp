---
name: backup-restore
description: Plan and execute B2 backup and restore workflows while keeping object bytes off the MCP control plane.
---

# B2 Backup And Restore

## When To Use

- Trigger: The user asks to back up a local dataset, application export, database dump, media library, or generated artifact set to B2.
- Trigger: The user asks to restore objects from B2, verify backup completeness, or produce a restore drill plan.
- Trigger: The user asks for a repeatable backup workflow that includes manifests, version checks, and recovery validation.

## Tools Used

- `b2_list_buckets`
- `s3_head_bucket`
- `s3_list_objects_v2`
- `s3_list_object_versions`
- `s3_head_object`
- `s3_get_presigned_url`
- `s3_create_multipart_upload`
- `s3_presign_upload_part`
- `s3_complete_multipart_upload`
- `s3_abort_multipart_upload`
- `s3_put_object`
- `b2_unfinished_uploads`

## Byte Path

Never route object bytes through the model. Never route object bytes through the MCP server. Use the MCP tools for planning, metadata, manifests, presigned URL creation, and multipart coordination only.

For backup data, prefer a client-to-B2 upload path with short-lived presigned URLs or multipart upload URLs. Use `s3_put_object` only for small manifests, checksums, and sidecar files that are safe to carry on the control plane.

For restores, generate a GetObject presigned URL and have the client download directly from B2 to the target restore location. Do not ask the model to inspect file contents unless the user explicitly supplies a small non-sensitive sample.

## Safety Gates

Pause for explicit user confirmation before any call that can create, overwrite, or discard backup data. The server also enforces `B2_DESTRUCTIVE_POLICY`; when required, repeat the identical tool call only after the user approves `confirm: true`.

- `s3_get_presigned_url`: when `operation` is `PutObject`, confirm the exact bucket, key or prefix, expiry, and overwrite policy before using `confirm: true`.
- `s3_abort_multipart_upload`: confirm the upload ID and that discarding uploaded parts is intentional before using `confirm: true`.

Do not delete old backups in this skill. Hand off deletion, lifecycle expiration, or retention changes to the lifecycle-cost-hygiene or object-lock-retention skill.

## Playbook

1. Establish scope: source path, target bucket, target prefix, expected object count, expected size, recovery objective, retention need, and whether the data requires Object Lock.
2. Verify the target bucket with `b2_list_buckets` and `s3_head_bucket`. Stop if the key cannot see the bucket or lacks write capability.
3. Inventory existing backup objects with `s3_list_objects_v2` and `s3_list_object_versions`. Use prefix filters; do not scan unrelated tenant or application data.
4. Choose the byte path:
   - Small manifest or checksum object: use `s3_put_object`.
   - Normal backup object: use `s3_get_presigned_url` with `operation` set to `PutObject`, then have the client upload directly to B2.
   - Large object: use `s3_create_multipart_upload`, `s3_presign_upload_part`, client-to-B2 part uploads, and `s3_complete_multipart_upload`.
5. Record non-secret metadata: bucket, key, size, checksum, upload time, version ID when available, and restore command. Never record application keys or presigned URL values in durable notes.
6. Validate the backup with `s3_head_object` for expected size and metadata. For a restore drill, generate a GetObject presigned URL and have the client download directly to a temporary restore path.
7. Check for abandoned multipart uploads with `b2_unfinished_uploads`. If cleanup is needed, pause and confirm before aborting any upload.
