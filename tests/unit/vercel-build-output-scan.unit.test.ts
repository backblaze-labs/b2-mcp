import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { root } from "../contract/support";

const scannerPath = path.join(root, "scripts/check-vercel-build-output.mjs");
const reviewedRuntime = "nodejs24.x";
const plantedSecret = "K005abcdefghijklmnopqr";

type Finding = {
  path: string;
  reason: string;
  line?: number;
};

type ScanResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  findings: Finding[];
  inventory: {
    scannedFiles: number;
    functions: string[];
    functionConfigs: Array<{ path: string; runtime: string; hasEnvironment: boolean }>;
  };
};

function writeFile(base: string, relativePath: string, contents: string): void {
  const target = path.join(base, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function writeFunctionConfig(
  outputDir: string,
  config: Record<string, unknown> = { runtime: reviewedRuntime },
): void {
  writeFile(
    outputDir,
    "functions/api/mcp.func/.vc-config.json",
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

function scanFixture(
  mutate: (outputDir: string) => void,
  extraEnv: Record<string, string> = {},
): ScanResult {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "b2-mcp-vercel-scan-"));
  const outputDir = path.join(tmpDir, "output");
  const reportsDir = path.join(tmpDir, "reports");
  mkdirSync(outputDir, { recursive: true });
  writeFunctionConfig(outputDir);
  mutate(outputDir);

  const result = spawnSync(process.execPath, [scannerPath], {
    cwd: root,
    env: {
      ...process.env,
      ...extraEnv,
      B2_MCP_VERCEL_OUTPUT_DIR: outputDir,
      B2_MCP_VERCEL_REPORTS_DIR: reportsDir,
    },
    encoding: "utf8",
  });
  const findingsPath = path.join(reportsDir, "findings.json");
  const inventoryPath = path.join(reportsDir, "inventory.json");
  const findings = JSON.parse(readFileSync(findingsPath, "utf8")) as Finding[];
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as ScanResult["inventory"];
  rmSync(tmpDir, { recursive: true, force: true });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    findings,
    inventory,
  };
}

function expectFinding(
  result: ScanResult,
  expected: { reason: string; path?: string; line?: number },
): void {
  expect(result.status).toBe(1);
  expect(result.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        reason: expected.reason,
        ...(expected.path ? { path: expected.path } : {}),
        ...(expected.line ? { line: expected.line } : {}),
      }),
    ]),
  );
}

describe("Vercel build output scanner", () => {
  it("accepts a clean function output and sanitized v2 SDK metadata", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.func/node_modules/@modelcontextprotocol/sdk/package.json",
        `${JSON.stringify({ name: "@modelcontextprotocol/sdk", version: "2.0.0" })}\n`,
      );
    });

    expect(result.status).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.inventory.scannedFiles).toBeGreaterThanOrEqual(2);
    expect(result.inventory.functions).toEqual(["functions/api/mcp.func/.vc-config.json"]);
    expect(result.inventory.functionConfigs).toEqual([
      {
        path: "functions/api/mcp.func/.vc-config.json",
        runtime: reviewedRuntime,
        hasEnvironment: false,
      },
    ]);
  });

  it("rejects dotenv files in the output", () => {
    const result = scanFixture((outputDir) => {
      writeFile(outputDir, ".env", "B2_APPLICATION_KEY=not-uploaded\n");
    });

    expectFinding(result, { reason: "dotenv-file-in-output", path: ".env" });
  });

  it("rejects client public env markers", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.func/index.js",
        'const name = "NEXT_PUBLIC_B2_URL";\n',
      );
    });

    expectFinding(result, {
      reason: "client-public-env-marker",
      path: "functions/api/mcp.func/index.js",
      line: 1,
    });
  });

  it("rejects embedded function environment blocks without echoing values", () => {
    const result = scanFixture((outputDir) => {
      writeFunctionConfig(outputDir, {
        runtime: reviewedRuntime,
        environment: { B2_APPLICATION_KEY: plantedSecret },
      });
    });

    expectFinding(result, {
      reason: "embedded-function-environment",
      path: "functions/api/mcp.func/.vc-config.json",
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(plantedSecret);
  });

  it("rejects malformed function config JSON", () => {
    const result = scanFixture((outputDir) => {
      writeFile(outputDir, "functions/api/mcp.func/.vc-config.json", "{not-json");
    });

    expectFinding(result, {
      reason: "invalid-function-config-json",
      path: "functions/api/mcp.func/.vc-config.json",
    });
  });

  it("rejects runtime MCP SDK v1 packages but allows v2 packages", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.func/node_modules/@modelcontextprotocol/sdk/package.json",
        `${JSON.stringify({ name: "@modelcontextprotocol/sdk", version: "1.2.0" })}\n`,
      );
    });

    expectFinding(result, {
      reason: "runtime-mcp-sdk-v1-bundle",
      path: "functions/api/mcp.func/node_modules/@modelcontextprotocol/sdk/package.json",
    });
  });

  it("rejects secret-shaped bracket env assignments", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.func/index.js",
        `const env = process.env;\nprocess.env["B2_APPLICATION_KEY"] = "${plantedSecret}";\n`,
      );
    });

    expectFinding(result, {
      reason: "secret-shaped-assignment",
      path: "functions/api/mcp.func/index.js",
      line: 2,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(plantedSecret);
  });

  it("rejects secret-shaped LIVE_B2 assignments", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.func/index.js",
        `LIVE_B2_APPLICATION_KEY = "${plantedSecret}";\n`,
      );
    });

    expectFinding(result, {
      reason: "secret-shaped-assignment",
      path: "functions/api/mcp.func/index.js",
      line: 1,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(plantedSecret);
  });

  it("rejects generic secret-shaped assignments", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.func/index.js",
        `const client_secret = "${plantedSecret}";\n`,
      );
    });

    expectFinding(result, {
      reason: "secret-shaped-assignment",
      path: "functions/api/mcp.func/index.js",
      line: 1,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(plantedSecret);
  });

  it("rejects bearer token literals", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.func/index.js",
        `const authorization = "Bearer ${plantedSecret}";\n`,
      );
    });

    expectFinding(result, {
      reason: "bearer-token-literal",
      path: "functions/api/mcp.func/index.js",
      line: 1,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(plantedSecret);
  });

  it("rejects Vercel bypass literals", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.func/index.js",
        `const headers = { "x-vercel-protection-bypass": "${plantedSecret}" };\n`,
      );
    });

    expectFinding(result, {
      reason: "vercel-bypass-literal",
      path: "functions/api/mcp.func/index.js",
      line: 1,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(plantedSecret);
  });

  it("rejects exact known secret values when a sensitive env var is seeded", () => {
    const result = scanFixture(
      (outputDir) => {
        writeFile(
          outputDir,
          "functions/api/mcp.func/index.js",
          `const leaked = "${plantedSecret}";\n`,
        );
      },
      { B2_APPLICATION_KEY: plantedSecret },
    );

    expectFinding(result, {
      reason: "known-secret-env-value",
      path: "functions/api/mcp.func/index.js",
      line: 1,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(plantedSecret);
  });

  it("rejects client-facing static output", () => {
    const result = scanFixture((outputDir) => {
      writeFile(outputDir, "static/index.html", "<!doctype html>\n");
    });

    expectFinding(result, { reason: "client-static-asset", path: "static/index.html" });
  });

  it("rejects unreviewed function runtimes", () => {
    const result = scanFixture((outputDir) => {
      writeFunctionConfig(outputDir, { runtime: "nodejs26.x" });
    });

    expectFinding(result, {
      reason: "unexpected-vercel-runtime",
      path: "functions/api/mcp.func/.vc-config.json",
    });
  });

  it("labels source-map findings without mutating recorded reasons later", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.func/index.js.map",
        `${JSON.stringify({ sourcesContent: ['const marker = "NEXT_PUBLIC_B2_URL";'] })}\n`,
      );
    });

    expectFinding(result, {
      reason: "secret-bearing-source-map:client-public-env-marker",
      path: "functions/api/mcp.func/index.js.map",
      line: 1,
    });
  });
});
