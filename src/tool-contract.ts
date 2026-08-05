import crypto from "crypto";
import type { B2Config } from "./utils/types.js";
import { DESTRUCTIVE_TOOL_NAMES } from "./utils/destructive-gate.js";

export { DESTRUCTIVE_TOOL_NAMES };

export const CONTRACT_VERSION = 1;
export const TOOL_CONTRACT_ISSUE = 49;
export const TOOL_CONTRACT_ISSUE_URL = "https://github.com/backblaze-labs/b2-mcp/issues/49";
export const MCP_REVISION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";
export const APPROVED_TTL_MS = 30_000;
export const APPROVED_CACHE_SCOPE = "private";

export const PROFILE_CAPABILITIES = {
  full: null,
  "phase1-default": [
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
  ],
  "read-only": ["listBuckets", "listFiles", "listKeys", "readBucketNotifications", "readFiles"],
} as const;

export type ProfileName = keyof typeof PROFILE_CAPABILITIES;
export type Era = "modern" | "legacy";
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export interface NormalizedTool {
  name: string;
  descriptionSha256: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: JsonObject;
  _meta?: JsonObject;
}

export interface ToolFixture {
  contractVersion: number;
  issue: number;
  profile: ProfileName;
  era: Era;
  protocolVersion: string;
  transport: string;
  mcpRevision: string;
  sdk: Record<string, string>;
  capabilities: string[] | null;
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

export interface ContractProfile {
  description: string;
  capabilities: string[] | null;
  counts: ToolFixture["counts"];
  names: string[];
  requiredFields: Record<string, string[]>;
  confirmTools: string[];
  destructiveConfirmTools: string[];
  hash: string;
  fixtures: Record<Era, string>;
}

export interface ContractArtifact {
  contractVersion: number;
  issue: number;
  issueUrl: string;
  mcpRevision: string;
  approvedCacheHint: { ttlMs: number; cacheScope: string };
  sdk: Record<string, string>;
  profiles: Record<ProfileName, ContractProfile>;
}

export interface ToolContractPackageJson {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export const PROFILE_DESCRIPTIONS: Record<ProfileName, string> = {
  full: "Complete tool superset for contract review and regression detection.",
  "phase1-default":
    "Default customer-hosted Phase 1 profile: standard B2 application key, no distinct Partner/master credential, durable-secret producers exposed only as unavailable compatibility stubs.",
  "read-only":
    "Deterministic read/list profile for safe production use and contract tests; b2_create_key, b2_create_group_member, and b2_reserve_trial_create_account remain present only as unavailable 410 compatibility stubs.",
};

export const PROFILE_NAMES = Object.keys(PROFILE_CAPABILITIES) as ProfileName[];

export const CONTRACT_TEST_CONFIG: B2Config = {
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

export function capabilitiesForProfile(profile: ProfileName): string[] | null {
  const capabilities = PROFILE_CAPABILITIES[profile];
  return capabilities === null ? null : [...capabilities];
}

export function contractSdkVersions(packageJson: ToolContractPackageJson): Record<string, string> {
  return {
    "@backblaze-labs/b2-sdk": packageJson.dependencies["@backblaze-labs/b2-sdk"],
    "@modelcontextprotocol/client": packageJson.devDependencies["@modelcontextprotocol/client"],
    "@modelcontextprotocol/server": packageJson.dependencies["@modelcontextprotocol/server"],
  };
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function stable(value: unknown, parentKey = ""): JsonValue {
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
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item, key)]),
  ) as JsonObject;
}

export function countPrefixes(names: string[]): ToolFixture["counts"] {
  return {
    total: names.length,
    b2: names.filter((name) => name.startsWith("b2_")).length,
    s3: names.filter((name) => name.startsWith("s3_")).length,
    bz: names.filter((name) => name.startsWith("bz_")).length,
  };
}

export function normalizeTool(tool: {
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

export function requiredFieldsByTool(
  tools: Array<{ name: string; inputSchema?: { required?: string[] } }>,
): Record<string, string[]> {
  return Object.fromEntries(
    tools.map((tool) => [tool.name, [...(tool.inputSchema?.required ?? [])].sort()]),
  );
}

export function confirmToolsFrom(
  tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>,
): string[] {
  return tools
    .filter((tool) => tool.inputSchema?.properties?.confirm !== undefined)
    .map((tool) => tool.name)
    .sort();
}

function schemaContainsLiteral(value: unknown, literal: string): boolean {
  if (value === literal) return true;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => schemaContainsLiteral(item, literal));
  return Object.values(value).some((item) => schemaContainsLiteral(item, literal));
}

export function toolAdvertisesDestructivePath(tool: {
  name: string;
  inputSchema?: unknown;
}): boolean {
  if (!DESTRUCTIVE_TOOL_NAMES.includes(tool.name)) return false;
  if (tool.name === "s3_get_presigned_url") {
    return schemaContainsLiteral(tool.inputSchema, "PutObject");
  }
  return true;
}

export function destructiveConfirmToolsFromTools(
  tools: Array<{ name: string; inputSchema?: unknown }>,
): string[] {
  return tools
    .filter(toolAdvertisesDestructivePath)
    .map((tool) => tool.name)
    .sort();
}

export function fixtureHash(fixture: Pick<ToolFixture, "names" | "tools">): string {
  return sha256(JSON.stringify({ names: fixture.names, tools: fixture.tools }));
}

export function renderProfileReference(contract: ContractArtifact): string {
  const rows = Object.entries(contract.profiles)
    .map(
      ([profile, data]) =>
        `| \`${profile}\` | ${data.counts.total} | ${data.counts.b2} | ${data.counts.s3} | ${data.counts.bz} | \`${data.hash.slice(0, 12)}\` |`,
    )
    .join("\n");

  const sections = Object.entries(contract.profiles)
    .map(([profile, data]) => {
      const capabilities =
        data.capabilities === null
          ? "- Full-surface override (`null` capability input)."
          : data.capabilities.map((capability) => `- \`${capability}\``).join("\n");
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
        "### Capability Input",
        "",
        capabilities,
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
