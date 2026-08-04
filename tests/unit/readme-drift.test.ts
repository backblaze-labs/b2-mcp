/**
 * Doc-drift guard: README.md must stay in sync with the registered tool surface.
 *
 * The tool count and tool tables in README.md are hand-maintained and have
 * drifted before (the 4 insight tools shipped without README rows, and the
 * headline count read 36 for weeks after the surface hit 40). These tests make
 * the README self-policing: every registered tool must appear in a README
 * table, every backticked tool name in the README must exist on the server,
 * and the headline counts must match the registry.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createServer, getRegisteredTools } from "../../src/server";
import { DURABLE_SECRET_PRODUCING_TOOLS } from "../../src/utils/tool-capabilities";

let toolNames: string[];
let readme: string;
let v1Scope: string;

beforeAll(() => {
  const config = {
    applicationKeyId: "test",
    applicationKey: "test",
    appKeyId: "test",
    appKey: "test",
    masterKeyId: "test",
    masterKey: "test",
    region: "us-west-004",
    allowLocalFiles: true,
    fileRoot: null,
  };
  const server = createServer(config);
  toolNames = Object.keys(getRegisteredTools(server) ?? {}).sort();
  readme = readFileSync(join(__dirname, "../../README.md"), "utf8");
  v1Scope = readFileSync(join(__dirname, "../../docs/V1_SCOPE.md"), "utf8");
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

  it("headline tool counts match the registry", () => {
    const total = toolNames.length;
    const native = toolNames.filter((n) => n.startsWith("b2_")).length;
    const s3 = toolNames.filter((n) => n.startsWith("s3_")).length;
    expect(readme).toContain(`**${total} tools, split by what they do:**`);
    expect(readme).toContain(
      `**${total} total — ${native} native (\`b2_*\`) + ${s3} data-plane (\`s3_*\`).**`,
    );
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
    },
  );

  it("full profile list matches actual registration", () => {
    const listed = [...listedTools("full", "b2"), ...listedTools("full", "s3")].sort();
    expect(listed).toEqual(toolNames);
  });
});
