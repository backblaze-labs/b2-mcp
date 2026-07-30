# Connecting MCP clients to the B2 MCP server

This server speaks the Model Context Protocol over **two transports**:

- **stdio** — the server runs as a local subprocess of the client. Used by desktop apps and IDE extensions (Claude Desktop, Cursor, VS Code, Cline, Windsurf, Zed, Continue, Goose…).
- **HTTP** — the server runs as a hosted MCP 2026-07-28 endpoint behind a URL (single `/mcp` endpoint). Used by web clients (Claude.ai Custom Connectors) and any client pointed at a remote server. See [`DEPLOY.md`](DEPLOY.md) to stand one up.

> **The one thing that matters:** every stdio client runs the _same_ command —
> `node /ABSOLUTE/PATH/TO/b2-mcp/dist/index.js` with two env vars. Only the
> **config file location** and the **wrapper key name** differ per client. If a
> client's config format has changed since this was written, its own MCP docs are
> authoritative — the invocation below is what you're wiring up.

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

```bash
git clone https://github.com/backblaze-labs/b2-mcp.git b2-mcp
cd b2-mcp
npm install
npm run build      # produces dist/ — required for the stdio command below
```

You also need a Backblaze B2 **Application Key** (key ID + secret). A single non-master application key works for both the B2 native and S3-compatible APIs. Master keys are only needed for Partner API and account-level key management in the Phase 1 tool surface.

> The npm package name is planned for the Phase 1 release line but not yet
> advertised as an install command. Use the local `node dist/index.js` path shown
> below until the release gate verifies npm ownership and provenance.

---

## A. Local (stdio)

The universal invocation, wrapped differently per client:

```
command: node
args:    /ABSOLUTE/PATH/TO/b2-mcp/dist/index.js
env:     B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "backblaze-b2": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/b2-mcp/dist/index.js"],
      "env": {
        "B2_APPLICATION_KEY_ID": "your-key-id",
        "B2_APPLICATION_KEY": "your-key-secret"
      }
    }
  }
}
```

Restart Claude Desktop fully (Cmd/Ctrl+Q) and reopen.

### Cursor

`.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "backblaze-b2": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/b2-mcp/dist/index.js"],
      "env": {
        "B2_APPLICATION_KEY_ID": "your-key-id",
        "B2_APPLICATION_KEY": "your-key-secret"
      }
    }
  }
}
```

### VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` (note VS Code uses the `servers` key and a `type`):

```json
{
  "servers": {
    "backblaze-b2": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/b2-mcp/dist/index.js"],
      "env": {
        "B2_APPLICATION_KEY_ID": "your-key-id",
        "B2_APPLICATION_KEY": "your-key-secret"
      }
    }
  }
}
```

### Cline

Cline → **MCP Servers → Configure** (edits `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "backblaze-b2": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/b2-mcp/dist/index.js"],
      "env": {
        "B2_APPLICATION_KEY_ID": "your-key-id",
        "B2_APPLICATION_KEY": "your-key-secret"
      }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "backblaze-b2": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/b2-mcp/dist/index.js"],
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
        "path": "node",
        "args": ["/ABSOLUTE/PATH/TO/b2-mcp/dist/index.js"],
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
    command: node
    args:
      - /ABSOLUTE/PATH/TO/b2-mcp/dist/index.js
    env:
      B2_APPLICATION_KEY_ID: your-key-id
      B2_APPLICATION_KEY: your-key-secret
```

### Goose

```bash
goose configure
# → Add Extension → Command-line Extension
# Command:  node /ABSOLUTE/PATH/TO/b2-mcp/dist/index.js
# add env:  B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY
```

### Any other stdio client

Point it at `node /ABSOLUTE/PATH/TO/b2-mcp/dist/index.js` with the two env vars, under whatever key your client uses for MCP servers. Consult the client's MCP documentation for the exact file and key name.

---

## B. Hosted HTTP

For a server deployed per [`DEPLOY.md`](DEPLOY.md). The hosted endpoint is `https://<host>/mcp`. Unset `B2_HTTP_CREDENTIAL_MODE` defaults to `headers` for compatibility with existing hosted clients; set `server` or `principal` explicitly when the client should send no B2 key.

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

If the operator sets `B2_HTTP_CREDENTIAL_MODE=headers` or leaves it unset, send B2 credentials on every MCP request. Prefer the explicit header names:

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
- **hosted headers mode:** the key travels in `X-B2-MCP-*` headers on every request. Treat those headers as durable secrets in the proxy, logs, APM, and test fixtures.
- **Master-key caveat:** only the Partner API and account-level key management need a master key in Phase 1. If you use one, also supply a non-master key (`B2_APP_KEY_ID`/`B2_APP_KEY` for stdio, or `X-B2-MCP-App-Key-Id`/`X-B2-MCP-App-Key` in hosted headers mode) for the S3 tools.

See the [README](../README.md) for the full environment-variable list and the tool catalog.
