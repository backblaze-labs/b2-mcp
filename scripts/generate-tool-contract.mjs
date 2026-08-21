#!/usr/bin/env node
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { buildHttpServer } = require("../dist/http-server.js");
const {
  APPROVED_CACHE_SCOPE,
  APPROVED_TTL_MS,
  CONTRACT_VERSION,
  LEGACY_PROTOCOL_VERSION,
  MCP_REVISION,
  PROFILE_DESCRIPTIONS,
  PROFILE_NAMES,
  TOOL_BACKING_CATEGORIES,
  TOOL_CONTRACT_ISSUE,
  TOOL_CONTRACT_ISSUE_URL,
  backingCategoryCounts,
  backingCategoryMapForNames,
  capabilitiesForProfile,
  configForProfile,
  confirmToolsFrom,
  contractSdkVersions,
  countPrefixes,
  destructiveConfirmToolsFromTools,
  fixtureHash,
  normalizeTool,
  renderProfileReference,
  requiredFieldsByTool,
  stable,
} = require("../dist/tool-contract.js");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const sdkVersions = contractSdkVersions(packageJson);

async function listenOnEphemeralPort(handle) {
  await new Promise((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
  return handle.server.address().port;
}

async function collectToolsList(profile, era) {
  const capabilities = capabilitiesForProfile(profile);
  const credentialProvider = {
    name: "tool-contract-fixture",
    validateConfiguration() {
      // The fixture provider has no external configuration to validate.
    },
    resolve() {
      return {
        config: configForProfile(profile),
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
      issue: TOOL_CONTRACT_ISSUE,
      profile,
      era,
      protocolVersion:
        era === "modern" ? client.getNegotiatedProtocolVersion() : LEGACY_PROTOCOL_VERSION,
      transport: "streamable-http",
      mcpRevision: MCP_REVISION,
      sdk: sdkVersions,
      capabilities,
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

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function formatGeneratedJson(paths) {
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts/run-biome.mjs"), "format", ...paths, "--write"],
    {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Biome failed to format tool contracts");
  }
}

async function main() {
  const fixturesDir = join(root, "tests/fixtures/tool-contract");
  mkdirSync(fixturesDir, { recursive: true });

  const fixtures = {};
  for (const profile of PROFILE_NAMES) {
    fixtures[`${profile}.modern`] = await collectToolsList(profile, "modern");
    fixtures[`${profile}.legacy`] = await collectToolsList(profile, "legacy");
  }

  const generatedJsonPaths = [];
  for (const [key, fixture] of Object.entries(fixtures)) {
    const fixturePath = join(fixturesDir, `${key}.json`);
    writeJson(fixturePath, fixture);
    generatedJsonPaths.push(fixturePath);
  }

  const profiles = Object.fromEntries(
    PROFILE_NAMES.map((profile) => {
      const fixture = fixtures[`${profile}.modern`];
      return [
        profile,
        {
          description: PROFILE_DESCRIPTIONS[profile],
          capabilities: capabilitiesForProfile(profile),
          counts: fixture.counts,
          backingCounts: backingCategoryCounts(fixture.names),
          names: fixture.names,
          requiredFields: fixture.requiredFields,
          confirmTools: fixture.confirmTools,
          destructiveConfirmTools: destructiveConfirmToolsFromTools(fixture.tools),
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
    issue: TOOL_CONTRACT_ISSUE,
    issueUrl: TOOL_CONTRACT_ISSUE_URL,
    mcpRevision: MCP_REVISION,
    approvedCacheHint: {
      ttlMs: APPROVED_TTL_MS,
      cacheScope: APPROVED_CACHE_SCOPE,
    },
    sdk: sdkVersions,
    backingCategories: TOOL_BACKING_CATEGORIES,
    toolBacking: backingCategoryMapForNames(fixtures["full.modern"].names),
    profiles,
  };

  const contractPath = join(root, "docs/tool-profile-contract.json");
  writeJson(contractPath, contract);
  generatedJsonPaths.push(contractPath);
  formatGeneratedJson(generatedJsonPaths);
  const profileReferencePath = join(root, "docs/TOOL_PROFILES.md");
  writeFileSync(profileReferencePath, renderProfileReference(contract));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
