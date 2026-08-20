import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
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

function npmPackDryRunFiles(cwd = root): string[] {
  const npmPack = npmInvocation(["pack", "--json", "--ignore-scripts", "--dry-run"]);
  const packed = spawnSync(npmPack.command, npmPack.args, {
    cwd,
    encoding: "utf8",
    env: npmEnv(),
  });
  expect(packed.status).toBe(0);
  return parseJsonArray(packed.stdout)[0].files.map((file) => file.path);
}

function dockerIgnoreMatcher(patternText: string): (relativePath: string) => boolean {
  // Best-effort local invariant for the simple checked-in patterns below. It is
  // not a complete Docker .dockerignore parser.
  const patterns = patternText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  function globToRegExp(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*");
    return new RegExp(`^${escaped}$`);
  }

  return (relativePath: string): boolean => {
    const path = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    return patterns.some((rawPattern) => {
      const pattern = rawPattern.replace(/^\/+/, "");
      if (pattern.endsWith("/")) {
        const prefix = pattern;
        return path === prefix.slice(0, -1) || path.startsWith(prefix);
      }
      if (pattern.includes("*")) return globToRegExp(pattern).test(path);
      // A bare directory/file pattern (e.g. `dist`) matches the entry itself
      // and every descendant, at the root or nested, mirroring how Docker
      // excludes a directory's whole subtree.
      return (
        path === pattern ||
        path.startsWith(`${pattern}/`) ||
        path.endsWith(`/${pattern}`) ||
        path.includes(`/${pattern}/`)
      );
    });
  };
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
  const skillsPack = readJson<{
    packageFiles: string[];
  }>("skills/pack.json");
  const readme = readFileSync(join(root, "README.md"), "utf8");

  it("keeps repo-only policy files out of the published npm package", () => {
    const files = npmPackDryRunFiles();

    expect(pkg.files).not.toContain("runtime-policy.json");
    expect(pkg.files).not.toContain("audit-policy.json");
    expect(pkg.files).not.toContain("package-budget.json");
    expect(pkg.files).not.toContain("deploy/customer-hosted/**/*");
    expect(files).not.toContain("runtime-policy.json");
    expect(files).not.toContain("audit-policy.json");
    expect(files).not.toContain("package-budget.json");
    expect(files).toContain(".dockerignore");
    expect(files).toContain("package.json");
    expect(files).toContain("deploy/customer-hosted/.dockerignore");
    expect(files).toContain("deploy/customer-hosted/Dockerfile");
    expect(files).toContain("deploy/customer-hosted/README.md");
    expect(files).toContain("deploy/customer-hosted/b2-mcp.env.example");
    expect(files).toContain("deploy/customer-hosted/container-entrypoint.sh");
    expect(files).toContain("deploy/customer-hosted/docker-compose.yml");
    expect(files).toContain("deploy/customer-hosted/nginx.conf");
    expect(files).toContain("deploy/customer-hosted/pnpm-lock.yaml");
    expect(files).toContain("deploy/customer-hosted/pnpm-workspace.yaml");
    expect(files).toContain("docs/AUTHENTICATION.md");
    expect(files).toContain("docs/CLIENTS.md");
    expect(files).toContain("docs/DEPLOY.md");
    expect(files).toContain("docs/tool-profile-contract.json");
    expect(pkg.files.filter((file) => file.startsWith("skills/"))).toEqual(skillsPack.packageFiles);
    for (const skillPath of skillsPack.packageFiles) {
      expect(files).toContain(skillPath);
    }
    expect(files.filter((file) => file.startsWith("skills/")).sort()).toEqual(
      [...skillsPack.packageFiles].sort(),
    );
    for (const fixturePath of Object.values(toolContract.profiles).flatMap((profile) =>
      Object.values(profile.fixtures),
    )) {
      expect(files).toContain(fixturePath);
    }
  });

  it("keeps packaged deployment lockfiles mirrored from the reviewed lockfiles", () => {
    expect(readFileSync(join(root, "deploy/customer-hosted/pnpm-lock.yaml"), "utf8")).toBe(
      readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
    );
    expect(readFileSync(join(root, "deploy/customer-hosted/pnpm-workspace.yaml"), "utf8")).toBe(
      readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"),
    );
  });

  it("treats deployment secret-file env values as literal paths", () => {
    const entrypointPath = join(root, "deploy/customer-hosted/container-entrypoint.sh");
    const entrypoint = readFileSync(entrypointPath, "utf8");
    const tempRoot = mkdtempSync(join(tmpdir(), "b2-mcp-entrypoint-"));
    const binDir = join(tempRoot, "bin");
    const fakeServer = join(binDir, "b2-mcp-server");
    const secretPath = join(tempRoot, "secret-$(touch exploited)");
    const exploitedPath = join(tempRoot, "exploited");

    try {
      expect(entrypoint).not.toMatch(/\beval\b/);
      expect(entrypoint).toContain('printenv "$file_var"');
      expect(entrypoint).toContain('printenv "$var_name"');

      mkdirSync(binDir);
      writeFileSync(secretPath, "literal-secret-value");
      writeFileSync(fakeServer, "#!/bin/sh\nprintf '%s' \"$B2_APPLICATION_KEY\"\n");
      chmodSync(fakeServer, 0o755);

      const result = spawnSync("sh", [entrypointPath, "--probe"], {
        cwd: tempRoot,
        encoding: "utf8",
        env: {
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          B2_APPLICATION_KEY_FILE: secretPath,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("literal-secret-value");
      expect(result.stderr).toBe("");
      expect(existsSync(exploitedPath)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("excludes local deployment secrets from npm pack and Docker build contexts", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "b2-mcp-package-surface-"));
    const deployRoot = join(tempRoot, "deploy/customer-hosted");
    const localSecretPaths = [
      "b2-mcp.env",
      ".env",
      ".env.local",
      ".env.production",
      "secrets/b2_application_key_id",
      "secrets/b2_application_key",
      "fullchain.pem",
      "certs/fullchain.pem",
      "tls/client.key",
      "tls/client.crt",
      "tls/client.p12",
    ];
    const rootSecretPaths = [
      ".env.production",
      "secrets/b2_application_key",
      "certs/fullchain.pem",
      "tls/client.p12",
      "private.key",
    ];

    try {
      mkdirSync(deployRoot, { recursive: true });
      mkdirSync(join(tempRoot, "secrets"), { recursive: true });
      mkdirSync(join(tempRoot, "certs"), { recursive: true });
      mkdirSync(join(tempRoot, "tls"), { recursive: true });
      mkdirSync(join(deployRoot, "secrets"), { recursive: true });
      mkdirSync(join(deployRoot, "certs"), { recursive: true });
      mkdirSync(join(deployRoot, "tls"), { recursive: true });
      writeFileSync(
        join(tempRoot, "package.json"),
        readFileSync(join(root, "package.json"), "utf8"),
      );
      writeFileSync(
        join(tempRoot, ".dockerignore"),
        readFileSync(join(root, ".dockerignore"), "utf8"),
      );
      for (const fileName of [
        ".dockerignore",
        "Dockerfile",
        "README.md",
        "b2-mcp.env.example",
        "container-entrypoint.sh",
        "docker-compose.yml",
        "nginx.conf",
      ]) {
        writeFileSync(
          join(deployRoot, fileName),
          readFileSync(join(root, "deploy/customer-hosted", fileName), "utf8"),
        );
      }
      for (const relativePath of localSecretPaths) {
        writeFileSync(join(deployRoot, relativePath), "local-secret-test-value");
      }
      for (const relativePath of rootSecretPaths) {
        writeFileSync(join(tempRoot, relativePath), "root-secret-test-value");
      }

      const files = npmPackDryRunFiles(tempRoot);
      for (const relativePath of localSecretPaths) {
        expect(files).not.toContain(`deploy/customer-hosted/${relativePath}`);
      }
      for (const relativePath of rootSecretPaths) {
        expect(files).not.toContain(relativePath);
      }
      expect(files).toContain("deploy/customer-hosted/b2-mcp.env.example");

      const isDockerIgnored = dockerIgnoreMatcher(
        readFileSync(join(deployRoot, ".dockerignore"), "utf8"),
      );
      const isRootDockerIgnored = dockerIgnoreMatcher(
        readFileSync(join(tempRoot, ".dockerignore"), "utf8"),
      );
      for (const relativePath of localSecretPaths) {
        expect(isDockerIgnored(relativePath)).toBe(true);
        expect(isRootDockerIgnored(`deploy/customer-hosted/${relativePath}`)).toBe(true);
      }
      for (const relativePath of rootSecretPaths) {
        expect(isRootDockerIgnored(relativePath)).toBe(true);
      }
      expect(isDockerIgnored("b2-mcp.env.example")).toBe(false);
      expect(isDockerIgnored("Dockerfile")).toBe(false);
      expect(isDockerIgnored("nginx.conf")).toBe(false);
      expect(isRootDockerIgnored("package.json")).toBe(false);
      expect(isRootDockerIgnored("dist/index.js")).toBe(false);
      expect(isRootDockerIgnored("deploy/customer-hosted/pnpm-lock.yaml")).toBe(false);
      expect(isRootDockerIgnored("deploy/customer-hosted/b2-mcp.env.example")).toBe(false);
      expect(isRootDockerIgnored("deploy/customer-hosted/Dockerfile")).toBe(false);
      expect(isRootDockerIgnored("deploy/customer-hosted/nginx.conf")).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("pins customer-hosted images and deployment policy knobs", () => {
    const dockerfile = readFileSync(join(root, "deploy/customer-hosted/Dockerfile"), "utf8");
    const compose = readFileSync(join(root, "deploy/customer-hosted/docker-compose.yml"), "utf8");
    const nginx = readFileSync(join(root, "deploy/customer-hosted/nginx.conf"), "utf8");
    const envExample = readFileSync(
      join(root, "deploy/customer-hosted/b2-mcp.env.example"),
      "utf8",
    );
    const deployReadme = readFileSync(join(root, "deploy/customer-hosted/README.md"), "utf8");
    const deployDoc = readFileSync(join(root, "docs/DEPLOY.md"), "utf8");

    expect(
      dockerfile.match(/^FROM node:22\.23\.1-bookworm-slim@sha256:[a-f0-9]{64}.*$/gm),
    ).toHaveLength(2);
    expect(compose).toMatch(/image: nginx:1\.29-alpine@sha256:[a-f0-9]{64}/);
    expect(dockerfile).not.toMatch(/^ARG B2_MCP_VERSION=/m);
    expect(dockerfile).toContain('test -n "$B2_MCP_VERSION"');
    expect(dockerfile).toContain(
      "COPY package.json deploy/customer-hosted/pnpm-lock.yaml deploy/customer-hosted/pnpm-workspace.yaml ./",
    );
    expect(dockerfile).toContain("pnpm install --prod --frozen-lockfile --ignore-scripts");
    expect(dockerfile).toContain("chmod 0555 /usr/local/lib/b2-mcp/dist/index.js");
    expect(dockerfile).not.toContain("npm install -g");
    expect(dockerfile).not.toContain("@backblaze-labs/b2-mcp@${B2_MCP_VERSION}");
    expect(compose).toContain("context: ../..");
    expect(compose).toContain("dockerfile: deploy/customer-hosted/Dockerfile");
    expect(compose).toContain("B2_MCP_VERSION: ${B2_MCP_VERSION:?");
    expect(compose).not.toContain("B2_MCP_VERSION:-");
    for (const text of [dockerfile, compose, deployReadme, deployDoc]) {
      expect(text).not.toMatch(/B2_MCP_VERSION=0\.1\.0|b2-mcp@0\.1\.0/);
    }

    expect(nginx).toContain("resolver 127.0.0.11 ipv6=off valid=10s;");
    expect(nginx).toContain("zone b2_mcp_backend 64k;");
    expect(nginx).toMatch(/server b2-mcp-a:3000 resolve /);
    expect(nginx).toMatch(/server b2-mcp-b:3000 resolve /);
    expect(nginx).toMatch(
      /location\s+=\s+\/_oauth2\/validate\s+\{[\s\S]*proxy_connect_timeout\s+\d+s;/,
    );
    expect(nginx).toMatch(
      /location\s+=\s+\/_oauth2\/validate\s+\{[\s\S]*proxy_send_timeout\s+\d+s;/,
    );
    expect(nginx).toMatch(
      /location\s+=\s+\/_oauth2\/validate\s+\{[\s\S]*proxy_read_timeout\s+\d+s;/,
    );
    expect(nginx).toContain("error_page 500 502 503 504 = @oauth_unavailable;");

    expect(compose).not.toContain("condition: service_healthy");
    for (const capability of ["CHOWN", "NET_BIND_SERVICE", "SETGID", "SETUID"]) {
      expect(compose).toContain(`- ${capability}`);
    }
    expect(compose).toContain('driver: "json-file"');
    expect(compose).toContain("logging: *bounded-logging");
    expect(compose).not.toContain("/etc/letsencrypt:/etc/letsencrypt:ro");
    expect(compose).toContain(
      "/etc/letsencrypt/live/mcp.example.com:/etc/letsencrypt/live/mcp.example.com:ro",
    );
    expect(compose).toContain(
      "/etc/letsencrypt/archive/mcp.example.com:/etc/letsencrypt/archive/mcp.example.com:ro",
    );
    expect(nginx).toContain('proxy_set_header Connection "";');
    expect(nginx).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
    expect(nginx).toContain("proxy_set_header Content-Type $http_content_type;");
    expect(nginx).not.toContain("proxy_set_header Content-Type $content_type;");

    expect(envExample).toContain("B2_ALLOWED_HOSTS=mcp.example.com");
    expect(envExample).toContain("B2_ALLOWED_ORIGINS=https://client.example.com");
    expect(nginx).toContain('"https://client.example.com" 1;');
    expect(envExample).toContain("aggregate traffic per replica");
    expect(deployReadme).toContain("aggregate per-replica caps");
    expect(deployReadme).toContain("chmod 700 secrets");
    expect(deployReadme).toContain(
      "chmod 0444 secrets/b2_application_key_id secrets/b2_application_key",
    );
    expect(deployReadme).not.toContain(
      "chmod 600 secrets/b2_application_key_id secrets/b2_application_key",
    );
    expect(deployDoc).toContain("canonical source for build/run steps");
    expect(deployDoc).toContain("deploy/customer-hosted/README.md");
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
        '  fs.writeFileSync(path.join(packageRoot, "dist", "index.js"), "module.exports = { startStdio() {} };\\n");',
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
          NODE_ENV: "test",
          B2_MCP_PACKED_CONSUMER_INSTALL_ONLY: "1",
          PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("packed-consumer-smoke: retrying npm install");
      expect(result.stdout).toContain("packed-consumer-smoke: installed package metadata");
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
    expect(readme).toContain("consumers may compile against that same root CommonJS surface");
    expect(readme).toContain("Programmatic TypeScript imports beyond that root entry");
    expect(readme).toContain("startStdio");
    expect(readme).toContain("Deep imports");
    expect(readme).toContain("private implementation details");
    expect(readme).not.toContain("before the 0.1 release");
  });

  it("exact-pins runtime-sensitive lint and typing packages", () => {
    for (const name of ["@biomejs/biome", "@types/node"]) {
      expect(pkg.devDependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
