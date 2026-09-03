import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
  type JsonSchemaType,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { buildHttpServer, type HttpServerHandle } from "../../src/http-server";
import type { CredentialProvider, CredentialResolution } from "../../src/credentials";
import { createServer, getRegisteredPrompts } from "../../src/server";
import { B2_WORKFLOW_PROMPT_NAMES } from "../../src/prompts";
import { readJson, root } from "./support";
import {
  LEGACY_PROTOCOL_VERSION,
  PROFILE_NAMES,
  PROMPT_CONTRACT_ISSUE,
  PROMPT_CONTRACT_ISSUE_URL,
  TOOL_BACKING_BY_NAME,
  TOOL_BACKING_CATEGORIES,
  backingCategoryCounts,
  backingCategoryMapForNames,
  capabilitiesForProfile,
  configForProfile,
  configForPromptProfile,
  contractSdkVersions,
  countPrefixes,
  destructiveConfirmToolsFromTools,
  promptFixtureFromRegistered,
  renderProfileReference,
  toolFixtureFromCollected,
  type CollectedToolList,
  type ContractArtifact,
  type Era,
  type JsonObject,
  type NormalizedPrompt,
  type NormalizedTool,
  type PromptFixture,
  type ProfileName,
  type ToolFixture,
  type ToolContractPackageJson,
} from "../../src/tool-contract";

const contract = readJson<ContractArtifact>("docs/generated/tool-profile-contract.json");
const packageJson = readJson<ToolContractPackageJson>("package.json");
const biomeRunner = join(root, "scripts/run-biome.mjs");

const profileNames = Object.keys(contract.profiles) as ProfileName[];
const promptProfileNames = Object.keys(contract.promptProfiles) as ProfileName[];
const eras: Era[] = ["modern", "legacy"];

async function listenOnEphemeralPort(handle: HttpServerHandle): Promise<number> {
  await new Promise<void>((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
  const address = handle.server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
  return address.port;
}

function credentialProvider(profile: ProfileName): CredentialProvider {
  return {
    name: `tool-contract-${profile}`,
    validateConfiguration() {
      return undefined;
    },
    resolve(): CredentialResolution {
      return {
        config: configForProfile(profile),
        cacheKey: `tool-contract:${profile}`,
        capabilityCacheKey: `tool-contract:${profile}`,
      };
    },
  };
}

async function collectToolsList(profile: ProfileName, era: Era): Promise<CollectedToolList> {
  const handle = buildHttpServer({
    credentialProvider: credentialProvider(profile),
    fetchCapabilities: async () => contract.profiles[profile].capabilities,
  });
  const port = await listenOnEphemeralPort(handle);
  const clientOptions: ClientOptions =
    era === "modern" ? { versionNegotiation: { mode: { pin: contract.mcpRevision } } } : {};
  const client = new Client({ name: "b2-mcp-tool-contract", version: "1.0.0" }, clientOptions);
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

  try {
    await client.connect(transport);
    const list = await client.listTools({}, { cacheMode: "refresh" });
    const tools = [...(list.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    return {
      tools,
      list,
      protocolVersion:
        era === "modern" ? (client.getNegotiatedProtocolVersion() ?? "") : LEGACY_PROTOCOL_VERSION,
      discover: client.getDiscoverResult(),
    };
  } finally {
    await client.close().catch(() => undefined);
    handle.drain();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  }
}

async function collectFixture(profile: ProfileName, era: Era): Promise<ToolFixture> {
  const collected = await collectToolsList(profile, era);
  return toolFixtureFromCollected({
    contractVersion: contract.contractVersion,
    issue: contract.issue,
    profile,
    era,
    transport: "streamable-http",
    mcpRevision: contract.mcpRevision,
    sdk: contractSdkVersions(packageJson),
    capabilities: contract.profiles[profile].capabilities,
    collected,
  });
}

async function collectPromptFixture(profile: ProfileName): Promise<PromptFixture> {
  const server = createServer(
    { ...configForPromptProfile(profile), enableMcpPrompts: true },
    contract.promptProfiles[profile].capabilities,
  );
  try {
    return promptFixtureFromRegistered({
      contractVersion: contract.contractVersion,
      issue: contract.promptIssue,
      profile,
      mcpRevision: contract.mcpRevision,
      sdk: contractSdkVersions(packageJson),
      capabilities: contract.promptProfiles[profile].capabilities,
      registered: getRegisteredPrompts(server) ?? {},
    });
  } finally {
    await server.close();
  }
}

function fixtureFor(profile: ProfileName, era: Era): ToolFixture {
  return readJson<ToolFixture>(contract.profiles[profile].fixtures[era]);
}

function promptFixtureFor(profile: ProfileName): PromptFixture {
  return readJson<PromptFixture>(contract.promptProfiles[profile].fixture);
}

function getTool(fixture: ToolFixture, name: string): NormalizedTool {
  const tool = fixture.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing fixture tool ${name}`);
  return tool;
}

function getPrompt(fixture: PromptFixture, name: string): NormalizedPrompt {
  const prompt = fixture.prompts.find((candidate) => candidate.name === name);
  if (!prompt) throw new Error(`Missing fixture prompt ${name}`);
  return prompt;
}

function visit(
  value: unknown,
  cb: (key: string, value: unknown, path: string) => void,
  path = "$",
) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      visit(item, cb, `${path}/${index}`);
    });
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const nextPath = `${path}/${key}`;
    cb(key, item, nextPath);
    visit(item, cb, nextPath);
  }
}

const unsafeModelVisibleTextPatterns = [
  {
    label: "instruction override",
    pattern:
      /\b(ignore|bypass|override)\b.{0,80}\b(previous|prior|system|developer|security)\b.{0,40}\binstructions?\b/i,
  },
  {
    label: "credential exfiltration",
    pattern:
      /\b(read|open|load|print|echo|upload|send|post|copy|exfiltrate|leak|include|append)\b[\s\S]{0,120}\b(credentials?|secrets?|tokens?|passwords?|application keys?|master keys?|api keys?|authorization|~\/|\.aws|\.ssh)\b/i,
  },
  {
    label: "tool prelude exfiltration",
    pattern:
      /\b(before|after)\s+calling\s+this\s+tool\b[\s\S]{0,120}\b(read|open|upload|send|post|copy|exfiltrate|leak)\b/i,
  },
];

function collectStrings(
  value: unknown,
  cb: (value: string, path: string) => void,
  path = "$",
): void {
  if (typeof value === "string") {
    cb(value, path);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectStrings(item, cb, `${path}/${index}`);
    });
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    collectStrings(item, cb, `${path}/${key}`);
  }
}

function expectRepoFormatted(relativePaths: string[]): void {
  const result = spawnSync(process.execPath, [biomeRunner, "format", ...relativePaths], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Biome format check failed");
  }
}

function resolveLocalRef(rootSchema: JsonObject, ref: string): unknown {
  if (ref === "#") return rootSchema;
  if (!ref.startsWith("#/")) throw new Error(`External $ref is not allowed: ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((current, part) => {
      if (!current || typeof current !== "object" || !(part in current)) {
        throw new Error(`Unresolved $ref: ${ref}`);
      }
      return (current as Record<string, unknown>)[part];
    }, rootSchema);
}

function assertBoundedRefs(schema: JsonObject): void {
  let refCount = 0;
  let maxDepth = 0;
  const walk = (value: unknown, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);
    if (depth > 32) throw new Error("JSON Schema nesting exceeds contract bound");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item) => {
        walk(item, depth + 1);
      });
      return;
    }
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === "string") {
      refCount++;
      if (refCount > 100) throw new Error("JSON Schema $ref count exceeds contract bound");
      resolveLocalRef(schema, object.$ref);
    }
    Object.values(object).forEach((item) => {
      walk(item, depth + 1);
    });
  };
  walk(schema, 0);
  expect(maxDepth).toBeLessThanOrEqual(32);
}

describe("MCP tool profile fixtures", () => {
  it("publishes the approved profiles and capability inputs in the artifact", () => {
    expect(profileNames).toEqual(PROFILE_NAMES);
    expect(contract.sdk).toEqual(contractSdkVersions(packageJson));
    for (const profile of profileNames) {
      expect(contract.profiles[profile].capabilities).toEqual(capabilitiesForProfile(profile));
    }
  });

  it.each(profileNames.flatMap((profile) => eras.map((era) => [profile, era] as const)))(
    "%s %s fixture matches tools/list from the official SDK client",
    async (profile, era) => {
      await expect(collectFixture(profile, era)).resolves.toEqual(fixtureFor(profile, era));
    },
  );

  it.each(profileNames)("%s exposes the same normalized tool contract in both eras", (profile) => {
    const modern = fixtureFor(profile, "modern");
    const legacy = fixtureFor(profile, "legacy");
    expect(legacy.names).toEqual(modern.names);
    expect(legacy.requiredFields).toEqual(modern.requiredFields);
    expect(legacy.confirmTools).toEqual(modern.confirmTools);
    expect(legacy.tools).toEqual(modern.tools);
  });

  it("summary artifact is derived from modern fixtures", () => {
    for (const profile of profileNames) {
      const fixture = fixtureFor(profile, "modern");
      expect(contract.profiles[profile].counts).toEqual(fixture.counts);
      expect(contract.profiles[profile].names).toEqual(fixture.names);
      expect(contract.profiles[profile].requiredFields).toEqual(fixture.requiredFields);
      expect(contract.profiles[profile].confirmTools).toEqual(fixture.confirmTools);
      expect(contract.profiles[profile].capabilities).toEqual(fixture.capabilities);
      expect(contract.profiles[profile].hash).toBe(fixture.hash);
    }
  });
});

describe("MCP prompt profile fixtures", () => {
  it("publishes the approved prompt profiles and issue traceability", () => {
    expect(promptProfileNames).toEqual(PROFILE_NAMES);
    expect(contract.promptIssue).toBe(PROMPT_CONTRACT_ISSUE);
    expect(contract.promptIssueUrl).toBe(PROMPT_CONTRACT_ISSUE_URL);
    for (const profile of promptProfileNames) {
      expect(contract.promptProfiles[profile].capabilities).toEqual(
        capabilitiesForProfile(profile),
      );
    }
  });

  it.each(promptProfileNames)("%s fixture matches opt-in prompt registration", async (profile) => {
    await expect(collectPromptFixture(profile)).resolves.toEqual(promptFixtureFor(profile));
  });

  it("summary artifact is derived from prompt fixtures", () => {
    for (const profile of promptProfileNames) {
      const fixture = promptFixtureFor(profile);
      expect(contract.promptProfiles[profile].counts).toEqual(fixture.counts);
      expect(contract.promptProfiles[profile].names).toEqual(fixture.names);
      expect(contract.promptProfiles[profile].requiredTools).toEqual(fixture.requiredTools);
      expect(contract.promptProfiles[profile].requiredCapabilities).toEqual(
        fixture.requiredCapabilities,
      );
      expect(contract.promptProfiles[profile].capabilities).toEqual(fixture.capabilities);
      expect(contract.promptProfiles[profile].hash).toBe(fixture.hash);
    }
  });

  it("full prompt fixture snapshots every source workflow prompt", () => {
    expect(promptFixtureFor("full").names).toEqual([...B2_WORKFLOW_PROMPT_NAMES].sort());
  });
});

describe("MCP tool profile invariants", () => {
  it.each(profileNames)("%s has deterministic sorted names and prefix counts", (profile) => {
    const fixture = fixtureFor(profile, "modern");
    expect(fixture.names).toEqual([...fixture.names].sort());
    expect(fixture.tools.map((tool) => tool.name)).toEqual(fixture.names);
    expect(fixture.counts).toEqual(countPrefixes(fixture.names));
    expect(fixture.counts).toEqual(contract.profiles[profile].counts);
  });

  it.each(profileNames)("%s declares required fields from the contract artifact", (profile) => {
    const fixture = fixtureFor(profile, "modern");
    for (const name of fixture.names) {
      const schema = getTool(fixture, name).inputSchema;
      expect([...((schema.required as string[] | undefined) ?? [])].sort()).toEqual(
        contract.profiles[profile].requiredFields[name],
      );
    }
  });

  it.each(profileNames)("%s declares confirm fields on destructive tools only", (profile) => {
    const fixture = fixtureFor(profile, "modern");
    expect(contract.profiles[profile].destructiveConfirmTools).toEqual(
      destructiveConfirmToolsFromTools(fixture.tools),
    );
    expect(fixture.confirmTools).toEqual(contract.profiles[profile].destructiveConfirmTools);
    for (const name of contract.profiles[profile].destructiveConfirmTools) {
      const schema = getTool(fixture, name).inputSchema;
      const confirm = (schema.properties as Record<string, JsonObject>).confirm;
      expect(confirm).toBeDefined();
      expect(confirm.type).toBe("boolean");
      expect(schema.required ?? []).not.toContain("confirm");
    }
  });

  it.each(profileNames)(
    "%s has schemas and annotations without credential fields or x-mcp-header",
    (profile) => {
      const prohibitedFields = new Set([
        "accessKey",
        "accessKeyId",
        "apiKey",
        "applicationKey",
        "authorization",
        "awsAccessKeyId",
        "awsSecretAccessKey",
        "credential",
        "credentials",
        "masterKey",
        "password",
        "secretAccessKey",
        "secretKey",
        "sessionToken",
      ]);
      const violations: string[] = [];
      for (const tool of fixtureFor(profile, "modern").tools) {
        for (const field of ["inputSchema", "outputSchema", "annotations", "_meta"] as const) {
          const surface = tool[field];
          if (surface === undefined) continue;
          visit(surface, (key, value, path) => {
            if (prohibitedFields.has(key)) violations.push(`${tool.name}:${field}:${path}`);
            if (key.toLowerCase() === "x-mcp-header")
              violations.push(`${tool.name}:${field}:${path}`);
            if (
              key.toLowerCase() === "x-mcp-header" &&
              typeof value === "string" &&
              /authorization|credential|secret|key|token/i.test(value)
            ) {
              violations.push(`${tool.name}:${field}:${path}=${value}`);
            }
          });
        }
      }
      expect(violations).toEqual([]);
    },
  );

  it.each(profileNames)(
    "%s model-visible text contains no exfiltration instructions",
    async (profile) => {
      const violations: string[] = [];
      const collected = await collectToolsList(profile, "modern");
      for (const tool of collected.tools) {
        collectStrings(
          {
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            annotations: tool.annotations,
            _meta: tool._meta,
          },
          (value, path) => {
            for (const { label, pattern } of unsafeModelVisibleTextPatterns) {
              if (pattern.test(value)) violations.push(`${tool.name}:${path}:${label}`);
            }
          },
        );
      }
      expect(violations).toEqual([]);
    },
  );

  it.each(profileNames)("%s schemas are valid bounded JSON Schema 2020-12", (profile) => {
    const validator = new AjvJsonSchemaValidator();
    for (const tool of fixtureFor(profile, "modern").tools) {
      expect(tool.inputSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
      assertBoundedRefs(tool.inputSchema);
      expect(() => validator.getValidator(tool.inputSchema as JsonSchemaType)).not.toThrow();
    }
  });

  it.each(eras)("read-only %s presigned URLs are download-only", (era) => {
    const fixture = fixtureFor("read-only", era);
    const tool = getTool(fixture, "s3_get_presigned_url");
    const properties = tool.inputSchema.properties as Record<string, JsonObject>;
    const presignWriteTools = fixture.tools
      .filter((candidate) => candidate.name.includes("presign"))
      .filter((candidate) => JSON.stringify(candidate.inputSchema).includes('"PutObject"'))
      .map((candidate) => candidate.name);

    expect(properties.operation.enum).toEqual(["GetObject"]);
    expect(properties.contentType).toBeUndefined();
    expect(presignWriteTools).toEqual([]);
  });

  it.each(["full", "live-b2-contract", "phase1-default"] as const)(
    "%s presigned URLs keep download and upload operations",
    (profile) => {
      const tool = getTool(fixtureFor(profile, "modern"), "s3_get_presigned_url");
      const properties = tool.inputSchema.properties as Record<string, JsonObject>;

      expect(properties.operation.enum).toEqual(["GetObject", "PutObject"]);
      expect(properties.contentType).toBeDefined();
      expect(properties.confirm?.type).toBe("boolean");
    },
  );

  it("does not introduce outputSchema without result-conformance coverage", () => {
    const withOutputSchema = profileNames.flatMap((profile) =>
      fixtureFor(profile, "modern")
        .tools.filter((tool) => tool.outputSchema !== undefined)
        .map((tool) => `${profile}:${tool.name}`),
    );
    expect(withOutputSchema).toEqual([]);
  });
});

describe("MCP prompt profile invariants", () => {
  it.each(promptProfileNames)("%s has deterministic sorted prompt names", (profile) => {
    const fixture = promptFixtureFor(profile);
    expect(fixture.names).toEqual([...fixture.names].sort());
    expect(fixture.prompts.map((prompt) => prompt.name)).toEqual(fixture.names);
    expect(fixture.counts.total).toBe(fixture.names.length);
  });

  it.each(promptProfileNames)("%s declares prompt schema and requirement metadata", (profile) => {
    const fixture = promptFixtureFor(profile);
    const validator = new AjvJsonSchemaValidator();
    for (const name of fixture.names) {
      const prompt = getPrompt(fixture, name);
      expect(prompt.argsSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(prompt.argsSchema.type).toBe("object");
      expect(prompt.requiredTools.length).toBeGreaterThan(0);
      expect(fixture.requiredTools[name]).toEqual(prompt.requiredTools);
      expect(fixture.requiredCapabilities[name]).toEqual(prompt.requiredCapabilities);
      assertBoundedRefs(prompt.argsSchema);
      expect(() => validator.getValidator(prompt.argsSchema as JsonSchemaType)).not.toThrow();
    }
  });

  it("prompt fixtures publish input schemas for defaulted optional arguments", () => {
    const full = promptFixtureFor("full");
    const auditRequired = (getPrompt(full, "b2_audit_public_exposure").argsSchema.required ??
      []) as string[];
    const lifecycleRequired = (getPrompt(full, "b2_configure_lifecycle_cost_rules").argsSchema
      .required ?? []) as string[];

    expect(auditRequired).not.toContain("limit");
    expect(auditRequired).not.toContain("includeRemediationPlan");
    expect(lifecycleRequired).not.toContain("unfinishedLargeFileCancelDays");
  });
});

describe("MCP advertised capability contract", () => {
  it.each(profileNames)(
    "modern %s uses private cache hints and implemented capabilities",
    (profile) => {
      const fixture = fixtureFor(profile, "modern");
      expect(fixture.modern?.toolsListCacheHint).toEqual(contract.approvedCacheHint);
      expect(fixture.modern?.discover.ttlMs).toBe(contract.approvedCacheHint.ttlMs);
      expect(fixture.modern?.discover.cacheScope).toBe(contract.approvedCacheHint.cacheScope);
      expect(fixture.modern?.discover.supportedVersions).toEqual([contract.mcpRevision]);
      expect(fixture.modern?.discover.capabilities).toEqual({
        prompts: { listChanged: true },
        resources: { listChanged: true },
        tools: { listChanged: true },
      });
      expect(Object.keys(fixture.modern?.discover.capabilities ?? {}).sort()).toEqual([
        "prompts",
        "resources",
        "tools",
      ]);
    },
  );

  it.each(profileNames)("legacy %s omits modern cache/discover extensions", (profile) => {
    const fixture = fixtureFor(profile, "legacy");
    expect(fixture.legacy).toEqual({ toolsListCacheHint: null, discover: null });
    expect(fixture.protocolVersion).toBe(LEGACY_PROTOCOL_VERSION);
  });
});

describe("Tool backing category contract", () => {
  it("exports category definitions and assigns every full-profile tool exactly once", () => {
    const fullNames = contract.profiles.full.names;
    const sourceToolNames = Object.keys(TOOL_BACKING_BY_NAME).sort();
    const invalidCategories = Object.entries(TOOL_BACKING_BY_NAME)
      .filter(([, category]) => !(category in TOOL_BACKING_CATEGORIES))
      .map(([toolName, category]) => `${toolName}:${category}`);

    expect(invalidCategories).toEqual([]);
    expect(sourceToolNames).toEqual([...fullNames].sort());
    expect(contract.backingCategories).toEqual(TOOL_BACKING_CATEGORIES);
    expect(contract.toolBacking).toEqual(backingCategoryMapForNames(fullNames));
  });

  it.each(profileNames)("%s backing counts match profile membership", (profile) => {
    const backingCounts = contract.profiles[profile].backingCounts;

    expect(backingCounts).toEqual(backingCategoryCounts(contract.profiles[profile].names));
    expect(Object.values(backingCounts).reduce((sum, count) => sum + count, 0)).toBe(
      contract.profiles[profile].counts.total,
    );
  });
});

describe("Tool profile reference drift", () => {
  it("keeps the human-readable profile reference generated from the JSON artifact", () => {
    const expected = renderProfileReference(contract);
    const actual = readFileSync(join(root, "docs/generated/tool-profiles.md"), "utf8");
    expect(actual).toBe(expected);
  });

  it("keeps generated JSON artifacts in Biome format", () => {
    const files = [
      "docs/generated/tool-profile-contract.json",
      ...profileNames.flatMap((profile) => Object.values(contract.profiles[profile].fixtures)),
      ...promptProfileNames.map((profile) => contract.promptProfiles[profile].fixture),
    ].sort();

    expectRepoFormatted(files);
  });
});
