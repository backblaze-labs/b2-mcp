# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm run build          # compile TypeScript -> dist/ (src only)
pnpm run typecheck      # type-check src + ALL tests, no emit (tsconfig.typecheck.json)
pnpm test               # runs `typecheck` first, then unit tests, no credentials needed
pnpm run test:contract  # deterministic MCP/schema/workflow contracts
pnpm run test:protocol  # deterministic modern + legacy MCP protocol behavior
pnpm run test:integration:live  # live tests, requires real B2 credentials in env
pnpm run start          # stdio transport (local Claude Desktop use)
pnpm run start:http     # Streamable HTTP transport, add --port 3000
```

> `pnpm run build` uses `tsconfig.json`, which **excludes `tests/`** — so it does
> not catch compile errors in test files. `pnpm run typecheck` (wired into `pnpm test`)
> compiles `src` **and** `tests` via `tsconfig.typecheck.json`, so live-test
> compile errors are caught with no credentials. This closed a real gap where a
> broken live-test reference only surfaced on a credentialed run.

Run a single unit test file:

```bash
pnpm exec vitest run --config vitest.config.mts --project=unit tests/unit/auth.unit.test.ts
```

Run a single test by name:

```bash
pnpm exec vitest run --config vitest.config.mts --project=unit --testNamePattern="should cache the token"
```

Integration tests require env vars. A single non-master application key works for B2 native, S3, **and** key management (`b2_create_key`/`list_keys`/`delete_key` only need `writeKeys`/`listKeys`/`deleteKeys`). A master key is only needed to exercise the Partner API tests — set `B2_MASTER_KEY_ID` / `B2_MASTER_KEY` for those (the master key is used only by those tools; the application key drives everything else):

```bash
# Most users — one (non-master) application key covers native + S3 + key mgmt:
B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy pnpm run test:integration:live

# Add a master key ONLY for Partner API flows:
B2_APPLICATION_KEY_ID=appkey_id B2_APPLICATION_KEY=appkey_secret \
B2_MASTER_KEY_ID=master_id B2_MASTER_KEY=master_secret \
pnpm run test:integration:live
```

## Architecture

### Entry points

- `src/index.ts` — stdio transport (Claude Desktop, local use)
- `src/http-server.ts` — **Streamable HTTP** transport for hosted deployments. Production serving uses the MCP SDK v2 per-request handler for MCP `2026-07-28` and a stateless 2025-era transition fallback; it does not create or depend on protocol sessions. Each `/mcp` request resolves credentials through the selected provider (`headers`, `server`, or `principal`) before the SDK handler runs. B2 credential and Authorization headers are stripped before crossing into the SDK boundary; verified caller identity travels only as `authInfo`. Handles `GET /health`, Host/Origin checks, request body caps, rate limiting, in-flight caps, graceful drain, and periodic cache sweeps.

### Tool registration flow

`server.ts` exports three functions:

- `loadConfig()` — reads env vars, validates required keys, returns `B2Config`
- `fetchCapabilities(config)` — one-shot authorize that returns the key's `allowed.capabilities`; returns `null` only for `B2_REGISTER_ALL_TOOLS=true`. Lookup failures throw so HTTP fails closed.
- `createServer(config, capabilities?)` — instantiates `B2AuthManager`, the SDK-backed `B2Client`, and the AWS S3 data-plane client (configured through `@backblaze-labs/b2-sdk/s3`), then calls all `register*Tools()` functions

Each register function receives the server + client(s) and calls `server.tool(name, description, zodSchema, handler)` for each tool. Adding a new tool means adding it to the appropriate register file — no changes to `server.ts` needed unless it's a new register file. **New tools should also be added to the capability map** (`src/utils/tool-capabilities.ts`).

**Capability-aware registration.** When `createServer` is given a `capabilities` array (the entry points fetch it via `fetchCapabilities`), it wraps `server.tool` so only tools the key can use are registered — the surface auto-right-sizes to the credential (a read-only key drops every write/delete/admin tool; full ~9,719 tokens → read-only ~2,867). The map is `src/utils/tool-capabilities.ts` (any-of semantics; unmapped tools always register; Partner tools register only with a distinct master key). When `capabilities` is `null`/omitted — all unit tests, or `B2_REGISTER_ALL_TOOLS=true` — the full surface registers, so there's no behavior change. The key decides what's _possible_; the destructive gate decides what's _permitted_.

### Two API surfaces, two client types

The surface is split by plane: **control plane = native B2 semantics, data plane = compatibility `s3_*` tool contracts.**

**B2 SDK boundary** (`src/b2/`) — the official `@backblaze-labs/b2-sdk` integration boundary for B2 authorization state, endpoint data, retry semantics, and native bucket/key/Object Lock/notification operations. `B2Client` owns the shared auth/circuit wrapper and native lookups used by S3 safety guards, such as version-ID ownership checks and delete-marker metadata synthesis.

**S3-compatible API** (`src/s3/`) — the **data-plane tool contract**: all `s3_*` object, presigned URL, multipart, bucket reachability/location/lifecycle, upload-part-copy, and report-bucket reads use the permanent AWS S3 SDK peer client configured through `@backblaze-labs/b2-sdk/s3`. B2 rejects **master** keys on the S3 endpoint, but ordinary application keys are accepted — which is why the application key (`B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY`) is the primary credential and signs S3 requests. (The deprecated `B2_APP_KEY_ID` / `B2_APP_KEY` override remains only for legacy setups whose application key is a master key.)

**Credential routing** (`createServer` in `server.ts`): the application key drives the B2 native API, S3, and key management. Only the Partner API tools use the master key — `createServer` builds a second `B2Client` from `B2_MASTER_KEY_*` and wires it into `registerPartnerTools`, falling back to the application-key client when no distinct master key is set.

### Auth token lifecycle (`src/auth.ts`)

`B2AuthManager` caches the token for 23 hours (B2 tokens are valid 24h). Concurrent `getAuth()` calls share a single in-flight authorize request (deduped via `inflightAuth` promise). On 401, `B2Client` calls `auth.invalidate()` before retrying so the next `getAuth()` re-authorizes.

### Object upload / data plane

Object data movement runs through the **`s3_*` data-plane tools**. Inline object operations in `src/s3/objects.ts`, presigning in `src/s3/presigned.ts`, and multipart in `src/s3/multipart.ts` all call the repository-owned AWS S3 peer adapter configured for B2's S3-compatible endpoint.

**Control-plane-first data path.** The preferred way to move real object data is a **presigned URL** (`s3_get_presigned_url`, PutObject or GetObject): the bytes flow directly between the client/worker and B2 and never pass through the server. The inline `s3_put_object` / `s3_get_object` paths are bounded to **≤ 1 MiB** (`MAX_INLINE_OBJECT_BYTES` in `src/s3/objects.ts`) — a control-plane convenience for manifests, sidecars, and tiny configs; anything larger is refused with a pointer to `s3_get_presigned_url` or the multipart flow. **Multipart is presigned-per-part too**: `s3_create_multipart_upload` → `s3_presign_upload_part` (mints a presigned PUT URL per part) → the client PUTs each part directly to B2 → `s3_complete_multipart_upload` with the returned ETags. No multipart tool streams part bytes through the server. On the trusted stdio transport, `saveToPath` still streams any size straight to disk without buffering. Because the HTTP transport also disables local-file access by default, the internet-facing server is **control-plane-only by construction**: no bulk object data can flow through it.

> The former native data tools and their files (`src/b2/files.ts`, `src/b2/large-files.ts`, `src/b2/download-urls.ts` — including `b2_upload_file`'s auto-multipart path and the native download-URL builders) were **removed** from the public tool surface. The inherited `s3_*` object names remain compatibility aliases, and their implementation now uses the AWS S3 SDK against B2's S3-compatible endpoint.

### Tool naming conventions

- `b2_*` — B2 native **control-plane** tools (buckets, application keys, Object Lock, notifications), plus Partner API group/trial tools (use b2api/v3)
- `s3_*` — compatibility **data-plane** tools; object aliases, presigned URLs, multipart, reachability, and lifecycle paths use the AWS SDK peer client through the SDK `/s3` boundary

### Retry logic (`src/utils/retry.ts`)

The official SDK retry transport handles B2 retries and token refresh. `B2Client.withNativeCircuit()` wraps native/SDK B2 operations in the shared circuit breaker; local S3 presigning is intentionally outside that breaker unless it must perform a fresh native lookup such as version-ID ownership validation.

### Test patterns

Unit tests (`tests/unit/`) mock dependencies with `vi.spyOn(...)` — no network
calls, no credentials needed. `tests/contract/tools-schema.contract.test.ts`
builds the full server with dummy credentials and validates all 40 tool schemas
structurally.

Live integration tests (`tests/live/b2.integration.live.test.ts`) use these skip guards:

- `liveIt` — skips when `B2_APPLICATION_KEY_ID` is absent (general B2 + Partner/master-only tests use this credential)
- `liveS3It` — skips when `B2_APP_KEY_ID` is absent (S3 tests need a non-master application key, which is only required when the primary key is a master key)
- `partnerIt` — skips unless `B2_PARTNER_LIVE=1` **and** the primary key is a master key on a Partner-API-entitled account. Runs the read-only Groups flow (`b2_list_groups → b2_list_group_members`); bails gracefully if the account isn't entitled.
- The mutating Groups test (`create_group_member → eject`) is additionally gated on `B2_PARTNER_MUTATE=1` + `B2_PARTNER_TEST_EMAIL`, and skipped by default — `b2_create_group_member` creates a **real, non-deletable** Backblaze account that eject does not remove, so it must never run in CI.

To run the Partner Groups test, supply a **master** key via `B2_MASTER_KEY_*` (Partner endpoints reject non-master keys); the application key stays non-master so native + S3 tests still work in the same run:

```bash
B2_APPLICATION_KEY_ID=appkey_id B2_APPLICATION_KEY=appkey_secret \
B2_MASTER_KEY_ID=master_id B2_MASTER_KEY=master_secret \
B2_PARTNER_LIVE=1 pnpm run test:integration:live
```

## HTTP transport: per-request credentials & hardening

The HTTP server (`src/http-server.ts`) implements a single `/mcp` endpoint with MCP `2026-07-28` as the preferred era and stateless 2025-era compatibility during migration. Credentials are resolved per request. Unset `B2_HTTP_CREDENTIAL_MODE` defaults to `headers` for one-release compatibility; hosted operators should set `server` or `principal` explicitly when clients must not send B2 keys.

Because this transport is internet-facing, it is hardened by default:

- **Local filesystem access is OFF.** `filePath` / `saveToPath` are rejected unless an operator sets `B2_ALLOW_LOCAL_FILES=true` **and** `B2_FILE_ROOT=/sandbox/dir` — and even then every path is confined (symlinks resolved) to that root via `src/utils/fs-guard.ts`. Remote callers can pass small (≤ 1 MiB) base64 `content` inline; for real object data they should use a presigned PutObject URL (`s3_get_presigned_url`) so bytes go client→B2 directly. On the stdio transport disk access is on by default (trusted local user); set `B2_FILE_ROOT` to sandbox it or `B2_ALLOW_LOCAL_FILES=false` to disable.
- **In-flight caps:** `B2_MAX_SESSIONS` (default 1000) total and `B2_MAX_SESSIONS_PER_KEY` (default 20) per credential, returning 503 / 429 over the cap. The env names are retained for deploy-manifest compatibility.
- **Rate limiting** keys on a SHA-256 hash of the full key id (not a prefix), so distinct tenants can't collide.
- **DNS-rebinding protection:** set `B2_ALLOWED_HOSTS` / `B2_ALLOWED_ORIGINS` (comma-separated) to enable Host/Origin validation on the `/mcp` endpoint.
- **Body cap:** POST bodies to `/mcp` are capped at 1 MB (413 over the cap).
- **`b2_create_key` lockdown** (`src/b2/keys.ts`, applies on all transports): a minted key is a durable credential the model sees once, so by default the server **rejects** minting keys that grant key-management capabilities (`listKeys`/`writeKeys`/`deleteKeys` — a self-perpetuating backdoor) and **rejects** unscoped keys holding write/delete capabilities (forces a `bucketId`/`bucketIds` scope). Optional `B2_MAX_KEY_DURATION_SECONDS` enforces a maximum validity and forbids non-expiring keys. Overrides: `B2_ALLOW_KEY_MGMT_GRANTS=true`, `B2_ALLOW_UNSCOPED_KEYS=true`. B2 still independently enforces that a key cannot exceed the creating key's own capabilities.
- **Destructive-operation gate** (`src/utils/destructive-gate.ts`, all transports). Irreversible/high-impact tools are gated by `B2_DESTRUCTIVE_POLICY`. **Coverage (12 tools):** explicit deletes (`s3_delete_object`, `s3_delete_objects`, `s3_abort_multipart_upload`, `b2_delete_bucket`, `b2_delete_key`); `b2_eject_group_member`; irreversible/billable account creation (`b2_create_group_member`, `b2_reserve_trial_create_account`); the protection-removal steps that precede a delete (`b2_update_file_retention` when clearing retention or using `bypassGovernance`, `b2_update_file_legal_hold` when set to `off`, `b2_update_bucket` when it makes a bucket public, disables/clears Object Lock, or schedules deletion via `lifecycleRules`); and `s3_put_bucket_lifecycle` when a rule schedules deletion/expiration. **Policies:** `confirm` requires MCP form elicitation approval on compatible 2026 clients, or `confirm: true` when elicitation is unavailable/disabled; `block` refuses outright before elicitation; `allow` disables the gate and skips elicitation. **Per-transport default: stdio = `confirm` (trusted local user); the internet-facing HTTP transport = `block` (safe-by-default).** An operator opts down with `B2_DESTRUCTIVE_POLICY`. Server-side, so it holds even for MCP clients without the skills layer; each gated tool exposes an optional `confirm` boolean. `confirm` and client-relayed elicitation are defense-in-depth (a hijacked or malicious client could fabricate approval) — `block` (the HTTP default) or host consent is the wall for untrusted contexts.

Client config notes:

- **Claude Desktop** (`claude_desktop_config.json`) only accepts stdio entries. To connect to a hosted Streamable HTTP server, use the `mcp-remote` bridge as a local stdio shim (`command: "npx"`, `args: ["-y", "mcp-remote", "<url>/mcp", "--header", "X-B2-Key-Id:…", "--header", "X-B2-Key:…"]`). The URL + headers shape is rejected by Claude Desktop with "not a valid MCP server configuration."
- **Claude.ai web / Pro / Max Custom Connectors** accept the URL + headers shape directly: `{ url, headers: { "X-B2-Key-Id": "…", "X-B2-Key": "…" } }`.

`X-B2-Key-Id` / `X-B2-Key` are required — the application key, used for B2 native, S3, and key management. `X-B2-Master-Key-Id` / `X-B2-Master-Key` are optional and used **only** by the Partner API tools (they fall back to the application key when absent). `X-B2-App-Key-Id` / `X-B2-App-Key` are the deprecated legacy non-master S3 override, kept only for setups whose `X-B2-Key-Id` is a master key.

## Deployment target

t4g.medium (2 vCPU, 4 GB RAM) on AWS, us-west-2. Fly.io or Railway are simpler alternatives (automatic SSL, no nginx needed). EC2 requires nginx for SSL termination (Let's Encrypt + Certbot) and a systemd service to keep the process running.
