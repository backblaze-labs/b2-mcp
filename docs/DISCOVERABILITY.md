# Discoverability runbook

How the official Backblaze B2 MCP server is listed across MCP registries and
directories, and how to keep those listings current on each release. Tracks the
work in [#297](https://github.com/backblaze-labs/b2-mcp/issues/297) /
[#300](https://github.com/backblaze-labs/b2-mcp/issues/300) /
[#301](https://github.com/backblaze-labs/b2-mcp/issues/301).

## Canonical identity (use everywhere)

| Field | Value |
| --- | --- |
| Repo | `https://github.com/backblaze-labs/b2-mcp` |
| Registry name | `io.github.backblaze-labs/b2-mcp` |
| npm | `@backblaze-labs/b2-mcp` |
| Container | `ghcr.io/backblaze-labs/b2-mcp` |
| Display name | **Backblaze B2 MCP Server** (never bare "B2 MCP") |
| Description | *Official Backblaze B2 MCP server for buckets, files, keys, Object Lock, and S3 storage.* |
| Anchor text for backlinks | `Backblaze B2 MCP server` |

Every submission must use the display name above and link the canonical repo, so
directories de-duplicate community forks under the official entry.

## Repo manifests (the source of truth for directories)

| File | Directory | Notes |
| --- | --- | --- |
| `server.json` | Official MCP Registry | Version synced by `scripts/update-server-json-version.mjs` at release cut. |
| `smithery.yaml` | Smithery | stdio one-click config; credential fields masked as `password`. |
| `glama.json` | Glama | `maintainers` list gates the org claim. Read from the default branch. |
| `lhm.plugin.json` | LobeHub | Owner declaration used by `lhm plugin update`; regenerate on release. |

The canonical registry description lives in
`scripts/lib/mcp-registry-manifest.mjs` (`mcpRegistryDescription`) and is
contract-checked against `server.json`; keep it ≤100 characters.

## The tool-scan credential trick

Directories that enumerate tools by launching the server (mcp.so, Glama build
tests, LobeHub `plugin init`) fail because startup requires B2 credentials.
Start it with placeholder credentials plus `B2_REGISTER_ALL_TOOLS=true`, which
skips the authorize call and registers all 40 tools without a real account:

```
B2_APPLICATION_KEY_ID=placeholder
B2_APPLICATION_KEY=placeholder
B2_REGISTER_ALL_TOOLS=true
B2_SECRET_SINK=off
```

Tool *calls* fail without real credentials, but `tools/list` succeeds — which is
all a scan needs. Do not force `B2_REGISTER_ALL_TOOLS` on real user deployments;
it bypasses capability-aware registration.

## Glama

1. **Claim:** `glama.json` (this repo) lists the maintainer; on the server's
   "Score" tab, click **Login with GitHub to claim** and authorize with the
   maintainer account. Then merge community forks into the official entry.
2. **Release** (containerized build → security scan → one-click deploy → A
   grade): on `https://glama.ai/mcp/servers/backblaze-labs/b2-mcp/admin/dockerfile`,
   point Glama at the repo `Dockerfile` (HTTP transport, port `3000`,
   `/health`), declare the env schema below, **Deploy** to run the build test,
   then **Make Release** with the version and a short changelog.

Env schema for the Glama deploy form:

| Name | Required | Secret | Placeholder |
| --- | --- | --- | --- |
| `B2_APPLICATION_KEY_ID` | yes | yes | `your-application-key-id` |
| `B2_APPLICATION_KEY` | yes | yes | `your-application-key-secret` |
| `B2_REGION` | no | no | `us-east-005` |
| `B2_MASTER_KEY_ID` | no | yes | (Partner tools only) |
| `B2_MASTER_KEY` | no | yes | (Partner tools only) |
| `B2_HTTP_CREDENTIAL_MODE` | yes | no | `server` |

`B2_HTTP_CREDENTIAL_MODE` **must** be `server` for this deployment. In the
default `headers` mode the HTTP transport ignores env-injected credentials and
requires B2 credential headers on every request, so Glama's credential-free tool
scan would receive `401` responses; `server` mode signs requests with the
env-supplied application key instead.

If Glama's build test cannot enumerate tools without credentials, add
`B2_REGISTER_ALL_TOOLS=true` (fixed value) for the build only.

## LobeHub

Uses the `@lobehub/market-cli` (`lhm`) CLI. `login` and `github connect` are
browser flows a human must complete; `plugin init` needs no auth.

```bash
# Read-only probes
npx -y @lobehub/market-cli auth status --output json
npx -y @lobehub/market-cli github status

# Human-in-the-loop (browser)
npx -y @lobehub/market-cli login
npx -y @lobehub/market-cli github connect

# Regenerate the manifest (no auth; placeholder creds so the server starts)
npx -y @lobehub/market-cli plugin init \
  --stdio "env B2_APPLICATION_KEY_ID=placeholder B2_APPLICATION_KEY=placeholder B2_REGISTER_ALL_TOOLS=true B2_SECRET_SINK=off node dist/index.js" \
  --dir "$(pwd)" --force
# then restore the official name/description/identifier in lhm.plugin.json

# Claim the auto-crawled listing, then push the manifest
npx -y @lobehub/market-cli plugin claim backblaze-labs-b2-mcp
npx -y @lobehub/market-cli plugin update --dir "$(pwd)"
npx -y @lobehub/market-cli plugin list --output json
```

Never read or print `~/.lobehub-market/` credential files.

## Directory checklist

Aggregators that ingest the Official MCP Registry pick the server up
automatically; the rest need a submission or claim. Full status lives in
[#300](https://github.com/backblaze-labs/b2-mcp/issues/300).

- Official MCP Registry — published (`server.json` + `publish.yml`).
- mcp.so — submitted (`mcp.so/servers/backblaze-b2-mcp-server`).
- Glama — claim + release (above).
- Smithery — submit repo (`smithery.yaml`).
- LobeHub — claim + `lhm plugin update` (above).
- PulseMCP — crawls the registry; verify, submit if absent.
- Cline MCP Marketplace, Docker MCP Catalog, mcp-get, MCP Market, OpenTools,
  Fleur — submit.
- Awesome-list PRs — `punkpeye/awesome-mcp-servers`, `wong2/awesome-mcp-servers`,
  `appcypher/awesome-mcp-servers`, `modelcontextprotocol/servers`.
- VS Code / Cursor / Windsurf — auto-ingest the registry; verify only.

## Authority backlinks (highest ranking lever, #301)

- A `backblaze.com` page linking the repo with anchor text
  `Backblaze B2 MCP server`.
- A featured card on backblazelabs.com with the display name and description.

## On every release

1. Bump + `scripts/update-server-json-version.mjs` (syncs `server.json`).
2. Regenerate `lhm.plugin.json` and `lhm plugin update`.
3. Cut a new Glama release (rerun the Dockerfile deploy → Make Release).
4. Confirm the registry badge shows the new version.
