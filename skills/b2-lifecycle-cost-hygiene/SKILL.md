---
name: b2-lifecycle-cost-hygiene
description: Audit B2 storage growth, stale versions, unfinished uploads, egress leaders, and lifecycle rules before cost-impacting cleanup.
---

# B2 Lifecycle And Cost Hygiene

## When to use

- The user asks why a B2 bill, bucket, prefix, or egress pattern is growing.
- The user wants lifecycle rules for old versions, hidden files, abandoned multipart uploads, or retention-aware cleanup.
- The user asks to delete stale objects, expire versions, abort uploads, or reduce storage cost.

## Byte path

- Object data MUST move directly between the client or workload runner and B2 using presigned URLs, multipart upload URLs, or an external B2/S3 client.
- MUST NOT route object data through the model or MCP server. Cost hygiene uses reports, listings, metadata, lifecycle policies, and aggregate counts rather than object bodies.
- Sample only bounded metadata. Avoid dumping complete large listings into chat; summarize by bucket, prefix, age band, storage class, and owner where available.

## Safety gates

- Pause and ask for explicit confirmation before using `s3_put_bucket_lifecycle` when a rule schedules object or version deletion.
- Pause and ask for explicit confirmation before using `s3_abort_multipart_upload`; uploaded parts are discarded.
- Pause and ask for explicit confirmation before using `s3_delete_object` or `s3_delete_objects`; deletion is irreversible unless a retained version remains.
- Pause and ask for explicit confirmation before using `b2_update_bucket` for lifecycle rules, public bucket changes, Object Lock weakening, or replication changes.

## Tools used

- `b2_usage_growth`
- `b2_largest_files`
- `b2_egress_leaders`
- `b2_unfinished_uploads`
- `b2_list_buckets`
- `s3_list_objects_v2`
- `s3_list_object_versions`
- `s3_list_multipart_uploads`
- `s3_put_bucket_lifecycle`
- `s3_abort_multipart_upload`
- `s3_delete_object`
- `s3_delete_objects`
- `b2_update_bucket`

## Playbook

1. Define the cost question: storage growth, old versions, hidden files, abandoned multipart uploads, egress, large objects, or lifecycle coverage.
2. Use `b2_usage_growth`, `b2_largest_files`, `b2_egress_leaders`, and `b2_unfinished_uploads` to build an evidence-first summary. Use `s3_list_objects_v2`, `s3_list_object_versions`, and `s3_list_multipart_uploads` for targeted follow-up.
3. Group findings by bucket, prefix, owner, age, object count, and estimated bytes. Separate live data, noncurrent versions, hide markers, unfinished uploads, and report-derived egress.
4. Propose lifecycle rules only after checking retention and recovery requirements. For deletion policies, state the exact rule, prefix filter, age threshold, expected effect, and rollback limitation before `s3_put_bucket_lifecycle` or `b2_update_bucket`.
5. For one-time cleanup, produce a dry-run style target list and require explicit confirmation before aborting multipart uploads or deleting objects.
6. Close with a cost hygiene report: estimated bytes affected, rules proposed or applied, destructive operations skipped or completed, validation queries, and next review date.
