#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { buildHttpServer } = require("../dist/http-server.js");
const { createServer, getRegisteredPrompts } = require("../dist/server.js");
const {
  APPROVED_CACHE_SCOPE,
  APPROVED_TTL_MS,
  CONTRACT_VERSION,
  LEGACY_PROTOCOL_VERSION,
  MCP_REVISION,
  PROFILE_DESCRIPTIONS,
  PROFILE_NAMES,
  PROMPT_CONTRACT_ISSUE,
  PROMPT_CONTRACT_ISSUE_URL,
  PROMPT_PROFILE_DESCRIPTIONS,
  TOOL_BACKING_CATEGORIES,
  TOOL_CONTRACT_ISSUE,
  TOOL_CONTRACT_ISSUE_URL,
  backingCategoryCounts,
  backingCategoryMapForNames,
  capabilitiesForProfile,
  configForProfile,
  configForPromptProfile,
  confirmToolsFrom,
  contractSdkVersions,
  countPrefixes,
  destructiveConfirmToolsFromTools,
  fixtureHash,
  normalizeTool,
  promptFixtureFromRegistered,
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

async function collectPromptFixture(profile) {
  const server = createServer(
    { ...configForPromptProfile(profile), enableMcpPrompts: true },
    capabilitiesForProfile(profile),
  );
  try {
    return promptFixtureFromRegistered({
      contractVersion: CONTRACT_VERSION,
      issue: PROMPT_CONTRACT_ISSUE,
      profile,
      mcpRevision: MCP_REVISION,
      sdk: sdkVersions,
      capabilities: capabilitiesForProfile(profile),
      registered: getRegisteredPrompts(server) ?? {},
    });
  } finally {
    await server.close().catch(() => undefined);
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
  const promptFixturesDir = join(root, "tests/fixtures/prompt-contract");
  mkdirSync(fixturesDir, { recursive: true });
  mkdirSync(promptFixturesDir, { recursive: true });

  const fixtures = {};
  for (const profile of PROFILE_NAMES) {
    fixtures[`${profile}.modern`] = await collectToolsList(profile, "modern");
    fixtures[`${profile}.legacy`] = await collectToolsList(profile, "legacy");
  }
  const promptFixtures = {};
  for (const profile of PROFILE_NAMES) {
    promptFixtures[profile] = await collectPromptFixture(profile);
  }

  const generatedJsonPaths = [];
  for (const [key, fixture] of Object.entries(fixtures)) {
    const fixturePath = join(fixturesDir, `${key}.json`);
    writeJson(fixturePath, fixture);
    generatedJsonPaths.push(fixturePath);
  }
  for (const [profile, fixture] of Object.entries(promptFixtures)) {
    const fixturePath = join(promptFixturesDir, `${profile}.json`);
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
  const promptProfiles = Object.fromEntries(
    PROFILE_NAMES.map((profile) => {
      const fixture = promptFixtures[profile];
      return [
        profile,
        {
          description: PROMPT_PROFILE_DESCRIPTIONS[profile],
          capabilities: capabilitiesForProfile(profile),
          counts: fixture.counts,
          names: fixture.names,
          requiredTools: fixture.requiredTools,
          requiredCapabilities: fixture.requiredCapabilities,
          hash: fixture.hash,
          fixture: `tests/fixtures/prompt-contract/${profile}.json`,
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
    promptIssue: PROMPT_CONTRACT_ISSUE,
    promptIssueUrl: PROMPT_CONTRACT_ISSUE_URL,
    promptProfiles,
  };

  const contractPath = join(root, "docs/generated/tool-profile-contract.json");
  writeJson(contractPath, contract);
  generatedJsonPaths.push(contractPath);
  formatGeneratedJson(generatedJsonPaths);
  const profileReferencePath = join(root, "docs/generated/tool-profiles.md");
  writeFileSync(profileReferencePath, renderProfileReference(contract));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
