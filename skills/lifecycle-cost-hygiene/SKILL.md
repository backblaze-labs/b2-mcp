---
name: lifecycle-cost-hygiene
description: Find B2 storage waste and apply lifecycle rules with explicit approval for any deletion schedule.
---

# B2 Lifecycle And Cost Hygiene

## When To Use

- Trigger: The user asks why a bucket is growing, which objects are largest, or which uploads are wasting storage.
- Trigger: The user asks to add lifecycle rules, expire old versions, hide old objects, or cancel incomplete multipart uploads.
- Trigger: The user asks for a storage cost hygiene review before or after a backup, migration, or incident.

## Tools Referenced

- `b2_list_buckets`
- `b2_largest_files`
- `b2_unfinished_uploads`
- `b2_usage_growth`
- `b2_egress_leaders`
- `s3_list_objects_v2`
- `s3_list_object_versions`
- `s3_put_bucket_lifecycle`
- `b2_update_bucket`

## Byte Path

Never route object bytes through the model. Never route object bytes through the MCP server. No object bytes are involved; use listings, object metadata, usage reports, and lifecycle policy metadata.

For any sample investigation, inspect names, sizes, upload times, version state, and prefixes. Do not download object bodies to decide a lifecycle rule.

## Safety Gates

Pause for explicit user confirmation before any lifecycle rule that schedules deletion, expiration, protection weakening, or bucket replication changes. The server also enforces `B2_DESTRUCTIVE_POLICY`; when required, repeat the identical tool call only after the user approves `confirm: true`.

- `s3_put_bucket_lifecycle`: use `confirm: true` only after confirming the bucket, affected prefixes, version scope, expiration timing, and rollback limitations for deletion or noncurrent-version expiration rules.
- `b2_update_bucket`: use `confirm: true` only when a lifecycle rule schedules permanent deletion, clears default retention, disables Object Lock, makes the bucket public, or changes replication.

Rules that only cancel incomplete multipart uploads are still operationally important, but they do not delete completed objects. Explain that distinction before asking for approval.

## Playbook

1. Clarify the cost question: growth, largest objects, abandoned multipart uploads, old versions, egress, or lifecycle policy review.
2. Use `b2_list_buckets` to identify the target bucket and current lifecycle state. Keep the review scoped to named buckets and prefixes.
3. Use `b2_largest_files`, `b2_unfinished_uploads`, `b2_usage_growth`, and `b2_egress_leaders` to build a metadata-only picture of billable drivers.
4. Use `s3_list_objects_v2` and `s3_list_object_versions` for prefix-specific evidence. Sample deterministically and call out truncation when scans are bounded.
5. Recommend the least risky remediation first:
   - Add an incomplete multipart upload cancellation rule.
   - Narrow prefixes before expiring data.
   - Prefer noncurrent-version expiration only after restore and retention needs are clear.
   - Avoid broad current-version deletion unless the user has a separate deletion runbook.
6. Before any `s3_put_bucket_lifecycle` call, capture the current full lifecycle configuration as a rollback snapshot. Build the complete merged replacement configuration, not a partial rule patch, and review unchanged rules alongside the proposed new or edited rules.
7. For lifecycle changes, show the exact full rule set and affected scope before calling `s3_put_bucket_lifecycle` or `b2_update_bucket`.
8. After applying a rule, re-read bucket or lifecycle metadata and verify unchanged rules are still present. Summarize the expected future effect and do not claim immediate storage reduction until B2 lifecycle processing has run.
