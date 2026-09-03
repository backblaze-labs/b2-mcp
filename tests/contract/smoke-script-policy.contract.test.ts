import { readFileSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import { pathToFileURL } from "url";
import { readLock } from "./support";

const smokeScript = readFileSync(join(__dirname, "../../scripts/smoke-test.mjs"), "utf8");
const clientSmokePath = join(__dirname, "../../scripts/mcp-client-smoke.mjs");
const inspectorSmokePath = join(__dirname, "../../scripts/mcp-inspector-smoke.mjs");
const clientSmokeScript = readFileSync(clientSmokePath, "utf8");
const inspectorSmokeScript = readFileSync(inspectorSmokePath, "utf8");
const smokeContractScript = readFileSync(
  join(__dirname, "../../scripts/lib/smoke-contract.cjs"),
  "utf8",
);
const packageJson = readFileSync(join(__dirname, "../../package.json"), "utf8");
const parsedPackageJson = JSON.parse(packageJson) as {
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};
const pnpmWorkspace = readFileSync(join(__dirname, "../../pnpm-workspace.yaml"), "utf8");
const testingDoc = readFileSync(join(__dirname, "../../docs/TESTING.md"), "utf8");
const readme = readFileSync(join(__dirname, "../../README.md"), "utf8");
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

interface ClientSmokeModule {
  assertSmokeServerPreconditions(env: Record<string, string>): void;
  assertWorkerEnvIsSanitized(env: Record<string, string>): void;
  createBoundedStderrMonitor(options?: { signal?: string; maxTailBytes?: number }): {
    observe(chunk: string): void;
    readonly signalSeen: boolean;
    readonly tail: string;
  };
  createServerEnv(
    sourceEnv?: Record<string, string>,
    options?: { registerAllTools?: boolean },
  ): Record<string, string>;
  createWorkerEnv(sourceEnv?: Record<string, string>): Record<string, string>;
  instructionsIncludeRequiredSnippets(instructions: string, snippets: string[]): boolean;
  sensitiveEnvNames(env: Record<string, string>): string[];
}

interface InspectorSmokeModule {
  INSPECTOR_PACKAGE: string;
  INSPECTOR_VERSION: string;
  createInspectorEnv(options: {
    sourceEnv?: Record<string, string>;
    homeDir?: string;
  }): Record<string, string>;
  defaultInspectorCliArgs(rootDir?: string): string[];
  pnpmInvocation(sourceEnv?: Record<string, string>): { command: string; argsPrefix: string[] };
  pnpmExecArgs(userArgs?: string[], rootDir?: string): string[];
}

async function loadClientSmokeModule(): Promise<ClientSmokeModule> {
  return import(pathToFileURL(clientSmokePath).href) as Promise<ClientSmokeModule>;
}

async function loadInspectorSmokeModule(): Promise<InspectorSmokeModule> {
  return import(pathToFileURL(inspectorSmokePath).href) as Promise<InspectorSmokeModule>;
}

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
    expect(smokeScript).toContain("docs/generated/tool-profile-contract.json");
    expect(smokeScript).toContain("B2_MCP_EXPECTED_TOOL_PROFILE");
    expect(smokeScript).toContain("B2_MCP_ALLOW_ANY_TOOL_PROFILE");
    expect(smokeScript).toContain("liveToolContractSnapshot");
    expect(`${smokeScript}\n${smokeContractScript}`).toContain("fixtureHash");
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
    expect(smokeScript).toContain("B2_MCP_REQUIRE_SMOKE_BUCKET");
    expect(smokeScript).toContain("s3_head_bucket");
    expect(smokeScript).toContain("assertToolSuccess");
    expect(smokeScript).toContain("result?.isError");
    expect(smokeScript).toContain("MCP_REQUEST_TIMEOUT_MS");
    expect(smokeScript).toContain("MCP_REQUEST_ATTEMPTS");
    expect(smokeScript).toContain("AbortController");
    expect(smokeScript).toContain("RetryableSmokeRequestError");
    expect(smokeScript).toContain("isRetryableNetworkError");
    expect(smokeScript).toContain("smokeRequestLabel");
    expect(smokeScript).toContain('check("s3_head_bucket confirms smoke bucket", false');
    expect(smokeScript).toContain("redactB2CredentialValues");
    expect(smokeScript).not.toContain("s3_list_buckets");
  });

  it("keeps the supplemental SDK client smoke advisory and contract-backed", async () => {
    const clientSmoke = await loadClientSmokeModule();
    expect(parsedPackageJson.scripts["smoke:client"]).toBe("node scripts/mcp-client-smoke.mjs");
    expect(parsedPackageJson.scripts["smoke:client"]).not.toContain("build");
    expect(parsedPackageJson.scripts.verify).not.toContain("smoke:client");
    expect(clientSmokeScript).toContain("liveToolContractSnapshot");
    expect(clientSmokeScript).not.toContain("function snapshotFromTools");
    expect(clientSmokeScript).not.toContain("function arraysEqual");
    expect(clientSmokeScript).not.toMatch(
      /import\s+[^;]*["']@modelcontextprotocol\/client(?:\/stdio)?["']/,
    );
    expect(clientSmokeScript).not.toMatch(/stderr\s*\+=|let\s+stderr\s*=\s*["']/);
    expect(clientSmokeScript).not.toContain("@modelcontextprotocol/sdk");
    expect(clientSmokeScript).not.toContain("initialize");
    expect(testingDoc).toContain("@modelcontextprotocol/inspector@2.4.0");
    expect(testingDoc).toContain("Node.js 22.19.0 or newer");
    expect(`${readme}\n${testingDoc}\n${packageJson}`).not.toMatch(/\bpnpm\s+dlx\b/);
    expect(testingDoc).toMatch(/Claude[\s\S]{0,120}supplemental/);

    const sourceEnv = {
      PATH: "/usr/bin",
      B2_APPLICATION_KEY: "real-b2-secret",
      AWS_SECRET_ACCESS_KEY: "real-aws-secret",
      GITHUB_TOKEN: "real-github-token",
      NPM_TOKEN: "real-npm-token",
      CUSTOM_TOKEN: "real-custom-token",
    };
    const workerEnv = clientSmoke.createWorkerEnv(sourceEnv);
    expect(workerEnv).toMatchObject({ PATH: "/usr/bin", MCP_CLIENT_SMOKE_WORKER: "1" });
    expect(clientSmoke.sensitiveEnvNames(workerEnv)).toEqual([]);
    expect(() => clientSmoke.assertWorkerEnvIsSanitized(sourceEnv)).toThrow(/sensitive/);

    const serverEnv = clientSmoke.createServerEnv(sourceEnv);
    expect(serverEnv.B2_REGISTER_ALL_TOOLS).toBe("true");
    expect(serverEnv.B2_APPLICATION_KEY_ID).toBe("external-smoke-key-id");
    expect(serverEnv.B2_APPLICATION_KEY).toBe("external-smoke-key-secret");
    expect(serverEnv.NODE_OPTIONS).toContain("scripts/no-network-guard.mjs");
    expect(serverEnv).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(() =>
      clientSmoke.assertSmokeServerPreconditions(
        clientSmoke.createServerEnv({}, { registerAllTools: false }),
      ),
    ).toThrow(/B2_REGISTER_ALL_TOOLS/);

    const monitor = clientSmoke.createBoundedStderrMonitor({ maxTailBytes: 8 });
    monitor.observe("prefix");
    monitor.observe(`MCP_CLIENT_SMOKE_NETWORK_BLOCKED:${"x".repeat(64)}`);
    expect(monitor.signalSeen).toBe(true);
    expect(monitor.tail.length).toBeLessThanOrEqual(8);
    expect(
      clientSmoke.instructionsIncludeRequiredSnippets("alpha beta gamma", ["alpha", "gamma"]),
    ).toBe(true);
  });

  it("keeps Inspector smoke locked, sanitized, and supplemental", async () => {
    const inspectorSmoke = await loadInspectorSmokeModule();
    const lock = readLock<{
      packages: Record<string, { dev?: boolean; integrity?: string; version?: string }>;
    }>();
    const lockedInspector = lock.packages["node_modules/@modelcontextprotocol/inspector"];
    const sourceEnv = {
      PATH: "/usr/bin",
      B2_APPLICATION_KEY: "real-b2-secret",
      AWS_SECRET_ACCESS_KEY: "real-aws-secret",
      GITHUB_TOKEN: "real-github-token",
      NPM_TOKEN: "real-npm-token",
    };

    expect(parsedPackageJson.devDependencies["@modelcontextprotocol/inspector"]).toBe("2.4.0");
    expect(parsedPackageJson.scripts["smoke:inspector"]).toBe(
      "node scripts/mcp-inspector-smoke.mjs",
    );
    expect(parsedPackageJson.scripts.verify).not.toContain("smoke:inspector");
    expect(lockedInspector?.version).toBe("2.4.0");
    expect(lockedInspector?.dev).toBe(true);
    expect(lockedInspector?.integrity).toMatch(/^sha512-/);
    expect(pnpmWorkspace).toContain("'@modelcontextprotocol/inspector': false");
    expect(pnpmWorkspace).not.toContain("@modelcontextprotocol/inspector@");
    expect(inspectorSmoke.INSPECTOR_PACKAGE).toBe("@modelcontextprotocol/inspector");
    expect(inspectorSmoke.INSPECTOR_VERSION).toBe("2.4.0");
    expect(inspectorSmoke.pnpmExecArgs()).toEqual([
      "exec",
      "mcp-inspector",
      ...inspectorSmoke.defaultInspectorCliArgs(),
    ]);
    expect(inspectorSmoke.pnpmExecArgs(["--cli", "--help"])).toEqual([
      "exec",
      "mcp-inspector",
      "--cli",
      "--help",
    ]);

    const defaultArgs = inspectorSmoke.defaultInspectorCliArgs("/repo");
    expect(defaultArgs).toEqual(
      expect.arrayContaining([
        "--cli",
        process.execPath,
        "/repo/dist/index.js",
        "--method",
        "tools/list",
        "--format",
        "json",
        "--connect-timeout",
        "10000",
        "--cwd",
        "/repo",
        "-e",
        "B2_REGISTER_ALL_TOOLS=true",
        "-e",
        "B2_APPLICATION_KEY_ID=external-smoke-key-id",
        "-e",
        "B2_APPLICATION_KEY=external-smoke-key-secret",
        "-e",
        "LOG_LEVEL=silent",
      ]),
    );
    expect(defaultArgs.some((arg) => arg.includes("scripts/no-network-guard.mjs"))).toBe(true);
    expect(inspectorSmoke.pnpmInvocation({ npm_execpath: "/tools/pnpm.cjs" })).toEqual({
      command: process.execPath,
      argsPrefix: ["/tools/pnpm.cjs"],
    });
    expect(() => inspectorSmoke.pnpmInvocation({})).toThrow(/pnpm run smoke:inspector/);

    const env = inspectorSmoke.createInspectorEnv({
      sourceEnv,
      homeDir: "/tmp/b2-mcp-inspector-home",
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/tmp/b2-mcp-inspector-home",
      USERPROFILE: "/tmp/b2-mcp-inspector-home",
      NO_COLOR: "1",
      npm_config_ignore_scripts: "true",
    });
    expect(env).not.toHaveProperty("B2_APPLICATION_KEY");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("NPM_TOKEN");
    expect(`${readme}\n${testingDoc}\n${packageJson}`).not.toContain(
      ["pnpm", "dlx", "@modelcontextprotocol/inspector"].join(" "),
    );
    expect(inspectorSmokeScript).toContain("pnpmExecArgs");
    expect(inspectorSmokeScript).not.toContain("pnpm dlx");
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
