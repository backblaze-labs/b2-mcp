/**
 * Doc-drift guard: README.md must stay in sync with the registered tool surface.
 *
 * The tool count and tool tables in README.md are hand-maintained and have
 * drifted before. These tests make the README self-policing: every contracted
 * tool must appear in a README table, every backticked tool name in the README
 * must exist in the contract, and the headline counts must match the generated
 * contract artifact.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { TOOL_BACKING_CATEGORIES, backingCategoryCounts } from "../../src/tool-contract";
import { DURABLE_SECRET_PRODUCING_TOOLS } from "../../src/utils/tool-capabilities";
import { readJson } from "./support";

let toolNames: string[];
let readme: string;
let v1Scope: string;
let packageMetadata: {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  engines: { node: string };
  license: string;
  name: string;
};
let contract: {
  profiles: Record<string, { names: string[]; counts: { total: number; b2: number; s3: number } }>;
};

beforeAll(() => {
  contract = readJson("docs/generated/tool-profile-contract.json");
  packageMetadata = readJson("package.json");
  toolNames = contract.profiles.full.names;
  readme = readFileSync(join(__dirname, "../../README.md"), "utf8");
  v1Scope = readFileSync(join(__dirname, "../../docs/product-specs/v1-scope.md"), "utf8");
});

describe("README tool-surface drift", () => {
  it("mentions every registered tool", () => {
    const missing = toolNames.filter((name) => !readme.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });

  it("names no tools that are not registered", () => {
    // Backticked identifiers that look like tool names (allow digits: e.g.
    // s3_list_objects_v2). Excludes env vars and config keys by the prefix.
    const mentioned = [...readme.matchAll(/`((?:b2|bz|s3)_[a-z0-9_]+)`/g)].map((m) => m[1]);
    const registered = new Set(toolNames);
    // Durable-secret-producing tools may appear in README as intentionally
    // unavailable until a secret sink exists. Everything else must be registered.
    const stale = [...new Set(mentioned)].filter(
      (name) => !registered.has(name) && !DURABLE_SECRET_PRODUCING_TOOLS.has(name),
    );
    expect(stale).toEqual([]);
  });

  it("headline tool counts match the generated contract artifact", () => {
    const total = toolNames.length;
    const native = toolNames.filter((n) => n.startsWith("b2_")).length;
    const s3 = toolNames.filter((n) => n.startsWith("s3_")).length;
    const backingCounts = backingCategoryCounts(toolNames);

    expect(readme).toContain(`**${total} tools, assigned by backing category:**`);
    expect(readme).toContain(
      `**${total} total — ${backingCounts.nativeB2Sdk} ${TOOL_BACKING_CATEGORIES.nativeB2Sdk.label} + ${backingCounts.awsS3Sdk} ${TOOL_BACKING_CATEGORIES.awsS3Sdk.label} + ${backingCounts.customMcp} ${TOOL_BACKING_CATEGORIES.customMcp.label}/custom MCP tools.**`,
    );
    expect(readme).toContain(
      `Prefix counts remain ${native} native \`b2_*\` names + ${s3} data-plane \`s3_*\` names.`,
    );
  });

  it("keeps the flat `## Tools` list in exact sync with the full contract", () => {
    // The flat list under `## Tools` (before `### Tool details and availability`)
    // is what registry/directory auto-extractors read. Isolate it so a deleted or
    // mistyped bullet is caught here even though the name also appears in the
    // detailed tables below.
    const start = readme.indexOf("\n## Tools\n");
    const end = readme.indexOf("### Tool details and availability");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = readme.slice(start, end);
    const listed = [...section.matchAll(/^- `((?:b2|s3)_[a-z0-9_]+)`/gm)].map((m) => m[1]);
    // No duplicate bullets, and the set/count matches the full tool contract.
    expect([...listed].sort()).toEqual([...new Set(listed)].sort());
    expect([...listed].sort()).toEqual([...toolNames].sort());
  });
});

describe("README project badges", () => {
  it("tracks repository and package policy", () => {
    const dependencyCount = Object.keys(packageMetadata.dependencies).length;

    expect(packageMetadata.name).toBe("@backblaze-labs/b2-mcp");
    expect(packageMetadata.engines.node).toBe("^22.22.2 || ^24 || ^26");
    // Intentional overlap with typescript-7-migration: this guard owns README
    // badge sync, while the migration test owns the 6.0-line deferral record.
    expect(packageMetadata.devDependencies.typescript).toMatch(/^~6\./);
    expect(readme).toContain("actions/workflows/test.yml/badge.svg");
    expect(readme).toContain("CodeQL-enabled-brightgreen");
    expect(readme).toContain("npm/v/@backblaze-labs/b2-mcp");
    expect(readme).toContain(`license-${packageMetadata.license}-blue.svg`);
    expect(readme).toContain("TypeScript-6.x-3178c6");
    expect(readme).toContain("Node.js-22.22%2B%20%7C%2024%20%7C%2026-339933");
    expect(readme).toContain("MCP-2026--07--28-5b5fc7");
    expect(readme).toContain(`runtime_dependencies-${dependencyCount}-blue`);
  });

  it("links discovery badges to deterministic per-server listing URLs", () => {
    // Directory badges use the locked server name / repo path, so they activate
    // on release without a second version bump. See docs and the badge block.
    expect(readme).toContain(
      "registry.modelcontextprotocol.io/v0/servers?search=io.github.backblaze-labs/b2-mcp",
    );
    expect(readme).toContain("glama.ai/mcp/servers/@backblaze-labs/b2-mcp");
    // The Glama badge must render the live score image, not just link the base
    // server path (which both the image and the link URL share). Guard the exact
    // score-image target so reverting it away from /badges/score.svg fails CI.
    expect(readme).toContain("glama.ai/mcp/servers/@backblaze-labs/b2-mcp/badges/score.svg");
    // The LobeHub badge must keep both its shields image and its deterministic
    // per-server listing URL, so dropping either fails CI rather than silently
    // shipping a broken/absent badge.
    expect(readme).toContain("img.shields.io/badge/LobeHub-b2--mcp");
    expect(readme).toContain("lobehub.com/mcp/backblaze-labs-b2-mcp");
    // The MCP Registry badge must query the nested `$.servers[0].server.version`
    // path (encoded), matching the 2025-12-11 registry response shape. Guard
    // against a regression back to the flat `$.servers[0].version` query.
    expect(readme).toContain("query=%24.servers%5B0%5D.server.version");
    expect(readme).not.toContain("query=%24.servers%5B0%5D.version");
    // Never link badges to fragile search-result URLs.
    expect(readme).not.toContain("registry.modelcontextprotocol.io/?search=");
    expect(readme).not.toContain("smithery.ai/servers?q=");
    expect(readme).not.toContain("glama.ai/mcp/servers?query=");
  });
});

describe("V1 scope profile drift", () => {
  function profileSection(profile: string): string {
    const start = v1Scope.indexOf(`### \`${profile}\``);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = v1Scope.indexOf("\n### ", start + 1);
    return v1Scope.slice(start, next === -1 ? undefined : next);
  }

  function listedTools(profile: string, prefix: "b2" | "s3"): string[] {
    const section = profileSection(profile);
    const marker = `\`${prefix}_*\` tools in \`${profile}\`:`;
    const start = section.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const afterMarker = section.slice(start + marker.length);
    const endMatch = afterMarker.search(/\n(?:`[bs]3_\*` tools|Destructive|For `read-only`|## )/);
    const listText = afterMarker.slice(0, endMatch === -1 ? undefined : endMatch);
    return [...listText.matchAll(new RegExp("- `(" + prefix + "_[^`]+)`", "g"))]
      .map((match) => match[1])
      .sort();
  }

  function tableCounts(profile: string): { total: number; b2: number; s3: number } {
    const escaped = profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = v1Scope.match(
      new RegExp("\\| `" + escaped + "`\\s+\\|\\s+(\\d+)\\s+\\|\\s+(\\d+)\\s+\\|\\s+(\\d+)\\s+\\|"),
    );
    expect(match).not.toBeNull();
    return {
      total: Number(match![1]),
      b2: Number(match![2]),
      s3: Number(match![3]),
    };
  }

  it.each(["full", "phase1-default", "read-only"])(
    "%s count table matches the enumerated profile lists",
    (profile) => {
      const b2 = listedTools(profile, "b2");
      const s3 = listedTools(profile, "s3");
      const counts = tableCounts(profile);
      expect(b2).toHaveLength(counts.b2);
      expect(s3).toHaveLength(counts.s3);
      expect([...b2, ...s3]).toHaveLength(counts.total);
      expect(counts).toEqual({
        total: contract.profiles[profile].counts.total,
        b2: contract.profiles[profile].counts.b2,
        s3: contract.profiles[profile].counts.s3,
      });
      expect([...b2, ...s3].sort()).toEqual(contract.profiles[profile].names);
    },
  );

  it("full profile list matches the generated contract artifact", () => {
    const listed = [...listedTools("full", "b2"), ...listedTools("full", "s3")].sort();
    expect(listed).toEqual(contract.profiles.full.names);
  });
});
