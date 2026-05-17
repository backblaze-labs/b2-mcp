# Backblaze B2 MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [Backblaze B2 Cloud Storage](https://www.backblaze.com/cloud-storage). Exposes the full B2 native API v2 and S3-compatible API as MCP tools, allowing any MCP-compatible AI model (Claude, GPT-4o, Gemini, etc.) to manage B2 storage through natural language.

## Features

- **Full B2 native API coverage** — buckets, files, large-file multipart, download URLs, application keys, notification rules
- **Full S3-compatible API coverage** — objects, versioning, CORS, lifecycle, ACL, presigned URLs, multipart uploads
- **Automatic large file handling** — files above the threshold are automatically uploaded via multipart
- **Auth token caching** — minimize authorize_account calls with automatic token refresh
- **Retry logic** — exponential backoff on rate limits and transient errors
- **Dual transport** — stdio for local use (Claude Desktop, Cursor) or HTTP+SSE for hosted deployments

## Quick Start

### Prerequisites

- Node.js 18+ — download from [nodejs.org](https://nodejs.org) (LTS version recommended)
- A Backblaze B2 account with an [Application Key](https://www.backblaze.com/docs/cloud-storage-application-keys)

### 1. Install and build

```bash
# Unzip the project folder, then:
cd b2-mcp-server
npm install
npm run build
```

> **Note:** The `dist/` folder is excluded from the zip — you must run `npm run build` once before connecting Claude.

### 2. Connect Claude Desktop

Open (or create) `~/Library/Application Support/Claude/claude_desktop_config.json` and add:

```json
{
  "mcpServers": {
    "backblaze-b2": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/b2-mcp-server/dist/index.js"],
      "env": {
        "B2_APPLICATION_KEY_ID": "your-master-key-id",
        "B2_APPLICATION_KEY":    "your-master-key-secret",
        "B2_APP_KEY_ID":         "your-non-master-key-id",
        "B2_APP_KEY":            "your-non-master-key-secret"
      }
    }
  }
}
```

Replace `/ABSOLUTE/PATH/TO/b2-mcp-server` with the actual path where you cloned or unzipped the folder, e.g. `/Users/yourname/Downloads/b2-mcp-server`.

Restart Claude Desktop — you should see the B2 tools available in Claude.

> **Two key types:** Backblaze requires different keys for different APIs.
> - `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` — your **master key** (used for B2 native API and Partner API)
> - `B2_APP_KEY_ID` / `B2_APP_KEY` — a **non-master application key** (required for S3-compatible endpoints; master keys are rejected by the S3 API)
>
> If you only have a master key, omit `B2_APP_KEY_ID` / `B2_APP_KEY` — S3 tools will be skipped automatically.

### Cursor / VS Code

Add to `.cursor/mcp.json` in your project root:

```json
{
  "servers": {
    "backblaze-b2": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/b2-mcp-server/dist/index.js"],
      "env": {
        "B2_APPLICATION_KEY_ID": "your-master-key-id",
        "B2_APPLICATION_KEY": "your-master-key-secret"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `B2_APPLICATION_KEY_ID` | ✅ | — | Master key ID (B2 native + Partner API) |
| `B2_APPLICATION_KEY` | ✅ | — | Master key secret |
| `B2_APP_KEY_ID` | — | falls back to master key | Non-master application key ID for S3-compatible API |
| `B2_APP_KEY` | — | falls back to master key | Non-master application key secret for S3-compatible API |
| `B2_REGION` | — | `us-west-004` | B2 region for S3-compatible endpoint |
| `B2_LARGE_FILE_THRESHOLD` | — | `104857600` (100MB) | File size above which multipart upload is used |
| `B2_PART_SIZE` | — | `104857600` (100MB) | Size of each multipart upload part |

## Available Tools

### B2 Native API

| Tool | Description |
|---|---|
| `b2_authorize_account` | Verify credentials and return account info |
| `b2_list_buckets` | List buckets with optional filters |
| `b2_create_bucket` | Create a new bucket |
| `b2_delete_bucket` | Delete an empty bucket |
| `b2_update_bucket` | Update bucket settings, CORS, lifecycle |
| `b2_get_bucket_notification_rules` | Get webhook notification rules |
| `b2_set_bucket_notification_rules` | Set webhook notification rules |
| `b2_list_file_names` | List files with prefix/delimiter support |
| `b2_list_file_versions` | List all file versions |
| `b2_get_file_info` | Get file metadata |
| `b2_upload_file` | Upload a file (auto-multipart for large files) |
| `b2_download_file_by_name` | Download by bucket + file name |
| `b2_download_file_by_id` | Download by file ID |
| `b2_delete_file_version` | Delete a file version |
| `b2_hide_file` | Hide a file (versioning) |
| `b2_copy_file` | Copy a file within B2 |
| `b2_start_large_file` | Start a large file upload session |
| `b2_get_upload_part_url` | Get URL for a part upload |
| `b2_upload_part` | Upload a single part |
| `b2_finish_large_file` | Finalize a large file upload |
| `b2_cancel_large_file` | Cancel a large file upload |
| `b2_list_parts` | List uploaded parts |
| `b2_list_unfinished_large_files` | List incomplete large file uploads |
| `b2_copy_part` | Server-side copy of a part |
| `b2_get_download_authorization` | Generate download auth token |
| `b2_get_download_url_for_file` | Construct download URL by name |
| `b2_get_download_url_for_file_id` | Construct download URL by ID |
| `b2_create_key` | Create an application key |
| `b2_list_keys` | List application keys |
| `b2_delete_key` | Delete an application key |
| `b2_update_file_legal_hold` | Set or clear legal hold on a file |
| `b2_update_file_retention` | Set or clear file retention policy |

### Partner API (requires master key)

| Tool | Description |
|---|---|
| `b2_list_groups` | List partner groups |
| `b2_create_group_member` | Add an account to a partner group |
| `b2_eject_group_member` | Remove an account from a partner group |
| `b2_list_group_members` | List members of a partner group |
| `b2_reserve_trial_create_account` | Create a trial account reservation |
| `bz_list_computers` | List computers registered for Backblaze backup |
| `bz_delete_computer` | Delete a computer from Backblaze backup |

### S3-Compatible API

| Tool | Description |
|---|---|
| `s3_list_buckets` | List buckets |
| `s3_create_bucket` | Create a bucket |
| `s3_delete_bucket` | Delete a bucket |
| `s3_head_bucket` | Check bucket existence |
| `s3_get_bucket_versioning` | Get versioning state |
| `s3_put_bucket_versioning` | Enable/suspend versioning |
| `s3_get_bucket_cors` | Get CORS config |
| `s3_put_bucket_cors` | Set CORS config |
| `s3_delete_bucket_cors` | Remove CORS config |
| `s3_get_bucket_lifecycle` | Get lifecycle rules |
| `s3_put_bucket_lifecycle` | Set lifecycle rules |
| `s3_get_bucket_acl` | Get bucket ACL |
| `s3_put_bucket_acl` | Set bucket ACL |
| `s3_put_object` | Upload an object |
| `s3_get_object` | Download an object |
| `s3_delete_object` | Delete an object |
| `s3_delete_objects` | Batch delete objects |
| `s3_head_object` | Get object metadata |
| `s3_copy_object` | Copy an object |
| `s3_list_objects_v2` | List objects (V2) |
| `s3_list_object_versions` | List object versions |
| `s3_get_object_acl` | Get object ACL |
| `s3_put_object_acl` | Set object ACL |
| `s3_create_multipart_upload` | Start multipart upload |
| `s3_upload_part` | Upload a part |
| `s3_complete_multipart_upload` | Finalize multipart upload |
| `s3_abort_multipart_upload` | Abort multipart upload |
| `s3_list_multipart_uploads` | List in-progress uploads |
| `s3_list_parts` | List uploaded parts |
| `s3_get_presigned_url` | Generate presigned URL |
| `s3_get_presigned_post` | Generate presigned POST |

## Example Usage with Claude

Once connected, you can ask Claude things like:

> "List all my B2 buckets"

> "Upload the file at /Users/me/data.csv to my 'reports' bucket as 'monthly/may-2026.csv'"

> "Generate a download URL for 'backups/latest.tar.gz' that's valid for 24 hours"

> "Create a new application key that can only read files from the 'public-assets' bucket"

> "List all files in my bucket that start with 'logs/2026/'"

> "Delete all file versions for 'old-backup.tar.gz' from the 'backups' bucket"

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally (stdio)
B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy npm start

# Run as HTTP server
B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy npm run start:http -- --port 3000

# Test with MCP Inspector
npx @modelcontextprotocol/inspector npx @backblaze/b2-mcp-server

# Run unit tests
npm test

# Run integration tests (requires real B2 credentials)
B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy npm run test:integration
```

## Security Recommendations

- **Use scoped application keys** — create a key with only the capabilities needed for your workflow
- **Scope to a single bucket** when possible using the `bucketId` parameter in `b2_create_key`
- **In hosted mode**, add HTTP-layer authentication in front of the server — it has no built-in auth
- **Never commit credentials** — always use environment variables or a secrets manager

## License

MIT — Copyright © 2026 Backblaze, Inc.
