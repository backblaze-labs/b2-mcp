import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { spawnSync } from "child_process";

const root = join(__dirname, "../..");
const nodeRequire = createRequire(__filename);
const { npmInvocation } = nodeRequire("../../scripts/lib/retry-utils.cjs") as {
  npmInvocation: (args: string[]) => { command: string; args: string[] };
};

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
    const npmPack = npmInvocation(["pack", "--json", "--ignore-scripts", "--dry-run"]);
    const packed = spawnSync(npmPack.command, npmPack.args, {
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
    expect(files).toContain("docs/CLIENTS.md");
    expect(files).toContain("docs/DEPLOY.md");
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
        '  fs.mkdirSync(path.join(packageRoot, "docs"), { recursive: true });',
        '  fs.mkdirSync(path.join(process.cwd(), "node_modules", ".bin"), { recursive: true });',
        "  fs.writeFileSync(",
        '    path.join(packageRoot, "package.json"),',
        "    JSON.stringify({",
        '      name: "@backblaze-labs/b2-mcp",',
        '      version: "0.1.0",',
        '      main: "dist/index.js",',
        '      bin: { "b2-mcp": "dist/index.js", "b2-mcp-server": "dist/index.js" },',
        '      engines: { node: ">=22.3.0" }',
        "    }),",
        "  );",
        '  fs.writeFileSync(path.join(packageRoot, "docs", "CLIENTS.md"), "# Clients\\n");',
        '  fs.writeFileSync(path.join(packageRoot, "docs", "DEPLOY.md"), "# Deploy\\n");',
        "  fs.writeFileSync(",
        '    path.join(packageRoot, "dist", "index.js"),',
        "    [",
        '      "#!/usr/bin/env node\\n",',
        '      "const http = require(\\"node:http\\");\\n",',
        '      "const version = \\"0.1.0\\";\\n",',
        '      "function rpc(raw) {\\n",',
        '      "  const req = JSON.parse(raw);\\n",',
        '      "  if (req.method === \\"server/discover\\") return { jsonrpc: \\"2.0\\", id: req.id, result: { supportedVersions: [\\"2026-07-28\\"], capabilities: { tools: {} }, _meta: { \\"io.modelcontextprotocol/serverInfo\\": { name: \\"backblaze-b2\\", version } } } };\\n",',
        '      "  if (req.method === \\"initialize\\") return { jsonrpc: \\"2.0\\", id: req.id, result: { protocolVersion: req.params.protocolVersion, serverInfo: { name: \\"backblaze-b2\\", version }, capabilities: { tools: {} } } };\\n",',
        '      "  if (req.method === \\"tools/list\\") return { jsonrpc: \\"2.0\\", id: req.id, result: { tools: [{ name: \\"b2_list_buckets\\", inputSchema: { type: \\"object\\" } }, { name: \\"b2_create_key\\", inputSchema: { type: \\"object\\" } }] } };\\n",',
        '      "  if (req.method === \\"tools/call\\") return { jsonrpc: \\"2.0\\", id: req.id, result: { isError: true, content: [{ type: \\"text\\", text: \\"tool_unavailable\\" }] } };\\n",',
        '      "  return { jsonrpc: \\"2.0\\", id: req.id, error: { code: -32601, message: \\"not found\\" } };\\n",',
        '      "}\\n",',
        '      "function main() {\\n",',
        '      "  const args = process.argv.slice(2);\\n",',
        '      "  if (args.includes(\\"--help\\")) { console.log(\\"Usage: b2-mcp [stdio|http] [options]\\\\n--transport <stdio|http>\\\\n--version\\"); return; }\\n",',
        '      "  if (args.includes(\\"--version\\")) { console.log(version); return; }\\n",',
        '      "  if (args.includes(\\"--transport\\") && args[args.indexOf(\\"--transport\\") + 1] === \\"http\\") {\\n",',
        '      "    const port = Number(args[args.indexOf(\\"--port\\") + 1]);\\n",',
        '      "    http.createServer((req, res) => {\\n",',
        '      "      if (req.method === \\"GET\\" && req.url === \\"/health\\") { res.writeHead(200, { \\"content-type\\": \\"application/json\\" }); res.end(JSON.stringify({ status: \\"ok\\", server: \\"backblaze-b2-mcp\\", version })); return; }\\n",',
        '      "      let body = \\"\\"; req.on(\\"data\\", c => body += c); req.on(\\"end\\", () => { res.writeHead(200, { \\"content-type\\": \\"application/json\\" }); res.end(JSON.stringify(rpc(body))); });\\n",',
        '      "    }).listen(port, \\"127.0.0.1\\");\\n",',
        '      "    return;\\n",',
        '      "  }\\n",',
        '      "  if (!process.env.B2_APPLICATION_KEY_ID || !process.env.B2_APPLICATION_KEY) { console.error(\\"b2-mcp: B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY are required for stdio\\"); process.exit(1); }\\n",',
        '      "  let buffer = \\"\\"; process.stdin.on(\\"data\\", chunk => { buffer += chunk; for (;;) { const i = buffer.indexOf(\\"\\\\n\\"); if (i === -1) break; const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); if (line) process.stdout.write(JSON.stringify(rpc(line)) + \\"\\\\n\\"); } });\\n",',
        '      "}\\n",',
        '      "module.exports = { startStdio() {}, main };\\n",',
        '      "if (require.main === module) main();\\n",',
        '    ].join(""),',
        "  );",
        '  fs.chmodSync(path.join(packageRoot, "dist", "index.js"), 0o755);',
        '  for (const name of ["b2-mcp", "b2-mcp-server"]) {',
        '    const bin = path.join(process.cwd(), "node_modules", ".bin", name);',
        '    fs.writeFileSync(bin, "#!/usr/bin/env node\\nrequire(\\"../@backblaze-labs/b2-mcp/dist/index.js\\").main();\\n");',
        "    fs.chmodSync(bin, 0o755);",
        "  }",
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
