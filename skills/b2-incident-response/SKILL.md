---
name: b2-incident-response
description: Triage suspected B2 exposure, credential misuse, accidental deletion, or ransomware events with containment-first actions.
---

# B2 Incident Response

## When to use

- The user suspects leaked B2 credentials, unauthorized bucket access, public exposure, ransomware, accidental deletion, or unexpected egress.
- The user asks to contain a B2 incident before doing cleanup or restore work.
- The user needs an evidence-preserving incident checklist using the MCP tool surface.

## Byte path

- Object data MUST move directly between the client or workload runner and B2 using presigned URLs, multipart upload URLs, or an external B2/S3 client.
- MUST NOT route object data through the model or MCP server. Incident work uses metadata, key inventory, bucket policy state, version listings, retention state, and aggregate report data.
- Do not print sensitive object contents, key secrets, presigned URLs, access tokens, or customer data into chat. Preserve evidence with metadata summaries and external logs.

## Safety gates

- Pause and ask for explicit confirmation before deleting or disabling access with `b2_delete_key`; confirm the impacted workload and fallback credential.
- Pause and ask for explicit confirmation before using `b2_update_bucket`; confirm whether the action changes public access, Object Lock, lifecycle, replication, or notification behavior.
- Pause and ask for explicit confirmation before using `b2_update_file_retention` or `b2_update_file_legal_hold`; containment should not accidentally weaken immutability.
- Pause and ask for explicit confirmation before using `s3_delete_object`, `s3_delete_objects`, or write-capable `s3_get_presigned_url`. Preserve evidence before cleanup.

## Tools used

- `b2_list_buckets`
- `b2_list_keys`
- `b2_delete_key`
- `b2_update_bucket`
- `b2_update_file_retention`
- `b2_update_file_legal_hold`
- `b2_get_bucket_notification_rules`
- `b2_egress_leaders`
- `b2_usage_growth`
- `s3_list_objects_v2`
- `s3_list_object_versions`
- `s3_head_object`
- `s3_get_presigned_url`
- `s3_delete_object`
- `s3_delete_objects`

## Playbook

1. Start with containment scope: suspected credential, bucket, prefix, time window, affected application, and whether production access must remain available.
2. Inventory buckets and keys with bounded complete-enough evidence. Call `b2_list_buckets` with `limit: 1000`, filter by bucket name/type when the account may exceed that cap, and treat any `truncated` response or unreviewed `total_bucket_count` remainder as incomplete evidence. Page `b2_list_keys` with `maxKeyCount: 100`, persist `nextApplicationKeyId` cursors in the incident record, continue until no cursor remains or the approved investigation bound is reached, and treat any remaining cursor as incomplete evidence. Identify public buckets, broad keys, non-expiring keys, and keys with write/delete capability only from the reviewed inventory.
3. Inspect evidence without reading object bodies: use `b2_egress_leaders`, `b2_usage_growth`, `s3_list_objects_v2`, `s3_list_object_versions`, `s3_head_object`, and notification rules from `b2_get_bucket_notification_rules`. Use listing pages of at most 1,000 keys or versions, persist continuation tokens in the incident record, and show at most 50 sampled rows in chat.
4. Prioritize non-destructive containment: remove leaked credentials from workloads, rotate outside the model into a trusted secret sink, tighten application config, and preserve logs.
5. For emergency key deletion, require confirmation of key ID, owner, blast radius, replacement credential, and rollback. Then use `b2_delete_key`.
6. For bucket changes, require confirmation of exact target, current state, intended new state, and evidence impact before `b2_update_bucket`. For per-file Object Lock changes, first obtain current retention and legal-hold state through an external trusted B2 metadata lookup because `s3_head_object` does not expose those fields; do not call `b2_update_file_retention` or `b2_update_file_legal_hold` until that evidence is recorded and the user confirms the exact target, current state, intended new state, and evidence impact.
7. Defer cleanup deletes until after evidence capture and restore planning. Use `s3_delete_object` or `s3_delete_objects` only after a separate destructive confirmation, with `s3_delete_objects` batches of 1,000 objects or fewer and a checkpointed target manifest.
8. Close with an incident record: timeline, suspected entry point, affected buckets and prefixes, containment completed, destructive actions taken or skipped, restore path, and follow-up hardening.
