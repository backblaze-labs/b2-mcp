---
name: incident-response
description: Triage B2 security or operations incidents with read-first evidence collection and gated containment actions.
---

# B2 Incident Response

## When To Use

- Trigger: The user suspects credential exposure, unexpected public access, object deletion, bucket policy drift, abnormal egress, or storage growth.
- Trigger: The user asks to contain a B2 incident while preserving evidence.
- Trigger: The user asks for a step-by-step response plan that avoids accidental data loss during cleanup.

## Tools Referenced

- `b2_authorize_account`
- `b2_list_buckets`
- `b2_list_keys`
- `b2_delete_key`
- `b2_get_bucket_notification_rules`
- `b2_set_bucket_notification_rules`
- `b2_update_bucket`
- `b2_update_file_retention`
- `b2_update_file_legal_hold`
- `b2_usage_growth`
- `b2_egress_leaders`
- `b2_largest_files`
- `b2_unfinished_uploads`
- `s3_list_objects_v2`
- `s3_list_object_versions`
- `s3_head_object`
- `s3_delete_object`
- `s3_delete_objects`

## Byte Path

Never route object bytes through the model. Never route object bytes through the MCP server. No object bytes are involved in normal triage; use metadata, policy state, usage reports, object listings, and version IDs.

Do not download suspicious payloads through MCP. If evidence collection requires bytes, have the user use an isolated forensic client and direct B2 download path outside the model context.

## Safety Gates

Pause for explicit user confirmation before containment actions that delete data, revoke access, alter webhook delivery, or weaken or change retention. The server also enforces `B2_DESTRUCTIVE_POLICY`; when required, repeat the identical tool call only after the user approves `confirm: true`.

- `b2_delete_key`: confirm the compromised key ID, replacement access, affected services, and rollback limitations before using `confirm: true`.
- `b2_set_bucket_notification_rules`: confirm all replacement webhook rules, because the call replaces persistent notification state before using `confirm: true`.
- `b2_update_bucket`: confirm public/private changes, Object Lock changes, lifecycle deletion, default retention, and replication changes before using `confirm: true`.
- `b2_update_file_retention`: confirm the exact file version and legal basis before clearing retention or bypassing governance with `confirm: true`.
- `b2_update_file_legal_hold`: confirm the exact file version and approval source before turning legal hold off with `confirm: true`.
- `s3_delete_object`: confirm bucket, key, version ID if any, evidence status, and retention state before using `confirm: true`.
- `s3_delete_objects`: confirm the full object list, version scope, evidence status, and recovery plan before using `confirm: true`.

Prefer reversible containment first: rotate credentials outside MCP, make buckets private when appropriate, add or extend holds, and preserve versions before any deletion.

## Playbook

1. Stabilize: tell the user not to paste secrets into chat. If a secret was exposed, recommend rotating it outside MCP and treating the old key as compromised.
2. Scope access with `b2_authorize_account`, `b2_list_keys`, and `b2_list_buckets`. Record non-secret identifiers, capabilities, bucket type, lifecycle state, and Object Lock state.
3. Collect read-only evidence first:
   - Use `b2_usage_growth` and `b2_egress_leaders` for account or bucket anomalies.
   - Use `b2_largest_files` and `b2_unfinished_uploads` for storage spikes.
   - Use `s3_list_objects_v2`, `s3_list_object_versions`, and `s3_head_object` for targeted object metadata.
   - Use `b2_get_bucket_notification_rules` to capture current webhook configuration.
4. Propose containment in order of reversibility:
   - Rotate or revoke compromised keys.
   - Make unexpectedly public buckets private.
   - Add legal hold or retention to evidence objects.
   - Replace notification rules only after preserving the prior rule set.
5. Use destructive gates only after the user approves the exact target and outcome. Do not bulk-delete until recovery, evidence, and retention implications are resolved.
6. After containment, re-run the read-only checks and summarize: confirmed exposure, actions taken, remaining risk, external systems to rotate, and follow-up monitoring.
