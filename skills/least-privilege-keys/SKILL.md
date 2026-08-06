---
name: least-privilege-keys
description: Audit and rotate scoped B2 application keys without exposing durable secrets through MCP.
---

# B2 Least Privilege Keys

## When To Use

- Trigger: The user asks what B2 capabilities an automation, backup job, migration job, or MCP deployment should have.
- Trigger: The user asks to rotate, retire, or audit application keys.
- Trigger: The user asks for a safer key plan before enabling mutating or destructive B2 tools.

## Tools Referenced

- `b2_authorize_account`
- `b2_list_buckets`
- `b2_list_keys`
- `b2_delete_key`
- `s3_head_bucket`

## Byte Path

Never route object bytes through the model. Never route object bytes through the MCP server. No object bytes are involved in this workflow; only account, bucket, key ID, and capability metadata should be handled.

Never ask the user to paste an application key secret into chat. Key creation and secret capture must happen outside MCP, such as in the Backblaze console, the B2 CLI, or a customer secret manager. The MCP flow may verify non-secret key scope after the user installs the key in their client or server environment.

## Safety Gates

Pause for explicit user confirmation before any key revocation or account-impacting change. The server also enforces `B2_DESTRUCTIVE_POLICY`; when required, repeat the identical tool call only after the user approves `confirm: true`.

- `b2_delete_key`: confirm the application key ID, owner, consuming service, rollback plan, and replacement key status before using `confirm: true`.

Do not use durable-secret-producing compatibility stubs to create keys. Until an out-of-band secret sink exists, create and capture new key secrets outside MCP.

## Playbook

1. Identify the workload and target resources: bucket names, prefixes, read/write/delete needs, lifecycle needs, Object Lock needs, and expected transport.
2. Use `b2_authorize_account` to verify the active key. Use `b2_list_buckets` and `s3_head_bucket` to confirm the key can reach only the intended buckets.
3. Use `b2_list_keys` to inventory current application keys. Record only non-secret fields: key ID, name, capabilities, bucket restriction, name prefix, and expiration.
4. Recommend the smallest practical capability set:
   - Read-only audit: list and read capabilities only.
   - Backup writer: list buckets, list files, read files if verification needs downloads, and write files.
   - Restore reader: list files and read files.
   - Cleanup job: delete files only when an explicit lifecycle or cleanup runbook exists.
   - Bucket admin: write bucket settings only for controlled lifecycle, Object Lock, or notification changes.
5. Have the user create the replacement key outside MCP and install it in the MCP client or hosted server environment. Do not echo or persist the secret value.
6. Re-run scope checks with the replacement key. Confirm that the old key is idle or has a rollback path.
7. If retiring the old key, use `b2_delete_key` only after explicit confirmation and only with `confirm: true` when the server asks for it.
