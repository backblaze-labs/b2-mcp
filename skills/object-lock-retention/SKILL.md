---
name: object-lock-retention
description: Configure and review B2 Object Lock retention and legal holds without weakening protection accidentally.
---

# B2 Object Lock And Retention

## When To Use

- Trigger: The user asks to enable Object Lock, default retention, governance retention, compliance retention, or legal hold on B2 data.
- Trigger: The user asks why a file cannot be deleted or overwritten because of retention or legal hold.
- Trigger: The user asks to shorten retention, clear retention, bypass governance, or turn legal hold off.

## Tools Referenced

- `b2_list_buckets`
- `b2_create_bucket`
- `b2_update_bucket`
- `b2_update_file_retention`
- `b2_update_file_legal_hold`
- `s3_head_object`
- `s3_list_object_versions`

## Byte Path

Never route object bytes through the model. Never route object bytes through the MCP server. No object bytes are involved in this workflow; use metadata and version IDs only.

Use `s3_head_object` and `s3_list_object_versions` to identify the exact object version before changing retention or legal hold. Do not fetch file contents to decide a retention policy.

## Safety Gates

Pause for explicit user confirmation before any operation that weakens immutability, makes a protected file deletable, or changes bucket-level protection. The server also enforces `B2_DESTRUCTIVE_POLICY`; when required, repeat the identical tool call only after the user approves `confirm: true`.

- `b2_update_bucket`: use `confirm: true` only when the change makes a bucket public, disables Object Lock, clears default retention, schedules lifecycle deletion, or changes replication.
- `b2_update_file_retention`: use `confirm: true` when clearing retention or using governance bypass. Confirm the file ID, file name, current retention, target retention, and legal basis.
- `b2_update_file_legal_hold`: use `confirm: true` when setting legal hold to `off`. Confirm the file ID, file name, and approval source.

Prefer extending protection over weakening it. Compliance-mode retention cannot be shortened through normal recovery workflows; tell the user when the requested outcome is not possible.

## Playbook

1. Identify the compliance intent: protected bucket or object, default retention period, governance versus compliance mode, legal hold need, and authorized approver.
2. Use `b2_list_buckets` to verify whether Object Lock is already enabled. If a new bucket is needed, create it with Object Lock enabled from the start.
3. For existing buckets, use `b2_update_bucket` to enable Object Lock or set default retention. Avoid unrelated bucket setting changes in the same call.
4. For per-object protection, identify the exact version with `s3_head_object` or `s3_list_object_versions`.
5. Use `b2_update_file_retention` to set or extend retention. Use `b2_update_file_legal_hold` to turn legal hold on when the hold is tied to an investigation or legal process.
6. For any requested weakening action, stop and summarize the irreversible effect, target version, current protection, requested change, and required `confirm: true` gate.
7. After the change, re-check metadata and report only non-secret identifiers and policy values.
