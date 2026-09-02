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
| `mcpb/manifest.json` | Smithery (Local/MCPB) | MCPB 0.3 manifest; packed to a `.mcpb` bundle (`pnpm run build:mcpb`) and uploaded via Smithery's Local publish tab. |

The canonical registry description lives in
`scripts/lib/mcp-registry-manifest.mjs` (`mcpRegistryDescription`) and is
contract-checked against `server.json`; keep it ≤100 characters.

## Credential-less tool scans

Directories that enumerate tools by launching stdio or HTTP transports (mcp.so,
Glama build tests, LobeHub `plugin init`, MCP Inspector) need `initialize` and
`tools/list` to work before a user supplies real B2 credentials. This is the
default: no credentials, or placeholder credentials that B2 rejects, enter
credential-free discovery mode.

Discovery mode advertises the full 40-tool surface, including the real
durable-secret schemas for `b2_create_key`, `b2_create_group_member`, and
`b2_reserve_trial_create_account`. Every `tools/call` returns a structured
`missing_credentials` error until the caller supplies valid B2 credentials.

Do not force `B2_REGISTER_ALL_TOOLS` for scanner compatibility. It remains an
operator/test escape hatch that bypasses capability-aware registration for real
credentialed deployments.

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

`B2_HTTP_CREDENTIAL_MODE=server` is still the right one-click deployment shape:
real user tool calls use the env-supplied application key. Glama's build-time
scanner can initialize and run `tools/list` even when those env values are absent
or placeholders, but actual `tools/call` requests stay credential-gated.

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

# Regenerate the manifest (no auth; discovery mode handles missing credentials)
npx -y @lobehub/market-cli plugin init \
  --stdio "node dist/index.js" \
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
- MCP Market — live, auto-crawled from the registry (`mcpmarket.com/server/backblaze-b2`).
- Glama — claim + release (above).
- Smithery — submit repo (`smithery.yaml` / MCPB bundle).
- LobeHub — claim + `lhm plugin update` (above).
- PulseMCP — crawls the registry; verify, submit if absent.
- Cline MCP Marketplace, Docker MCP Catalog, OpenTools, Fleur — submit.
  (`mcp-get` is retired — its repository is archived and unmaintained.)
- Awesome-list PRs — only `punkpeye/awesome-mcp-servers` is a viable target
  (PR [#13422](https://github.com/punkpeye/awesome-mcp-servers/pull/13422)). The
  others were dropped: `wong2/awesome-mcp-servers` disabled pull requests and is
  auto-generated from the mcp.so database (so mcp.so coverage flows through),
  `appcypher/awesome-mcp-servers` is archived (read-only) with PRs disabled, and
  `modelcontextprotocol/servers` no longer keeps a third-party server list.
- VS Code / Cursor / Windsurf — auto-ingest the registry; verify only.

## Authority backlinks (highest ranking lever, #301)

- A `backblaze.com` page linking the repo with anchor text
  `Backblaze B2 MCP server`.
- A featured card on backblazelabs.com with the display name and description.

## Smithery (MCPB bundle)

Smithery's publish flow at [smithery.ai/new](https://smithery.ai/new) has two
tabs. The **URL** tab is for a remote server you host at a public HTTPS endpoint
(Streamable HTTP + OAuth) — not us, since b2-mcp runs locally per user with the
user's own B2 keys. Use the **Local (MCPB Bundle)** tab instead.

1. Build the bundle: `pnpm run build:mcpb` → `dist-mcpb/b2-mcp.mcpb` (packs
   `mcpb/manifest.json`, which runs `npx -y @backblaze-labs/b2-mcp@<version>`
   and prompts for the B2 credentials). Both the manifest version and the pinned
   npx launcher version are kept in lockstep with `package.json` by
   `scripts/update-server-json-version.mjs`, so the advertised bundle is
   reproducible.
2. On [smithery.ai/new](https://smithery.ai/new), pick the **Local (MCPB
   Bundle)** tab, namespace `backblaze-labs`, server id `b2-mcp`, and upload the
   `.mcpb`. (The legacy `smithery.yaml` is retained for older tooling.)

## On every release

1. Bump + `scripts/update-server-json-version.mjs` (syncs `server.json`,
   `lhm.plugin.json`, and `mcpb/manifest.json` versions).
2. `pnpm run build:mcpb` and upload/publish the `.mcpb` to Smithery.
3. Regenerate `lhm.plugin.json` and `lhm plugin update`.
4. Cut a new Glama release (rerun the Dockerfile deploy → Make Release).
5. Confirm the registry badge shows the new version.
