# Connecting MCP clients to the B2 MCP server

This server speaks the Model Context Protocol over **two transports**:

- **stdio** — the server runs as a local subprocess of the client. Used by desktop apps and IDE extensions (Claude Desktop, Cursor, VS Code, Cline, Windsurf, Zed, Continue, Goose…).
- **HTTP** — the server runs as a hosted MCP 2026-07-28 endpoint behind a URL (single `/mcp` endpoint). Used by web clients (Claude.ai Custom Connectors) and any client pointed at a remote server. See [`../DEPLOY.md`](../DEPLOY.md) to stand one up.

> **The one thing that matters:** every stdio client runs the same command,
> `npx -y @backblaze-labs/b2-mcp`, which downloads and runs the published
> package with no build step. Only the **config file location** and the
> **wrapper key name** differ per client. (For a source checkout you can point
> at `node /ABSOLUTE/PATH/TO/b2-mcp/dist/index.js` or the installed `b2-mcp`
> binary instead; see [From source](#from-source-optional).) If a client's
> config format has changed since this was written, its own MCP docs are
> authoritative; the invocation below is what you're wiring up.

## Compatibility at a glance

| Client                    | Local (stdio) |  Hosted (Streamable HTTP)  | Config location                                   |
| ------------------------- | :-----------: | :------------------------: | ------------------------------------------------- |
| Claude Desktop            |      ✅       | ✅ via `mcp-remote` bridge | `claude_desktop_config.json`                      |
| Claude.ai web / Pro / Max |       —       |      ✅ URL + headers      | Custom Connectors UI                              |
| Cursor                    |      ✅       |             ✅             | `.cursor/mcp.json`                                |
| VS Code (Copilot)         |      ✅       |             ✅             | `.vscode/mcp.json`                                |
| Cline                     |      ✅       |             ✅             | `cline_mcp_settings.json`                         |
| Windsurf                  |      ✅       |             ✅             | `~/.codeium/windsurf/mcp_config.json`             |
| Zed                       |      ✅       |             —              | `settings.json` (`context_servers`)               |
| Continue                  |      ✅       |             ✅             | `~/.continue/config.yaml`                         |
| Goose                     |      ✅       |             ✅             | `goose configure` / `~/.config/goose/config.yaml` |
| Any other MCP client      |      ✅       |             ✅             | per client                                        |

## Prerequisites

You need a Backblaze B2 **Application Key** (key ID + secret). A single non-master application key works for both the B2 native and S3-compatible APIs. Master keys are only needed for the Partner API in the Phase 1 tool surface.

Everything else is handled by `npx`, which downloads and runs the published `@backblaze-labs/b2-mcp` package on demand (a recent Node.js with `npx` is the only tooling required). This is the recommended setup path for every stdio client below. The canonical npm package binary is `b2-mcp`; `b2-mcp-server` remains a transition alias for existing stdio configurations.

### From source (optional)

`npx` needs no local build. Only contributors, and offline or version-pinned installs, need a source checkout. Clone, install, and build once, then point your client at `node /ABSOLUTE/PATH/TO/b2-mcp/dist/index.js` (or the installed `b2-mcp` binary) as shown in each block below:

```bash
git clone https://github.com/backblaze-labs/b2-mcp.git b2-mcp
cd b2-mcp
corepack enable pnpm
corepack prepare 'pnpm@11.20.0+sha256.34e198cb1e43237517ecedfd31f9ae26a6c0a3e5366ce58a2d05f4b21fb5f19a' --activate
pnpm install --frozen-lockfile
pnpm run build      # produces dist/ -- required for the source stdio command
```

---

## A. Local (stdio)

The universal invocation, wrapped differently per client:

```
command: npx
args:    -y @backblaze-labs/b2-mcp
env:     B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY
```

Source-checkout equivalents (see [From source](#from-source-optional)):

```
command: node                                     # or: b2-mcp
args:    /ABSOLUTE/PATH/TO/b2-mcp/dist/index.js    #     --transport stdio
env:     B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY
```

Optional local log file:

```
env:     B2_LOG_FILE=/absolute/path/to/b2-mcp.log
```

`B2_LOG_FILE` appends redacted structured JSON logs to that file instead of
stderr. This is useful for stdio clients that hide child-process stderr. The
path must be absolute. The file is created with owner-only permissions if it
does not exist; the parent directory must already exist and be writable. Use
operator-managed rename/create rotation for long-running local processes, then
send `SIGHUP` to the b2-mcp process so it reopens the active file.
Logs are never written to stdout. `B2_LOG_FILE` is POSIX-only for now; on
Windows it fails at startup because owner-only ACLs are not enforced by this
implementation.

### Claude Desktop, Cursor, Cline, Windsurf (`mcpServers` shape)

These clients share the same `mcpServers` block. Paste it into the client's config file, then set the two env values:

```json
{
  "mcpServers": {
    "backblaze-b2": {
      "command": "npx",
      "args": ["-y", "@backblaze-labs/b2-mcp"],
      "env": {
        "B2_APPLICATION_KEY_ID": "your-key-id",
        "B2_APPLICATION_KEY": "your-key-secret"
      }
    }
  }
}
```

Config file per client:

- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows) / `~/.config/Claude/claude_desktop_config.json` (Linux). Restart fully (Cmd/Ctrl+Q) and reopen after editing.
- **Cursor**: `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` globally).
- **Cline**: MCP Servers → Configure (edits `cline_mcp_settings.json`).
- **Windsurf**: `~/.codeium/windsurf/mcp_config.json`.

### VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` (note VS Code uses the `servers` key and a `type`):

```json
{
  "servers": {
    "backblaze-b2": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@backblaze-labs/b2-mcp"],
      "env": {
        "B2_APPLICATION_KEY_ID": "your-key-id",
        "B2_APPLICATION_KEY": "your-key-secret"
      }
    }
  }
}
```

### Zed

`settings.json` (Zed uses `context_servers`):

```json
{
  "context_servers": {
    "backblaze-b2": {
      "command": {
        "path": "npx",
        "args": ["-y", "@backblaze-labs/b2-mcp"],
        "env": {
          "B2_APPLICATION_KEY_ID": "your-key-id",
          "B2_APPLICATION_KEY": "your-key-secret"
        }
      }
    }
  }
}
```

### Continue

`~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: backblaze-b2
    command: npx
    args: ["-y", "@backblaze-labs/b2-mcp"]
    env:
      B2_APPLICATION_KEY_ID: your-key-id
      B2_APPLICATION_KEY: your-key-secret
```

### Goose

```bash
goose configure
# → Add Extension → Command-line Extension
# Command:  npx -y @backblaze-labs/b2-mcp
# add env:  B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY
```

### Any other stdio client

Point it at `npx -y @backblaze-labs/b2-mcp` with the two env vars, under whatever key your client uses for MCP servers. Consult the client's MCP documentation for the exact file and key name.

For a source checkout, swap the command for `node /ABSOLUTE/PATH/TO/b2-mcp/dist/index.js` (or the installed `b2-mcp` binary) in any block above; see [From source](#from-source-optional).

---

## B. Hosted HTTP

For a server deployed per [`../DEPLOY.md`](../DEPLOY.md). The hosted endpoint is `https://<host>/mcp`. Unset `B2_HTTP_CREDENTIAL_MODE` defaults to `headers` for compatibility with existing hosted clients; set `server` or `principal` explicitly when the client should send no B2 key.

### Claude Desktop → hosted server (`mcp-remote` bridge)

Claude Desktop only accepts stdio entries, so use the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge as a local shim:

```json
{
  "mcpServers": {
    "backblaze-b2": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.your-domain.example/mcp"]
    }
  }
}
```

### Claude.ai web / Pro / Max (Custom Connectors)

These accept the URL + headers shape directly:

```json
{
  "url": "https://mcp.your-domain.example/mcp"
}
```

### Any HTTP-capable MCP client

Point it at `https://<host>/mcp`. In `server` mode, do not send B2 credential headers. In `principal` mode, your OAuth/resource-server layer must validate the caller and attach verified MCP `authInfo` before the handler runs.

### Header compatibility mode

If the operator sets `B2_HTTP_CREDENTIAL_MODE=headers` or leaves it unset, send
B2 credentials on every MCP request that executes tools. Credential-free
discovery requests can initialize, list tools/resources/prompts, and ping
without B2 headers so inspectors and directory scanners can enumerate the
server; `tools/call` remains credential-gated and returns `missing_credentials`
until valid B2 headers are present. Prefer the explicit header names:

```json
{
  "url": "https://mcp.your-domain.example/mcp",
  "headers": {
    "X-B2-MCP-Key-Id": "your-key-id",
    "X-B2-MCP-Key": "your-key-secret"
  }
}
```

If Partner API tools require a distinct master key, also send `X-B2-MCP-Master-Key-Id` / `X-B2-MCP-Master-Key`.

---

## Credentials & security

- **stdio:** the key goes in the `env` block of the client's config file, in **plaintext**. Protect that file and never commit it to a repo.
- **hosted server/principal modes:** the client sends no B2 key. Front the server with TLS and, for principal mode, an MCP OAuth resource-server validation layer that supplies verified `authInfo`.
- **hosted headers mode:** the key travels in `X-B2-MCP-*` headers on every
  tool-execution request. Discovery requests may omit it. Treat those headers as
  durable secrets in the proxy, logs, APM, and test fixtures.
- **Master-key caveat:** only the Partner API needs a master key in Phase 1. S3 tools use the same authorized application key that controls tool registration, so use a non-master `B2_APPLICATION_KEY_*` credential for object and presign tools.

See the [README](../../README.md) for the full environment-variable list and the tool catalog.
