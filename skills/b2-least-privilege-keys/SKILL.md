---
name: b2-least-privilege-keys
description: Review B2 application keys, design least-privilege replacements, and retire risky keys without exposing durable secrets.
---

# B2 Least Privilege Keys

## When to use

- The user asks which B2 capabilities an application key should have.
- The user wants to audit existing keys for over-broad capability, scope, or duration.
- The user asks to rotate, retire, or delete a B2 application key safely.

## Byte path

- Object data MUST move directly between the client or workload runner and B2 using presigned URLs, multipart upload URLs, or an external B2/S3 client.
- MUST NOT route object data through the model or MCP server. Key review uses only key metadata, bucket metadata, capability names, expiration, and approved scope.
- Durable key secrets must never be printed, logged, stored in files, or pasted into chat. Create replacement keys in a trusted secret sink outside the model if the MCP server reports key creation as unavailable.

## Safety gates

- Pause and ask for explicit confirmation before deleting any key with `b2_delete_key`; deletion immediately breaks every workload using that key.
- Pause before recommending any key with key-management capabilities, unscoped write/delete capability, non-expiring duration, or bucket-public administration. Ask the user to confirm the workload and blast radius.
- Never ask the user to paste secret key material. If a secret appears in chat, tell the user to rotate it and continue without echoing it.

## Tools used

- `b2_list_buckets`
- `b2_list_keys`
- `b2_delete_key`

## Playbook

1. Identify the workload, bucket names, prefixes, operations, deployment environment, and required duration. Separate read, write, delete, lifecycle, notification, and key-management needs.
2. Use `b2_list_buckets` to resolve bucket names to bucket IDs, then use `b2_list_keys` to inventory existing key metadata. Do not request or reveal key secrets.
3. Classify each key as keep, rotate, narrow, expire, or retire. Prefer bucket-scoped keys, minimum capabilities, short duration for automation, and separate keys per workload or tenant.
4. For replacement design, provide a concrete capability list and bucket scope. If key creation is unavailable in this MCP surface, instruct the user to create it through a trusted Backblaze console, CLI, or secret manager workflow, then deploy the secret directly to the workload.
5. Before deleting a key, require explicit user confirmation of the key ID, workload owner, rollback plan, and last-used evidence if available. Then call `b2_delete_key` only with the confirmed target.
6. Close with a key posture summary: broad keys remaining, unscoped write/delete grants, non-expiring keys, keys ready for deletion, and owner follow-ups.
