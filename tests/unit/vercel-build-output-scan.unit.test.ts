import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { root } from "../contract/support";

const scannerPath = path.join(root, "scripts/check-vercel-build-output.mjs");
const reviewedRuntime = "nodejs24.x";
const plantedSecret = "K005abcdefghijklmnopqr";
const mainFunctionConfigPath = "functions/api/mcp.js.func/.vc-config.json";
const requiredFunctionConfigPaths = [
  "functions/api/health.js.func/.vc-config.json",
  mainFunctionConfigPath,
  "functions/api/oauth-authorization-server.js.func/.vc-config.json",
  "functions/api/oauth-protected-resource.js.func/.vc-config.json",
];

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
  relativePath = mainFunctionConfigPath,
): void {
  writeFile(outputDir, relativePath, `${JSON.stringify(config, null, 2)}\n`);
}

function writeOutputConfig(outputDir: string, routes = requiredRoutes()): void {
  writeFile(
    outputDir,
    "config.json",
    `${JSON.stringify({ version: 3, routes: [{ handle: "filesystem" }, ...routes] }, null, 2)}\n`,
  );
}

function requiredRoutes(): Array<{ src: string; dest: string; check: boolean }> {
  return [
    { src: "^/mcp$", dest: "/api/mcp", check: true },
    { src: "^/health$", dest: "/api/health", check: true },
    {
      src: "^/\\.well-known/oauth-protected-resource/mcp$",
      dest: "/api/oauth-protected-resource",
      check: true,
    },
    {
      src: "^/\\.well-known/oauth-protected-resource$",
      dest: "/api/oauth-protected-resource",
      check: true,
    },
    {
      src: "^/\\.well-known/oauth-authorization-server$",
      dest: "/api/oauth-authorization-server",
      check: true,
    },
  ];
}

function writeRequiredOutput(outputDir: string): void {
  writeOutputConfig(outputDir);
  for (const configPath of requiredFunctionConfigPaths) {
    writeFunctionConfig(outputDir, { runtime: reviewedRuntime }, configPath);
  }
}

function scanFixture(
  mutate: (outputDir: string) => void,
  extraEnv: Record<string, string> = {},
): ScanResult {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "b2-mcp-vercel-scan-"));
  const outputDir = path.join(tmpDir, "output");
  const reportsDir = path.join(tmpDir, "reports");
  mkdirSync(outputDir, { recursive: true });
  writeRequiredOutput(outputDir);
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
        "functions/api/mcp.js.func/node_modules/@modelcontextprotocol/sdk/package.json",
        `${JSON.stringify({ name: "@modelcontextprotocol/sdk", version: "2.0.0" })}\n`,
      );
    });

    expect(result.status).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.inventory.scannedFiles).toBeGreaterThanOrEqual(6);
    expect(result.inventory.functions).toEqual(requiredFunctionConfigPaths);
    expect(result.inventory.functionConfigs).toEqual(
      requiredFunctionConfigPaths.map((configPath) => ({
        path: configPath,
        runtime: reviewedRuntime,
        hasEnvironment: false,
      })),
    );
  });

  it("does not treat dependency package paths as generic entropy leaks", () => {
    const dependencyLikeToken = "9f3c8b1d5e7a4c2f0b6d8e1a3c5f7b9d";
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.js.func/node_modules/.pnpm/@aws-sdk+s3-request-presigner@3.1103.0/node_modules/@aws-sdk/s3-request-presigner/dist-cjs/index.js",
        `const checksumFixture = "${dependencyLikeToken}";\n`,
      );
    });

    expect(result.status).toBe(0);
    expect(result.findings).toEqual([]);
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
        "functions/api/mcp.js.func/index.js",
        'const name = "NEXT_PUBLIC_B2_URL";\n',
      );
    });

    expectFinding(result, {
      reason: "client-public-env-marker",
      path: "functions/api/mcp.js.func/index.js",
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
      path: "functions/api/mcp.js.func/.vc-config.json",
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(plantedSecret);
  });

  it("rejects and redacts secret-bearing output paths", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        `functions/api/${plantedSecret}.func/.vc-config.json`,
        `${JSON.stringify({ runtime: reviewedRuntime })}\n`,
      );
    });

    expectFinding(result, {
      reason: "secret-bearing-output-path",
      path: "functions/api/[REDACTED_SECRET].func/.vc-config.json",
    });
    expect(JSON.stringify(result.findings)).not.toContain(plantedSecret);
    expect(JSON.stringify(result.inventory)).not.toContain(plantedSecret);
    expect(`${result.stdout}${result.stderr}`).not.toContain(plantedSecret);
  });

  it("rejects malformed function config JSON", () => {
    const result = scanFixture((outputDir) => {
      writeFile(outputDir, "functions/api/mcp.js.func/.vc-config.json", "{not-json");
    });

    expectFinding(result, {
      reason: "invalid-function-config-json",
      path: "functions/api/mcp.js.func/.vc-config.json",
    });
  });

  it("rejects runtime MCP SDK v1 packages but allows v2 packages", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.js.func/node_modules/@modelcontextprotocol/sdk/package.json",
        `${JSON.stringify({ name: "@modelcontextprotocol/sdk", version: "1.2.0" })}\n`,
      );
    });

    expectFinding(result, {
      reason: "runtime-mcp-sdk-v1-bundle",
      path: "functions/api/mcp.js.func/node_modules/@modelcontextprotocol/sdk/package.json",
    });
  });

  it("rejects secret-shaped bracket env assignments", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.js.func/index.js",
        `const env = process.env;\nprocess.env["B2_APPLICATION_KEY"] = "${plantedSecret}";\n`,
      );
    });

    expectFinding(result, {
      reason: "secret-shaped-assignment",
      path: "functions/api/mcp.js.func/index.js",
      line: 2,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(plantedSecret);
  });

  it("rejects secret-shaped LIVE_B2 assignments", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.js.func/index.js",
        `LIVE_B2_APPLICATION_KEY = "${plantedSecret}";\n`,
      );
    });

    expectFinding(result, {
      reason: "secret-shaped-assignment",
      path: "functions/api/mcp.js.func/index.js",
      line: 1,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(plantedSecret);
  });

  it("rejects generic secret-shaped assignments", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.js.func/index.js",
        `const client_secret = "${plantedSecret}";\n`,
      );
    });

    expectFinding(result, {
      reason: "secret-shaped-assignment",
      path: "functions/api/mcp.js.func/index.js",
      line: 1,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(plantedSecret);
  });

  it("rejects backtick-delimited secret-shaped assignments", () => {
    const backtickSecret = "opaque-backtick-secret-0123456789";
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.js.func/index.js",
        [
          `const OAUTH_CLIENT_SECRET = \`${backtickSecret}\`;`,
          `const bypass = { "x-vercel-protection-bypass": \`${backtickSecret}\` };`,
          "",
        ].join("\n"),
      );
    });

    expectFinding(result, {
      reason: "secret-shaped-assignment",
      path: "functions/api/mcp.js.func/index.js",
      line: 1,
    });
    expectFinding(result, {
      reason: "vercel-bypass-literal",
      path: "functions/api/mcp.js.func/index.js",
      line: 2,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(backtickSecret);
  });

  it("rejects opaque Authorization literals", () => {
    const opaqueAuthorization = "opaque-authorization-value-0123456789";
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.js.func/index.js",
        [
          `const authorization = "${opaqueAuthorization}";`,
          `const headers = { "Authorization": "${opaqueAuthorization}" };`,
          "",
        ].join("\n"),
      );
    });

    expectFinding(result, {
      reason: "secret-shaped-assignment",
      path: "functions/api/mcp.js.func/index.js",
      line: 1,
    });
    expectFinding(result, {
      reason: "secret-shaped-assignment",
      path: "functions/api/mcp.js.func/index.js",
      line: 2,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(opaqueAuthorization);
  });

  it("rejects bearer token literals", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.js.func/index.js",
        `const authorization = "Bearer ${plantedSecret}";\n`,
      );
    });

    expectFinding(result, {
      reason: "bearer-token-literal",
      path: "functions/api/mcp.js.func/index.js",
      line: 1,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(plantedSecret);
  });

  it("rejects bare B2 application key literals without seeded env", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.js.func/index.js",
        `const leaked = "${plantedSecret}";\n`,
      );
    });

    expectFinding(result, {
      reason: "b2-application-key-literal",
      path: "functions/api/mcp.js.func/index.js",
      line: 1,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(plantedSecret);
  });

  it("rejects opaque high-entropy literals under minified identifiers", () => {
    const opaqueSecret = "9f3c8b1d5e7a4c2f0b6d8e1a3c5f7b9d";
    const result = scanFixture((outputDir) => {
      writeFile(outputDir, "functions/api/mcp.js.func/index.js", `const a="${opaqueSecret}";\n`);
    });

    expectFinding(result, {
      reason: "high-entropy-secret-literal",
      path: "functions/api/mcp.js.func/index.js",
      line: 1,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(opaqueSecret);
  });

  it("rejects Vercel bypass literals", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.js.func/index.js",
        `const headers = { "x-vercel-protection-bypass": "${plantedSecret}" };\n`,
      );
    });

    expectFinding(result, {
      reason: "vercel-bypass-literal",
      path: "functions/api/mcp.js.func/index.js",
      line: 1,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(plantedSecret);
  });

  it("rejects exact known secret values when a sensitive env var is seeded", () => {
    const result = scanFixture(
      (outputDir) => {
        writeFile(
          outputDir,
          "functions/api/mcp.js.func/index.js",
          `const leaked = "${plantedSecret}";\n`,
        );
      },
      { B2_APPLICATION_KEY: plantedSecret },
    );

    expectFinding(result, {
      reason: "known-secret-env-value",
      path: "functions/api/mcp.js.func/index.js",
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
      path: "functions/api/mcp.js.func/.vc-config.json",
    });
  });

  it("rejects missing required function outputs", () => {
    const result = scanFixture((outputDir) => {
      rmSync(path.join(outputDir, "functions/api/mcp.js.func"), {
        recursive: true,
        force: true,
      });
    });

    expectFinding(result, {
      reason: "missing-required-vercel-function-output",
      path: "functions/api/mcp.js.func/.vc-config.json",
    });
  });

  it("rejects missing required Vercel route bindings", () => {
    const result = scanFixture((outputDir) => {
      writeOutputConfig(
        outputDir,
        requiredRoutes().filter((route) => route.dest !== "/api/mcp"),
      );
    });

    expectFinding(result, {
      reason: "missing-required-vercel-route:/api/mcp",
      path: "config.json",
    });
  });

  it("rejects inlined SDK v1 bundle markers", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.js.func/index.js",
        'const pkg = { name: "@modelcontextprotocol/sdk", version: "1.2.0" };\n',
      );
    });

    expectFinding(result, {
      reason: "runtime-mcp-sdk-v1-bundle",
      path: "functions/api/mcp.js.func/index.js",
      line: 1,
    });
  });

  it("rejects symlinks in Vercel output", () => {
    const result = scanFixture((outputDir) => {
      const target = path.join(outputDir, "secret.env");
      writeFileSync(target, "B2_APPLICATION_KEY=not-scanned\n");
      symlinkSync(target, path.join(outputDir, "functions/api/mcp.js.func/secret-link.js"));
    });

    expectFinding(result, {
      reason: "symlink-in-output",
      path: "functions/api/mcp.js.func/secret-link.js",
    });
  });

  it("labels source-map findings without mutating recorded reasons later", () => {
    const result = scanFixture((outputDir) => {
      writeFile(
        outputDir,
        "functions/api/mcp.js.func/index.js.map",
        `${JSON.stringify({ sourcesContent: ['const marker = "NEXT_PUBLIC_B2_URL";'] })}\n`,
      );
    });

    expectFinding(result, {
      reason: "secret-bearing-source-map:client-public-env-marker",
      path: "functions/api/mcp.js.func/index.js.map",
      line: 1,
    });
  });
});
