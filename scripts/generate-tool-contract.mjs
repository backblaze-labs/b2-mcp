#!/usr/bin/env node
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const require = createRequire(import.meta.url);

const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { buildHttpServer } = require("../dist/http-server.js");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const CONTRACT_VERSION = 1;
const ISSUE = 49;
const MCP_REVISION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const APPROVED_TTL_MS = 30_000;
const APPROVED_CACHE_SCOPE = "private";

const PHASE1_DEFAULT_CAPABILITIES = [
  "deleteBuckets",
  "deleteFiles",
  "deleteKeys",
  "listBuckets",
  "listFiles",
  "listKeys",
  "readBucketNotifications",
  "readFiles",
  "writeBucketNotifications",
  "writeBuckets",
  "writeFileLegalHolds",
  "writeFileRetentions",
  "writeFiles",
];

const READ_ONLY_CAPABILITIES = [
  "listBuckets",
  "listFiles",
  "listKeys",
  "readBucketNotifications",
  "readFiles",
];

const PROFILE_CAPABILITIES = {
  full: null,
  "phase1-default": PHASE1_DEFAULT_CAPABILITIES,
  "read-only": READ_ONLY_CAPABILITIES,
};

const PROFILE_DESCRIPTIONS = {
  full: "Complete tool superset for contract review and regression detection.",
  "phase1-default":
    "Default customer-hosted Phase 1 profile: standard B2 application key, no distinct Partner/master credential, durable-secret producers exposed only as unavailable compatibility stubs.",
  "read-only": "Deterministic read/list profile for safe production use and contract tests.",
};

const DESTRUCTIVE_CONFIRM_TOOLS = [
  "b2_delete_bucket",
  "b2_delete_key",
  "b2_eject_group_member",
  "b2_set_bucket_notification_rules",
  "b2_update_bucket",
  "b2_update_file_legal_hold",
  "b2_update_file_retention",
  "s3_abort_multipart_upload",
  "s3_delete_object",
  "s3_delete_objects",
  "s3_put_bucket_lifecycle",
];

const config = {
  applicationKeyId: "contract-key-id",
  applicationKey: "contract-key-secret",
  appKeyId: "contract-key-id",
  appKey: "contract-key-secret",
  masterKeyId: "contract-key-id",
  masterKey: "contract-key-secret",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
};

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stable(value, parentKey = "") {
  if (Array.isArray(value)) {
    const next = value.map((item) => stable(item));
    if (parentKey === "required" && next.every((item) => typeof item === "string")) {
      return [...next].sort();
    }
    return next;
  }
  if (!value || typeof value !== "object") return value;

  const entries = Object.entries(value)
    .filter(([key]) => key !== "description")
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries.map(([key, item]) => [key, stable(item, key)]));
}

function normalizeTool(tool) {
  const normalized = {
    name: tool.name,
    descriptionSha256: sha256(tool.description ?? ""),
    inputSchema: stable(tool.inputSchema ?? {}),
  };
  if (tool.outputSchema !== undefined) normalized.outputSchema = stable(tool.outputSchema);
  if (tool.annotations !== undefined) normalized.annotations = stable(tool.annotations);
  if (tool._meta !== undefined) normalized._meta = stable(tool._meta);
  return normalized;
}

function countPrefixes(names) {
  return {
    total: names.length,
    b2: names.filter((name) => name.startsWith("b2_")).length,
    s3: names.filter((name) => name.startsWith("s3_")).length,
    bz: names.filter((name) => name.startsWith("bz_")).length,
  };
}

function requiredFieldsByTool(tools) {
  return Object.fromEntries(
    tools.map((tool) => [tool.name, [...(tool.inputSchema.required ?? [])].sort()]),
  );
}

function confirmToolsFrom(tools) {
  return tools
    .filter((tool) => tool.inputSchema.properties?.confirm !== undefined)
    .map((tool) => tool.name)
    .sort();
}

function fixtureHash(fixture) {
  return sha256(JSON.stringify({ names: fixture.names, tools: fixture.tools }));
}

async function listenOnEphemeralPort(handle) {
  await new Promise((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
  return handle.server.address().port;
}

async function collectToolsList(profile, era) {
  const capabilities = PROFILE_CAPABILITIES[profile];
  const credentialProvider = {
    name: "tool-contract-fixture",
    validateConfiguration() {},
    resolve() {
      return {
        config,
        cacheKey: `tool-contract:${profile}`,
        capabilityCacheKey: `tool-contract:${profile}`,
      };
    },
  };

  const handle = buildHttpServer({
    credentialProvider,
    fetchCapabilities: async () => capabilities,
  });
  const port = await listenOnEphemeralPort(handle);
  const client = new Client(
    { name: "b2-mcp-tool-contract", version: "1.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: MCP_REVISION } } } : {},
  );
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

  try {
    await client.connect(transport);
    const list = await client.listTools({}, { cacheMode: "refresh" });
    const tools = [...(list.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    const names = tools.map((tool) => tool.name);
    const normalizedTools = tools.map(normalizeTool);
    const fixture = {
      contractVersion: CONTRACT_VERSION,
      issue: ISSUE,
      profile,
      era,
      protocolVersion:
        era === "modern" ? client.getNegotiatedProtocolVersion() : LEGACY_PROTOCOL_VERSION,
      transport: "streamable-http",
      mcpRevision: MCP_REVISION,
      sdk: {
        "@modelcontextprotocol/server": packageJson.dependencies["@modelcontextprotocol/server"],
        "@modelcontextprotocol/client": packageJson.devDependencies["@modelcontextprotocol/client"],
      },
      counts: countPrefixes(names),
      names,
      requiredFields: requiredFieldsByTool(tools),
      confirmTools: confirmToolsFrom(tools),
      tools: normalizedTools,
    };

    if (era === "modern") {
      const discover = client.getDiscoverResult();
      fixture.modern = {
        toolsListCacheHint: {
          ttlMs: list.ttlMs,
          cacheScope: list.cacheScope,
        },
        discover: {
          supportedVersions: discover?.supportedVersions ?? [],
          capabilities: stable(discover?.capabilities ?? {}),
          ttlMs: discover?.ttlMs,
          cacheScope: discover?.cacheScope,
          resultType: discover?.resultType,
        },
      };
    } else {
      fixture.legacy = {
        toolsListCacheHint: null,
        discover: null,
      };
    }

    fixture.hash = fixtureHash(fixture);
    return fixture;
  } finally {
    await client.close().catch(() => undefined);
    handle.drain();
    await new Promise((resolve) => handle.server.close(resolve));
  }
}

function renderProfileReference(contract) {
  const rows = Object.entries(contract.profiles)
    .map(
      ([profile, data]) =>
        `| \`${profile}\` | ${data.counts.total} | ${data.counts.b2} | ${data.counts.s3} | ${data.counts.bz} | \`${data.hash.slice(0, 12)}\` |`,
    )
    .join("\n");

  const sections = Object.entries(contract.profiles)
    .map(([profile, data]) => {
      const b2 = data.names
        .filter((name) => name.startsWith("b2_"))
        .map((name) => `- \`${name}\``)
        .join("\n");
      const s3 = data.names
        .filter((name) => name.startsWith("s3_"))
        .map((name) => `- \`${name}\``)
        .join("\n");
      return [
        `## \`${profile}\``,
        "",
        PROFILE_DESCRIPTIONS[profile],
        "",
        `Profile hash: \`${data.hash}\``,
        "",
        `### \`b2_*\` Tools (${data.counts.b2})`,
        "",
        b2 || "_None._",
        "",
        `### \`s3_*\` Tools (${data.counts.s3})`,
        "",
        s3 || "_None._",
      ].join("\n");
    })
    .join("\n\n");

  return [
    "<!-- Generated by scripts/generate-tool-contract.mjs. Do not edit by hand. -->",
    "",
    "# MCP Tool Profiles",
    "",
    `Contract version: \`${contract.contractVersion}\``,
    `MCP revision: \`${contract.mcpRevision}\``,
    `Approved modern cache hint: \`ttlMs=${contract.approvedCacheHint.ttlMs}\`, \`cacheScope=${contract.approvedCacheHint.cacheScope}\``,
    "",
    "| Profile | Total | `b2_*` | `s3_*` | `bz_*` | Hash prefix |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    rows,
    "",
    sections,
    "",
  ].join("\n");
}

async function main() {
  const fixturesDir = join(root, "tests/fixtures/tool-contract");
  mkdirSync(fixturesDir, { recursive: true });

  const fixtures = {};
  for (const profile of Object.keys(PROFILE_CAPABILITIES)) {
    fixtures[`${profile}.modern`] = await collectToolsList(profile, "modern");
    fixtures[`${profile}.legacy`] = await collectToolsList(profile, "legacy");
  }

  for (const [key, fixture] of Object.entries(fixtures)) {
    writeFileSync(join(fixturesDir, `${key}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  }

  const profiles = Object.fromEntries(
    Object.keys(PROFILE_CAPABILITIES).map((profile) => {
      const fixture = fixtures[`${profile}.modern`];
      return [
        profile,
        {
          description: PROFILE_DESCRIPTIONS[profile],
          counts: fixture.counts,
          names: fixture.names,
          requiredFields: fixture.requiredFields,
          confirmTools: fixture.confirmTools,
          destructiveConfirmTools: DESTRUCTIVE_CONFIRM_TOOLS.filter((name) =>
            fixture.names.includes(name),
          ),
          hash: fixture.hash,
          fixtures: {
            modern: `tests/fixtures/tool-contract/${profile}.modern.json`,
            legacy: `tests/fixtures/tool-contract/${profile}.legacy.json`,
          },
        },
      ];
    }),
  );

  const contract = {
    contractVersion: CONTRACT_VERSION,
    issue: ISSUE,
    issueUrl: "https://github.com/backblaze-labs/b2-mcp/issues/49",
    mcpRevision: MCP_REVISION,
    approvedCacheHint: {
      ttlMs: APPROVED_TTL_MS,
      cacheScope: APPROVED_CACHE_SCOPE,
    },
    sdk: {
      "@modelcontextprotocol/server": packageJson.dependencies["@modelcontextprotocol/server"],
      "@modelcontextprotocol/client": packageJson.devDependencies["@modelcontextprotocol/client"],
    },
    profiles,
  };

  writeFileSync(
    join(root, "docs/tool-profile-contract.json"),
    `${JSON.stringify(contract, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "docs/TOOL_PROFILES.md"),
    await prettier.format(renderProfileReference(contract), { parser: "markdown" }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
