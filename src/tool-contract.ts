import crypto from "crypto";
import type { B2Config } from "./utils/types.js";
import { DESTRUCTIVE_TOOL_NAMES } from "./utils/destructive-gate.js";

export { DESTRUCTIVE_TOOL_NAMES };

/** Current schema version for generated MCP tool contract artifacts. */
export const CONTRACT_VERSION = 1;
/** Issue that originally introduced the frozen tool contract. */
export const TOOL_CONTRACT_ISSUE = 49;
/** GitHub issue URL for the tool contract baseline. */
export const TOOL_CONTRACT_ISSUE_URL = "https://github.com/backblaze-labs/b2-mcp/issues/49";
/** Preferred modern MCP protocol revision captured by contract fixtures. */
export const MCP_REVISION = "2026-07-28";
/** Legacy MCP protocol revision retained for compatibility fixtures. */
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";
/** Approved cache hint TTL in modern contract fixtures. */
export const APPROVED_TTL_MS = 30_000;
/** Approved cache hint scope in modern contract fixtures. */
export const APPROVED_CACHE_SCOPE = "private";

/** Capability profiles used to generate deterministic tool-surface fixtures. */
export const PROFILE_CAPABILITIES = {
  full: null,
  "live-b2-contract": [
    "bypassGovernance",
    "deleteBuckets",
    "deleteFiles",
    "listBuckets",
    "listFiles",
    "listKeys",
    "readBucketEncryption",
    "readBucketRetentions",
    "readBuckets",
    "readFileLegalHolds",
    "readFileRetentions",
    "readFiles",
    "writeBucketEncryption",
    "writeBucketNotifications",
    "writeBucketRetentions",
    "writeBuckets",
    "writeFileLegalHolds",
    "writeFileRetentions",
    "writeFiles",
  ],
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

/** Named contract profile. */
export type ProfileName = keyof typeof PROFILE_CAPABILITIES;
/** Protocol era represented by a fixture. */
export type Era = "modern" | "legacy";
/** JSON value shape used by stable contract fixtures. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
/** JSON object shape used by stable contract fixtures. */
export type JsonObject = { [key: string]: JsonValue };

/** Human-readable backing-category metadata for the public tool surface. */
export const TOOL_BACKING_CATEGORIES = {
  nativeB2Sdk: {
    label: "Native B2 SDK",
    sdkPackage: "@backblaze-labs/b2-sdk",
    description: "B2 operations the S3 API has no equivalent for.",
  },
  awsS3Sdk: {
    label: "AWS S3 SDK",
    sdkPackage: "@aws-sdk/client-s3",
    description: "The S3-compatible data plane.",
  },
  customMcp: {
    label: "Neither SDK",
    sdkPackage: null,
    description: "Repository-owned MCP analytics that no SDK exposes as primitives.",
  },
} as const;

/** Backing category key for a public MCP tool. */
export type ToolBackingCategory = keyof typeof TOOL_BACKING_CATEGORIES;
/** Count of tools by backing category. */
export type ToolBackingCounts = Record<ToolBackingCategory, number>;

/** Backing category assigned to every public tool name. */
export const TOOL_BACKING_BY_NAME = {
  b2_authorize_account: "nativeB2Sdk",
  b2_create_bucket: "nativeB2Sdk",
  b2_create_group_member: "nativeB2Sdk",
  b2_create_key: "nativeB2Sdk",
  b2_delete_bucket: "nativeB2Sdk",
  b2_delete_key: "nativeB2Sdk",
  b2_egress_leaders: "customMcp",
  b2_eject_group_member: "nativeB2Sdk",
  b2_get_bucket_notification_rules: "nativeB2Sdk",
  b2_largest_files: "customMcp",
  b2_list_buckets: "nativeB2Sdk",
  b2_list_group_members: "nativeB2Sdk",
  b2_list_groups: "nativeB2Sdk",
  b2_list_keys: "nativeB2Sdk",
  b2_reserve_trial_create_account: "nativeB2Sdk",
  b2_set_bucket_notification_rules: "nativeB2Sdk",
  b2_unfinished_uploads: "customMcp",
  b2_update_bucket: "nativeB2Sdk",
  b2_update_file_legal_hold: "nativeB2Sdk",
  b2_update_file_retention: "nativeB2Sdk",
  b2_usage_growth: "customMcp",
  s3_abort_multipart_upload: "awsS3Sdk",
  s3_complete_multipart_upload: "awsS3Sdk",
  s3_copy_object: "awsS3Sdk",
  s3_create_multipart_upload: "awsS3Sdk",
  s3_delete_object: "awsS3Sdk",
  s3_delete_objects: "awsS3Sdk",
  s3_get_bucket_location: "awsS3Sdk",
  s3_get_object: "awsS3Sdk",
  s3_get_presigned_url: "awsS3Sdk",
  s3_head_bucket: "awsS3Sdk",
  s3_head_object: "awsS3Sdk",
  s3_list_multipart_uploads: "awsS3Sdk",
  s3_list_object_versions: "awsS3Sdk",
  s3_list_objects_v2: "awsS3Sdk",
  s3_list_parts: "awsS3Sdk",
  s3_presign_upload_part: "awsS3Sdk",
  s3_put_bucket_lifecycle: "awsS3Sdk",
  s3_put_object: "awsS3Sdk",
  s3_upload_part_copy: "awsS3Sdk",
} as const satisfies Record<string, ToolBackingCategory>;

/** Normalized public tool definition persisted in contract fixtures. */
export interface NormalizedTool {
  name: string;
  descriptionSha256: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: JsonObject;
  _meta?: JsonObject;
}

/** Full deterministic fixture for one profile and protocol era. */
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

/** Profile summary included in the generated contract reference artifact. */
export interface ContractProfile {
  description: string;
  capabilities: string[] | null;
  counts: ToolFixture["counts"];
  backingCounts: ToolBackingCounts;
  names: string[];
  requiredFields: Record<string, string[]>;
  confirmTools: string[];
  destructiveConfirmTools: string[];
  hash: string;
  fixtures: Record<Era, string>;
}

/** Top-level generated contract artifact. */
export interface ContractArtifact {
  contractVersion: number;
  issue: number;
  issueUrl: string;
  mcpRevision: string;
  approvedCacheHint: { ttlMs: number; cacheScope: string };
  sdk: Record<string, string>;
  backingCategories: typeof TOOL_BACKING_CATEGORIES;
  toolBacking: Record<string, ToolBackingCategory>;
  profiles: Record<ProfileName, ContractProfile>;
}

/** Package metadata subset used to pin dependency versions in artifacts. */
export interface ToolContractPackageJson {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

/** Raw MCP tool payload collected from an SDK server instance. */
export interface RawToolPayload {
  name: string;
  description?: string;
  inputSchema?: {
    required?: string[];
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  outputSchema?: unknown;
  annotations?: unknown;
  _meta?: unknown;
}

/** Raw tool-list response and discovery metadata collected for one fixture. */
export interface CollectedToolList {
  tools: RawToolPayload[];
  list: { tools?: unknown; ttlMs?: number; cacheScope?: string; [key: string]: unknown };
  protocolVersion: string;
  discover?: {
    supportedVersions?: string[];
    capabilities?: unknown;
    ttlMs?: number;
    cacheScope?: string;
    resultType?: string;
  };
}

/** Inputs required to convert collected SDK tools into a stable fixture. */
export interface ToolFixtureFromCollectedOptions {
  contractVersion: number;
  issue: number;
  profile: ProfileName;
  era: Era;
  transport: string;
  mcpRevision: string;
  sdk: Record<string, string>;
  capabilities: string[] | null;
  collected: CollectedToolList;
}

/** Human-readable descriptions for each generated tool contract profile. */
export const PROFILE_DESCRIPTIONS: Record<ProfileName, string> = {
  full: "Complete tool superset for contract review and regression detection across all backing categories; durable-secret producers are sink-backed when a secret sink is active and otherwise remain availability-annotated stubs.",
  "live-b2-contract":
    "Protected live B2 contract profile: non-master application key with release-evidence capabilities, no key-management grants, and a distinct master key only for Partner/Groups API surface discovery.",
  "phase1-default":
    "Default customer-hosted Phase 1 profile: standard B2 application key, no distinct Partner/master credential, and durable-secret producers exposed as sink-backed tools on local stdio or unavailable stubs when the sink is off.",
  "read-only":
    "Deterministic read/list profile for safe production use and contract tests; write/delete/admin handlers are omitted while durable-secret producer names remain unavailable stubs unless a sink-backed admin profile is configured.",
};

/** Stable profile ordering used by contract generation. */
export const PROFILE_NAMES = Object.keys(PROFILE_CAPABILITIES) as ProfileName[];

/** Dummy B2 configuration used when collecting deterministic contract fixtures. */
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

/**
 * Resolve the B2 configuration for a contract profile.
 *
 * @param profile - Contract profile being collected.
 *
 * @returns B2 config with dummy deterministic credentials.
 */
export function configForProfile(profile: ProfileName): B2Config {
  if (profile !== "live-b2-contract") return CONTRACT_TEST_CONFIG;
  return {
    ...CONTRACT_TEST_CONFIG,
    masterKeyId: "contract-master-key-id",
    masterKey: "contract-master-key-secret",
  };
}

/**
 * Resolve the B2 capability list for a contract profile.
 *
 * @param profile - Contract profile being collected.
 *
 * @returns Capability list, or null for full-surface mode.
 */
export function capabilitiesForProfile(profile: ProfileName): string[] | null {
  const capabilities = PROFILE_CAPABILITIES[profile];
  return capabilities === null ? null : [...capabilities];
}

/**
 * Extract SDK dependency versions used in contract artifacts.
 *
 * @param packageJson - Package metadata subset.
 *
 * @returns Dependency version map persisted into fixtures.
 */
export function contractSdkVersions(packageJson: ToolContractPackageJson): Record<string, string> {
  return {
    "@backblaze-labs/b2-sdk": packageJson.dependencies["@backblaze-labs/b2-sdk"],
    "@modelcontextprotocol/client": packageJson.devDependencies["@modelcontextprotocol/client"],
    "@modelcontextprotocol/server": packageJson.dependencies["@modelcontextprotocol/server"],
  };
}

/**
 * Compute a SHA-256 hex digest.
 *
 * @param value - String to hash.
 *
 * @returns Hex digest.
 */
export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Convert arbitrary JSON-like data into a stable key-sorted fixture value.
 *
 * @param value - Value to normalize.
 * @param parentKey - Parent key used to sort `required` arrays.
 *
 * @returns Stable JSON-compatible value.
 */
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

/**
 * Count tools by public name prefix.
 *
 * @param names - Tool names to count.
 *
 * @returns Total, b2, s3, and legacy bz counts.
 */
export function countPrefixes(names: string[]): ToolFixture["counts"] {
  return {
    total: names.length,
    b2: names.filter((name) => name.startsWith("b2_")).length,
    s3: names.filter((name) => name.startsWith("s3_")).length,
    bz: names.filter((name) => name.startsWith("bz_")).length,
  };
}

function backingCategoryNames(): ToolBackingCategory[] {
  return Object.keys(TOOL_BACKING_CATEGORIES) as ToolBackingCategory[];
}

/**
 * Build a backing-category map for a list of tool names.
 *
 * @param names - Tool names that must be present in {@link TOOL_BACKING_BY_NAME}.
 *
 * @returns Sorted map from tool name to backing category.
 *
 * @throws Error when any tool lacks backing-category metadata.
 */
export function backingCategoryMapForNames(
  names: readonly string[],
): Record<string, ToolBackingCategory> {
  const toolBacking = TOOL_BACKING_BY_NAME as Record<string, ToolBackingCategory | undefined>;
  const missing: string[] = [];
  const result: Record<string, ToolBackingCategory> = {};

  for (const name of [...names].sort()) {
    const category = toolBacking[name];
    if (!category) {
      missing.push(name);
      continue;
    }
    result[name] = category;
  }

  if (missing.length > 0) {
    throw new Error(`Missing backing category for tool(s): ${missing.join(", ")}`);
  }

  return result;
}

/**
 * Count tools by backing category.
 *
 * @param names - Tool names to classify.
 *
 * @returns Backing-category counts.
 */
export function backingCategoryCounts(names: readonly string[]): ToolBackingCounts {
  const counts = Object.fromEntries(
    backingCategoryNames().map((category) => [category, 0]),
  ) as ToolBackingCounts;

  for (const category of Object.values(backingCategoryMapForNames(names))) {
    counts[category] += 1;
  }

  return counts;
}

/**
 * Normalize one raw MCP tool payload for stable fixture comparison.
 *
 * @param tool - Raw tool payload from the MCP SDK.
 *
 * @returns Stable normalized tool fixture.
 */
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

/**
 * Extract sorted required input fields for each tool.
 *
 * @param tools - Tool payloads to inspect.
 *
 * @returns Map from tool name to required field names.
 */
export function requiredFieldsByTool(
  tools: Array<{ name: string; inputSchema?: { required?: string[] } }>,
): Record<string, string[]> {
  return Object.fromEntries(
    tools.map((tool) => [tool.name, [...(tool.inputSchema?.required ?? [])].sort()]),
  );
}

/**
 * Find tools that expose the legacy `confirm` destructive-operation parameter.
 *
 * @param tools - Tool payloads to inspect.
 *
 * @returns Sorted destructive-confirm tool names.
 */
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

/**
 * Determine whether a tool schema advertises a destructive execution path.
 *
 * @param tool - Tool payload to inspect.
 *
 * @returns True when the tool is destructive for all calls or for a schema branch.
 */
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

/**
 * Find destructive tools from collected tool payloads.
 *
 * @param tools - Tool payloads to inspect.
 *
 * @returns Sorted destructive tool names.
 */
export function destructiveConfirmToolsFromTools(
  tools: Array<{ name: string; inputSchema?: unknown }>,
): string[] {
  return tools
    .filter(toolAdvertisesDestructivePath)
    .map((tool) => tool.name)
    .sort();
}

/**
 * Compute the stable hash for a fixture's public tool names and schemas.
 *
 * @param fixture - Fixture fields that define the public surface.
 *
 * @returns SHA-256 fixture hash.
 */
export function fixtureHash(fixture: Pick<ToolFixture, "names" | "tools">): string {
  return sha256(JSON.stringify({ names: fixture.names, tools: fixture.tools }));
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : [];
}

/**
 * Convert collected SDK output into a stable contract fixture.
 *
 * @param options - Collection metadata and raw tool payloads.
 *
 * @returns Complete fixture with stable ordering and hash.
 */
export function toolFixtureFromCollected({
  contractVersion,
  issue,
  profile,
  era,
  transport,
  mcpRevision,
  sdk,
  capabilities,
  collected,
}: ToolFixtureFromCollectedOptions): ToolFixture {
  const tools = [...collected.tools].sort((a, b) => a.name.localeCompare(b.name));
  const names = tools.map((tool) => tool.name);
  const fixture: ToolFixture = {
    contractVersion,
    issue,
    profile,
    era,
    protocolVersion: collected.protocolVersion,
    transport,
    mcpRevision,
    sdk,
    capabilities,
    counts: countPrefixes(names),
    names,
    requiredFields: requiredFieldsByTool(tools),
    confirmTools: confirmToolsFrom(tools),
    tools: tools.map(normalizeTool),
    hash: "",
  };

  if (era === "modern") {
    const discover = collected.discover;
    fixture.modern = {
      toolsListCacheHint: {
        ttlMs: numberValue(collected.list.ttlMs, -1),
        cacheScope: stringValue(collected.list.cacheScope, ""),
      },
      discover: {
        supportedVersions: stringArrayValue(discover?.supportedVersions),
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
}

/**
 * Render the generated markdown profile reference.
 *
 * @param contract - Contract artifact to render.
 *
 * @returns Markdown document for docs/tool profile reference.
 */
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
      const backingCounts = backingCategoryNames()
        .map(
          (category) =>
            `- ${contract.backingCategories[category].label}: ${data.backingCounts[category]}`,
        )
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
        "### Backing Categories",
        "",
        backingCounts,
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
