---
name: b2-object-lock
description: Configure and operate B2 Object Lock retention and legal holds while preserving immutability guarantees.
---

# B2 Object Lock

## When to use

- The user asks to enable, verify, or change Object Lock retention on B2 buckets or files.
- The user asks about legal holds, governance bypass, compliance retention, or ransomware-resistant storage.
- The user wants to remove or shorten retention and needs a safety review before doing so.

## Byte path

- Object data MUST move directly between the client or workload runner and B2 using presigned URLs, multipart upload URLs, or an external B2/S3 client.
- MUST NOT route object data through the model or MCP server. Object Lock workflows use bucket metadata, object version metadata, retention settings, and legal hold state only.
- Do not print object contents while investigating retention. Use object keys, file IDs, version IDs, timestamps, and policy names.

## Safety gates

- Pause and ask for explicit confirmation before using `b2_update_bucket`; confirm whether the change enables protection, makes a bucket public, disables Object Lock, clears default retention, changes lifecycle deletion, or changes replication.
- Pause and ask for explicit confirmation before using `b2_update_file_retention`, especially when clearing retention or using governance bypass.
- Pause and ask for explicit confirmation before using `b2_update_file_legal_hold` when setting legal hold to off.
- Pause and ask for explicit confirmation before deleting protected versions with `s3_delete_object` or `s3_delete_objects`.

## Tools used

- `b2_list_buckets`
- `b2_update_bucket`
- `b2_update_file_retention`
- `b2_update_file_legal_hold`
- `s3_list_object_versions`
- `s3_head_object`
- `s3_delete_object`
- `s3_delete_objects`

## Playbook

1. Establish the protection goal: compliance retention, governance retention, legal hold, default bucket retention, or one-off file retention.
2. Inventory the bucket with `b2_list_buckets` and object versions with `s3_list_object_versions`. Use pages of at most 1,000 versions, persist continuation tokens outside chat, and show at most 50 sampled rows while writing full inventories to an external report. Inspect specific targets with `s3_head_object` before proposing any change.
3. For enabling or strengthening protection, call out the retention mode, duration, effective date, and operational impact before `b2_update_bucket`, `b2_update_file_retention`, or `b2_update_file_legal_hold`.
4. For weakening protection, require an explicit confirmation that names the bucket, file ID or key, version ID where applicable, current protection, requested weaker state, reason, and rollback limitations.
5. For deletion, verify that the target version is correct and that retention or legal hold state permits the action. Use `s3_delete_object` or `s3_delete_objects` only after the destructive confirmation gate, with `s3_delete_objects` batches of 1,000 objects or fewer and a checkpoint after every batch.
6. Finish with an immutability report: protected buckets, default retention, per-file exceptions, legal holds, proposed changes, completed changes, and any items intentionally left untouched.
