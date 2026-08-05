import { readFileSync } from "fs";
import { join } from "path";
import { createRequire } from "module";

const smokeScript = readFileSync(join(__dirname, "../../scripts/smoke-test.mjs"), "utf8");
const smokeContractScript = readFileSync(
  join(__dirname, "../../scripts/lib/smoke-contract.cjs"),
  "utf8",
);
const nodeRequire = createRequire(__filename);
const { evaluateProfileContract } = nodeRequire("../../scripts/lib/smoke-contract.cjs") as {
  evaluateProfileContract: (args: {
    snapshot: { names: string[]; hash: string };
    toolContract: {
      profiles: Record<string, { names: string[]; hash: string }>;
    };
    expectedProfile?: string;
    allowAnyProfile?: boolean;
  }) => {
    matchedProfile?: [string, { names: string[]; hash: string }];
    checks: Array<{ name: string; ok: boolean; detail: string }>;
  };
};

const profileContract = {
  profiles: {
    "phase1-default": { names: ["b2_authorize_account", "s3_get_presigned_url"], hash: "hash-a" },
    "read-only": { names: ["b2_authorize_account"], hash: "hash-b" },
  },
};

function checkResult(
  result: ReturnType<typeof evaluateProfileContract>,
  name: string,
): { name: string; ok: boolean; detail: string } {
  const found = result.checks.find((check) => check.name === name);
  if (!found) throw new Error(`Missing smoke profile check: ${name}`);
  return found;
}

describe("smoke script release contract", () => {
  it("uses MCP 2026-07-28 HTTP rather than an SDK v1 or SSE transport", () => {
    expect(smokeScript).toContain('"io.modelcontextprotocol/protocolVersion": "2026-07-28"');
    expect(smokeScript).toContain('"Mcp-Method": method');
    expect(smokeScript).toContain('method: "POST"');
    expect(smokeScript).not.toContain("@modelcontextprotocol/sdk");
    expect(smokeScript).not.toContain("SSEClientTransport");
    expect(smokeScript).not.toContain("@modelcontextprotocol/sdk/client/sse.js");
    expect(smokeScript).not.toContain("https://mcp.example.com/sse");
  });

  it("uses profile-aware tool checks rather than a universal full-surface count", () => {
    expect(smokeScript).toContain("docs/tool-profile-contract.json");
    expect(smokeScript).toContain("B2_MCP_EXPECTED_TOOL_PROFILE");
    expect(smokeScript).toContain("B2_MCP_ALLOW_ANY_TOOL_PROFILE");
    expect(smokeScript).toContain("liveToolContractSnapshot");
    expect(smokeScript).toContain("fixtureHash");
    expect(`${smokeScript}\n${smokeContractScript}`).toContain(
      "tools/list matches expected frozen profile contract",
    );
    expect(smokeScript).not.toContain("when count aligns");
    expect(smokeScript).not.toContain("unknownTools.length === 0");
    expect(smokeScript).toContain('toolNames.has("b2_authorize_account")');
    expect(smokeScript).toContain("not exposed for this credential profile");
    expect(smokeScript).not.toContain("EXPECTED_FULL_TOOL_COUNT");
    expect(smokeScript).not.toContain("85 tools");
    expect(smokeScript).not.toContain(">= 85");
    expect(smokeScript).not.toContain("≥ 85");
  });

  it("uses the registered S3 bucket probe with an explicit smoke bucket", () => {
    expect(smokeScript).toContain("B2_SMOKE_BUCKET");
    expect(smokeScript).toContain("s3_head_bucket");
    expect(smokeScript).not.toContain("s3_list_buckets");
  });

  it("fails closed unless a profile is expected or any-profile mode is explicit", () => {
    const result = evaluateProfileContract({
      snapshot: { names: ["b2_authorize_account"], hash: "hash-b" },
      toolContract: profileContract,
    });

    expect(checkResult(result, "expected tool profile is configured").ok).toBe(false);
    expect(checkResult(result, "tools/list matches expected frozen profile contract").ok).toBe(
      false,
    );
  });

  it("matches the exact expected profile by names and hash", () => {
    const result = evaluateProfileContract({
      snapshot: { names: ["b2_authorize_account", "s3_get_presigned_url"], hash: "hash-a" },
      toolContract: profileContract,
      expectedProfile: "phase1-default",
    });

    expect(result.matchedProfile?.[0]).toBe("phase1-default");
    expect(result.checks.map((check) => check.ok)).toEqual([true, true, true]);
  });

  it("rejects a missing-tool subset of an expected profile", () => {
    const result = evaluateProfileContract({
      snapshot: { names: ["b2_authorize_account"], hash: "subset-hash" },
      toolContract: profileContract,
      expectedProfile: "phase1-default",
    });

    expect(checkResult(result, "tools/list matches expected frozen profile contract").ok).toBe(
      false,
    );
  });

  it("rejects schema drift when tool names still match", () => {
    const result = evaluateProfileContract({
      snapshot: { names: ["b2_authorize_account", "s3_get_presigned_url"], hash: "drifted-hash" },
      toolContract: profileContract,
      expectedProfile: "phase1-default",
    });

    const profileCheck = checkResult(result, "tools/list matches expected frozen profile contract");
    expect(profileCheck.ok).toBe(false);
    expect(profileCheck.detail).toContain("names matched but hash");
  });

  it("allows any approved profile only when explicitly requested", () => {
    const result = evaluateProfileContract({
      snapshot: { names: ["b2_authorize_account"], hash: "hash-b" },
      toolContract: profileContract,
      allowAnyProfile: true,
    });

    expect(result.matchedProfile?.[0]).toBe("read-only");
    expect(result.checks.map((check) => check.ok)).toEqual([true, true, true]);
  });
});
