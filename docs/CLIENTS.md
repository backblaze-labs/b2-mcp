# Connecting MCP clients to the B2 MCP server

This server speaks the Model Context Protocol over **two transports**:

- **stdio** — the server runs as a local subprocess of the client. Used by desktop apps and IDE extensions (Claude Desktop, Cursor, VS Code, Cline, Windsurf, Zed, Continue, Goose…).
- **Streamable HTTP** — the server runs as a hosted endpoint behind a URL (single `/mcp` endpoint; the MCP Streamable HTTP transport, spec 2025-03-26, which replaced the deprecated HTTP+SSE transport). Used by web clients (Claude.ai Custom Connectors) and any client pointed at a remote server. See [`DEPLOY.md`](DEPLOY.md) to stand one up.

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

## B. Hosted (Streamable HTTP)

For a server deployed per [`DEPLOY.md`](DEPLOY.md). The hosted endpoint is `https://<host>/mcp` (Streamable HTTP; SSE was the legacy transport, deprecated in MCP 2025-03-26). Credentials travel in request **headers** on the initialize request, not env vars.

### Claude Desktop → hosted server (`mcp-remote` bridge)

Claude Desktop only accepts stdio entries, so use the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge as a local shim:

```json
{
  "mcpServers": {
    "backblaze-b2": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.your-domain.example/mcp",
        "--header",
        "X-B2-Key-Id:your-key-id",
        "--header",
        "X-B2-Key:your-key-secret"
      ]
    }
  }
}
```

### Claude.ai web / Pro / Max (Custom Connectors)

These accept the URL + headers shape directly:

```json
{
  "url": "https://mcp.your-domain.example/mcp",
  "headers": {
    "X-B2-Key-Id": "your-key-id",
    "X-B2-Key": "your-key-secret"
  }
}
```

### Any Streamable-HTTP-capable client

Point it at `https://<host>/mcp` and send the `X-B2-Key-Id` / `X-B2-Key` headers. If your primary key is a **master** key, also send `X-B2-App-Key-Id` / `X-B2-App-Key` (a non-master key) — B2's S3 endpoint rejects master keys.

---

## Credentials & security

- **stdio:** the key goes in the `env` block of the client's config file, in **plaintext**. Protect that file and never commit it to a repo.
- **hosted:** the key travels in `X-B2-*` headers. Front the server with TLS and a caller-auth layer (see [`DEPLOY.md`](DEPLOY.md) — the HTTP transport authenticates the _B2 key_, not the _caller_).
- **Master-key caveat:** only the Partner API and account-level key management need a master key in Phase 1. If you use one, also supply a non-master key (`B2_APP_KEY_ID`/`B2_APP_KEY` for stdio, or `X-B2-App-Key-Id`/`X-B2-App-Key` for hosted) for the S3 tools.

See the [README](../README.md) for the full environment-variable list and the tool catalog.
