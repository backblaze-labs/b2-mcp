#!/usr/bin/env node
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const require = createRequire(import.meta.url);

const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { buildHttpServer } = require("../dist/http-server.js");
const {
  APPROVED_CACHE_SCOPE,
  APPROVED_TTL_MS,
  CONTRACT_TEST_CONFIG,
  CONTRACT_VERSION,
  LEGACY_PROTOCOL_VERSION,
  MCP_REVISION,
  PROFILE_DESCRIPTIONS,
  PROFILE_NAMES,
  TOOL_CONTRACT_ISSUE,
  TOOL_CONTRACT_ISSUE_URL,
  capabilitiesForProfile,
  confirmToolsFrom,
  countPrefixes,
  destructiveConfirmToolsForNames,
  fixtureHash,
  normalizeTool,
  renderProfileReference,
  requiredFieldsByTool,
  stable,
} = require("../dist/tool-contract.js");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

async function listenOnEphemeralPort(handle) {
  await new Promise((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
  return handle.server.address().port;
}

async function collectToolsList(profile, era) {
  const capabilities = capabilitiesForProfile(profile);
  const credentialProvider = {
    name: "tool-contract-fixture",
    validateConfiguration() {},
    resolve() {
      return {
        config: CONTRACT_TEST_CONFIG,
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
      sdk: {
        "@modelcontextprotocol/server": packageJson.dependencies["@modelcontextprotocol/server"],
        "@modelcontextprotocol/client": packageJson.devDependencies["@modelcontextprotocol/client"],
      },
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

async function formatWithRepoConfig(path, source, parser) {
  const config = (await prettier.resolveConfig(path)) ?? {};
  return prettier.format(source, { ...config, filepath: path, parser });
}

async function writeJson(path, value) {
  writeFileSync(path, await formatWithRepoConfig(path, JSON.stringify(value), "json"));
}

async function main() {
  const fixturesDir = join(root, "tests/fixtures/tool-contract");
  mkdirSync(fixturesDir, { recursive: true });

  const fixtures = {};
  for (const profile of PROFILE_NAMES) {
    fixtures[`${profile}.modern`] = await collectToolsList(profile, "modern");
    fixtures[`${profile}.legacy`] = await collectToolsList(profile, "legacy");
  }

  for (const [key, fixture] of Object.entries(fixtures)) {
    await writeJson(join(fixturesDir, `${key}.json`), fixture);
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
          names: fixture.names,
          requiredFields: fixture.requiredFields,
          confirmTools: fixture.confirmTools,
          destructiveConfirmTools: destructiveConfirmToolsForNames(fixture.names),
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
    sdk: {
      "@modelcontextprotocol/server": packageJson.dependencies["@modelcontextprotocol/server"],
      "@modelcontextprotocol/client": packageJson.devDependencies["@modelcontextprotocol/client"],
    },
    profiles,
  };

  await writeJson(join(root, "docs/tool-profile-contract.json"), contract);
  const profileReferencePath = join(root, "docs/TOOL_PROFILES.md");
  writeFileSync(
    profileReferencePath,
    await formatWithRepoConfig(profileReferencePath, renderProfileReference(contract), "markdown"),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
