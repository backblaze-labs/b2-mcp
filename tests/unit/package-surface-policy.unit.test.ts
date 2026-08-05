import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { spawnSync } from "child_process";

const root = join(__dirname, "../..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8")) as T;
}

function npmEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  return env;
}

function parseJsonArray(stdout: string) {
  return JSON.parse(stdout.slice(stdout.indexOf("["))) as Array<{
    files: Array<{ path: string }>;
  }>;
}

describe("package surface policy", () => {
  const pkg = readJson<{
    files: string[];
    exports: Record<string, unknown>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  }>("package.json");
  const toolContract = readJson<{
    profiles: Record<string, { fixtures: Record<string, string> }>;
  }>("docs/tool-profile-contract.json");
  const readme = readFileSync(join(root, "README.md"), "utf8");

  it("keeps repo-only policy files out of the published npm package", () => {
    const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--dry-run"], {
      cwd: root,
      encoding: "utf8",
      env: npmEnv(),
    });
    expect(packed.status).toBe(0);
    const files = parseJsonArray(packed.stdout)[0].files.map((file) => file.path);

    expect(pkg.files).not.toContain("runtime-policy.json");
    expect(pkg.files).not.toContain("audit-policy.json");
    expect(pkg.files).not.toContain("package-budget.json");
    expect(files).not.toContain("runtime-policy.json");
    expect(files).not.toContain("audit-policy.json");
    expect(files).not.toContain("package-budget.json");
    expect(files).toContain("package.json");
    expect(files).toContain("docs/tool-profile-contract.json");
    for (const fixturePath of Object.values(toolContract.profiles).flatMap((profile) =>
      Object.values(profile.fixtures),
    )) {
      expect(files).toContain(fixturePath);
    }
  });

  it("retries a transient lockfile-less packed-consumer install", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-smoke-npm-"));
    const state = join(dir, "install-attempts");
    const fakeNpm = join(dir, "npm");
    writeFileSync(
      fakeNpm,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "const args = process.argv.slice(2);",
        'if (args[0] === "pack") {',
        '  const destination = args[args.indexOf("--pack-destination") + 1];',
        '  const filename = "backblaze-labs-b2-mcp-0.1.0.tgz";',
        '  fs.writeFileSync(path.join(destination, filename), "fake tarball");',
        "  console.log(JSON.stringify([{ filename }]));",
        "  process.exit(0);",
        "}",
        'if (args[0] === "install") {',
        '  if (fs.existsSync(path.join(process.cwd(), "package-lock.json"))) {',
        '    console.error("packed consumer install should start without a lockfile");',
        "    process.exit(2);",
        "  }",
        `  const state = ${JSON.stringify(state)};`,
        "  let attempt = 0;",
        '  try { attempt = Number(fs.readFileSync(state, "utf8")); } catch {}',
        "  attempt += 1;",
        "  fs.writeFileSync(state, String(attempt));",
        "  if (process.env.B2_MASTER_KEY || process.env.GITHUB_TOKEN || process.env.NPM_TOKEN) {",
        '    console.error("sanitizer leaked a blocked env var");',
        "    process.exit(2);",
        "  }",
        "  if (attempt === 1) {",
        '    console.error("npm ERR! code EAI_AGAIN");',
        '    console.error("npm ERR! registry network timeout");',
        "    process.exit(1);",
        "  }",
        '  const packageRoot = path.join(process.cwd(), "node_modules", "@backblaze-labs", "b2-mcp");',
        '  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });',
        "  fs.writeFileSync(",
        '    path.join(packageRoot, "package.json"),',
        "    JSON.stringify({",
        '      name: "@backblaze-labs/b2-mcp",',
        '      main: "dist/index.js",',
        '      bin: { "b2-mcp": "dist/index.js" },',
        '      engines: { node: ">=22.3.0" }',
        "    }),",
        "  );",
        "  fs.writeFileSync(",
        '    path.join(packageRoot, "dist", "index.js"),',
        '    "module.exports = { startStdio() {} };\\nif (require.main === module) {\\n  if (process.env.B2_REGISTER_ALL_TOOLS !== \\"true\\") throw new Error(\\"missing B2_REGISTER_ALL_TOOLS\\");\\n  if (process.env.B2_MASTER_KEY) throw new Error(\\"leaked B2 secret\\");\\n  process.exit(1);\\n}\\n",',
        "  );",
        "  fs.writeFileSync(",
        '    path.join(packageRoot, "dist", "http-server.js"),',
        '    "module.exports = { buildHttpServer() {} };\\n",',
        "  );",
        "  fs.writeFileSync(",
        '    path.join(packageRoot, "dist", "server.js"),',
        "    [",
        '      "const allTools = {};\\n",',
        '      "for (let i = 0; i < 37; i += 1) allTools[`b2_fixture_${i}`] = {};\\n",',
        '      "allTools.b2_create_key = { execute: async () => ({ content: [{ text: \\"tool_unavailable\\" }] }) };\\n",',
        '      "allTools.s3_get_object = { inputSchema: { safeParse: () => ({ success: true }) } };\\n",',
        '      "allTools.s3_delete_object = {};\\n",',
        '      "function createServer(_config, capabilities) { return { capabilities, close: async () => {} }; }\\n",',
        '      "function getRegisteredTools(server) {\\n",',
        '      "  if (Array.isArray(server.capabilities)) {\\n",',
        '      "    return { b2_create_key: allTools.b2_create_key, s3_get_object: allTools.s3_get_object };\\n",',
        '      "  }\\n",',
        '      "  return allTools;\\n",',
        '      "}\\n",',
        '      "module.exports = { createServer, getRegisteredTools };\\n",',
        '    ].join(""),',
        "  );",
        "  process.exit(0);",
        "}",
        'console.error(`unexpected npm command: ${args.join(" ")}`);',
        "process.exit(2);",
      ].join("\n"),
    );
    chmodSync(fakeNpm, 0o755);

    try {
      const result = spawnSync(process.execPath, ["scripts/packed-consumer-smoke.mjs"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("packed-consumer-smoke: retrying npm install");
      expect(result.stdout).toContain(
        "packed-consumer-smoke: installed and exercised runtime compatibility",
      );
      expect(readFileSync(state, "utf8")).toBe("2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the runtime-sensitive circuit breaker dependency exact-pinned", () => {
    expect(pkg.dependencies.opossum).toBe("10.0.0");
    expect(pkg.dependencies.opossum).not.toMatch(/^[~^*]|x$/i);
  });

  it("documents the intentionally narrow package export surface", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./package.json"]);
    expect(readme).toContain("Package API Surface");
    expect(readme).toContain("root CommonJS entry");
    expect(readme).toContain("startStdio");
    expect(readme).toContain("Deep imports");
    expect(readme).toContain("private implementation details");
  });

  it("exact-pins runtime-sensitive lint and typing packages", () => {
    for (const name of ["@biomejs/biome", "@types/node"]) {
      expect(pkg.devDependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
