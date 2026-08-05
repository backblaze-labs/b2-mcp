import crypto from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { buildHttpServer, type HttpServerHandle } from "../../src/http-server";
import type { CredentialProvider, CredentialResolution } from "../../src/credentials";
import type { B2Config } from "../../src/utils/types";
import { readJson, root } from "./support";

type Era = "modern" | "legacy";
type ProfileName = "full" | "phase1-default" | "read-only";

interface NormalizedTool {
  name: string;
  descriptionSha256: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: JsonObject;
  _meta?: JsonObject;
}

interface ToolFixture {
  contractVersion: number;
  issue: number;
  profile: ProfileName;
  era: Era;
  protocolVersion: string;
  transport: string;
  mcpRevision: string;
  sdk: Record<string, string>;
  counts: { total: number; b2: number; s3: number; bz: number };
  names: string[];
  requiredFields: Record<string, string[]>;
  confirmTools: string[];
  tools: NormalizedTool[];
  modern?: {
    toolsListCacheHint: { ttlMs: number; cacheScope: string };
    discover: {
      supportedVersions: string[];
      capabilities: JsonObject;
      ttlMs: number;
      cacheScope: string;
      resultType: string;
    };
  };
  legacy?: {
    toolsListCacheHint: null;
    discover: null;
  };
  hash: string;
}

interface ContractProfile {
  description: string;
  counts: ToolFixture["counts"];
  names: string[];
  requiredFields: Record<string, string[]>;
  confirmTools: string[];
  destructiveConfirmTools: string[];
  hash: string;
  fixtures: Record<Era, string>;
}

interface ContractArtifact {
  contractVersion: number;
  issue: number;
  issueUrl: string;
  mcpRevision: string;
  approvedCacheHint: { ttlMs: number; cacheScope: string };
  sdk: Record<string, string>;
  profiles: Record<ProfileName, ContractProfile>;
}

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

const contract = readJson<ContractArtifact>("docs/tool-profile-contract.json");
const packageJson = readJson<{
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}>("package.json");

const profileNames = Object.keys(contract.profiles) as ProfileName[];
const eras: Era[] = ["modern", "legacy"];

const phase1DefaultCapabilities = [
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

const profileCapabilities: Record<ProfileName, string[] | null> = {
  full: null,
  "phase1-default": phase1DefaultCapabilities,
  "read-only": ["listBuckets", "listFiles", "listKeys", "readBucketNotifications", "readFiles"],
};

const testConfig: B2Config = {
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

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown, parentKey = ""): JsonValue {
  if (Array.isArray(value)) {
    const next = value.map((item) => stable(item));
    if (parentKey === "required" && next.every((item) => typeof item === "string")) {
      return [...next].sort() as JsonValue;
    }
    return next as JsonValue;
  }
  if (value === null || typeof value !== "object") return value as JsonValue;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "description")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item, key)]),
  ) as JsonObject;
}

function countPrefixes(names: string[]): ToolFixture["counts"] {
  return {
    total: names.length,
    b2: names.filter((name) => name.startsWith("b2_")).length,
    s3: names.filter((name) => name.startsWith("s3_")).length,
    bz: names.filter((name) => name.startsWith("bz_")).length,
  };
}

function normalizeTool(tool: {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  _meta?: unknown;
}): NormalizedTool {
  const normalized: NormalizedTool = {
    name: tool.name,
    descriptionSha256: sha256(tool.description ?? ""),
    inputSchema: stable(tool.inputSchema ?? {}) as JsonObject,
  };
  if (tool.outputSchema !== undefined)
    normalized.outputSchema = stable(tool.outputSchema) as JsonObject;
  if (tool.annotations !== undefined)
    normalized.annotations = stable(tool.annotations) as JsonObject;
  if (tool._meta !== undefined) normalized._meta = stable(tool._meta) as JsonObject;
  return normalized;
}

function requiredFieldsByTool(
  tools: Array<{ name: string; inputSchema?: { required?: string[] } }>,
) {
  return Object.fromEntries(
    tools.map((tool) => [tool.name, [...(tool.inputSchema?.required ?? [])].sort()]),
  );
}

function confirmToolsFrom(
  tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>,
): string[] {
  return tools
    .filter((tool) => tool.inputSchema?.properties?.confirm !== undefined)
    .map((tool) => tool.name)
    .sort();
}

function fixtureHash(fixture: Pick<ToolFixture, "names" | "tools">): string {
  return sha256(JSON.stringify({ names: fixture.names, tools: fixture.tools }));
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

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
        config: testConfig,
        cacheKey: `tool-contract:${profile}`,
        capabilityCacheKey: `tool-contract:${profile}`,
      };
    },
  };
}

async function collectFixture(profile: ProfileName, era: Era): Promise<ToolFixture> {
  const handle = buildHttpServer({
    credentialProvider: credentialProvider(profile),
    fetchCapabilities: async () => profileCapabilities[profile],
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
    const names = tools.map((tool) => tool.name);
    const fixture: ToolFixture = {
      contractVersion: contract.contractVersion,
      issue: contract.issue,
      profile,
      era,
      protocolVersion:
        era === "modern"
          ? (client.getNegotiatedProtocolVersion() ?? "")
          : (client.getNegotiatedProtocolVersion() ?? ""),
      transport: "streamable-http",
      mcpRevision: contract.mcpRevision,
      sdk: {
        "@modelcontextprotocol/server": packageJson.dependencies["@modelcontextprotocol/server"],
        "@modelcontextprotocol/client": packageJson.devDependencies["@modelcontextprotocol/client"],
      },
      counts: countPrefixes(names),
      names,
      requiredFields: requiredFieldsByTool(tools),
      confirmTools: confirmToolsFrom(tools),
      tools: tools.map(normalizeTool),
      hash: "",
    };

    if (era === "modern") {
      const discover = client.getDiscoverResult();
      fixture.modern = {
        toolsListCacheHint: {
          ttlMs: numberValue(list.ttlMs, -1),
          cacheScope: stringValue(list.cacheScope, ""),
        },
        discover: {
          supportedVersions: discover?.supportedVersions ?? [],
          capabilities: stable(discover?.capabilities ?? {}) as JsonObject,
          ttlMs: numberValue(discover?.ttlMs, -1),
          cacheScope: stringValue(discover?.cacheScope, ""),
          resultType: stringValue(discover?.resultType, ""),
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
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  }
}

function fixtureFor(profile: ProfileName, era: Era): ToolFixture {
  return readJson<ToolFixture>(contract.profiles[profile].fixtures[era]);
}

function getTool(fixture: ToolFixture, name: string): NormalizedTool {
  const tool = fixture.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing fixture tool ${name}`);
  return tool;
}

function visit(
  value: unknown,
  cb: (key: string, value: unknown, path: string) => void,
  path = "$",
) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, cb, `${path}/${index}`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const nextPath = `${path}/${key}`;
    cb(key, item, nextPath);
    visit(item, cb, nextPath);
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
      value.forEach((item) => walk(item, depth + 1));
      return;
    }
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === "string") {
      refCount++;
      if (refCount > 100) throw new Error("JSON Schema $ref count exceeds contract bound");
      resolveLocalRef(schema, object.$ref);
    }
    Object.values(object).forEach((item) => walk(item, depth + 1));
  };
  walk(schema, 0);
  expect(maxDepth).toBeLessThanOrEqual(32);
}

function renderProfileReference(source: ContractArtifact): string {
  const tableRows = [
    ["Profile", "Total", "`b2_*`", "`s3_*`", "`bz_*`", "Hash prefix"],
    ...Object.entries(source.profiles).map(([profile, data]) => [
      `\`${profile}\``,
      String(data.counts.total),
      String(data.counts.b2),
      String(data.counts.s3),
      String(data.counts.bz),
      `\`${data.hash.slice(0, 12)}\``,
    ]),
  ];
  const widths = tableRows[0].map((_, index) =>
    Math.max(...tableRows.map((row) => row[index].length)),
  );
  const numericColumns = new Set([1, 2, 3, 4]);
  const formatCell = (value: string, index: number): string =>
    numericColumns.has(index) ? value.padStart(widths[index]) : value.padEnd(widths[index]);
  const header = `| ${tableRows[0].map(formatCell).join(" | ")} |`;
  const separator = `| ${widths
    .map((width, index) =>
      numericColumns.has(index) ? `${"-".repeat(width - 1)}:` : "-".repeat(width),
    )
    .join(" | ")} |`;
  const rows = tableRows
    .slice(1)
    .map((row) => `| ${row.map(formatCell).join(" | ")} |`)
    .join("\n");

  const sections = Object.entries(source.profiles)
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
        data.description,
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
    `Contract version: \`${source.contractVersion}\``,
    `MCP revision: \`${source.mcpRevision}\``,
    `Approved modern cache hint: \`ttlMs=${source.approvedCacheHint.ttlMs}\`, \`cacheScope=${source.approvedCacheHint.cacheScope}\``,
    "",
    header,
    separator,
    rows,
    "",
    sections,
    "",
  ].join("\n");
}

describe("MCP tool profile fixtures", () => {
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
      expect(contract.profiles[profile].hash).toBe(fixture.hash);
    }
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
    "%s has input schemas without credential fields or x-mcp-header",
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
        visit(tool.inputSchema, (key, value, path) => {
          if (prohibitedFields.has(key)) violations.push(`${tool.name}:${path}`);
          if (key.toLowerCase() === "x-mcp-header") violations.push(`${tool.name}:${path}`);
          if (
            key.toLowerCase() === "x-mcp-header" &&
            typeof value === "string" &&
            /authorization|credential|secret|key|token/i.test(value)
          ) {
            violations.push(`${tool.name}:${path}=${value}`);
          }
        });
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
      expect((validator as any).ajv.validateSchema(tool.inputSchema)).toBe(true);
      expect(() => validator.getValidator(tool.inputSchema as any)).not.toThrow();
    }
  });

  it("does not introduce outputSchema without result-conformance coverage", () => {
    const withOutputSchema = profileNames.flatMap((profile) =>
      fixtureFor(profile, "modern")
        .tools.filter((tool) => tool.outputSchema !== undefined)
        .map((tool) => `${profile}:${tool.name}`),
    );
    expect(withOutputSchema).toEqual([]);
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
      expect(fixture.modern?.discover.capabilities).toEqual({ tools: { listChanged: true } });
      expect(Object.keys(fixture.modern?.discover.capabilities ?? {}).sort()).toEqual(["tools"]);
    },
  );

  it.each(profileNames)("legacy %s omits modern cache/discover extensions", (profile) => {
    const fixture = fixtureFor(profile, "legacy");
    expect(fixture.legacy).toEqual({ toolsListCacheHint: null, discover: null });
    expect(fixture.protocolVersion).toBe("2025-11-25");
  });
});

describe("Tool profile reference drift", () => {
  it("keeps the human-readable profile reference generated from the JSON artifact", () => {
    const expected = renderProfileReference(contract);
    const actual = readFileSync(join(root, "docs/TOOL_PROFILES.md"), "utf8");
    expect(actual).toBe(expected);
  });
});
