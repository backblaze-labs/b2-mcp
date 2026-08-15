#!/usr/bin/env node
import { createServer } from "net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import os from "os";
import { createRequire } from "module";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const {
  WORKER_SOURCE_GRAPH_BYTES_BUDGET,
  WORKER_SOURCE_GRAPH_FILES_BUDGET,
  collectLocalImportGraph,
  parseJsoncObject,
} = require("./lib/local-import-graph.cjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = path.join(root, "reports", "cloudflare-worker-bundle");
const wranglerConfigPath = path.join(root, "deploy/cloudflare-worker/wrangler.jsonc");
const entrypoints = ["deploy/cloudflare-worker/worker.ts"];

function fail(message) {
  console.error(`cloudflare-worker-bundle: ${message}`);
  process.exit(1);
}

function validateWranglerConfig(config) {
  const compatibilityDate = config.compatibility_date;
  const compatibilityFlags = Array.isArray(config.compatibility_flags)
    ? config.compatibility_flags
    : [];
  if (typeof compatibilityDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate)) {
    fail("wrangler.jsonc must pin a YYYY-MM-DD compatibility_date");
  }
  if (!compatibilityFlags.includes("nodejs_compat")) {
    fail("wrangler.jsonc must enable nodejs_compat for the shared Node-aware modules");
  }
  return { compatibilityDate, compatibilityFlags };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") reject(new Error("Unable to reserve port"));
        else resolve(address.port);
      });
    });
  });
}

function workerSmokeVars(port) {
  const publicUrl = `https://mcp.example.com/mcp`;
  return {
    B2_HTTP_CREDENTIAL_MODE: "server",
    B2_APPLICATION_KEY_ID: "worker-smoke-key-id",
    B2_APPLICATION_KEY: "worker-smoke-application-key",
    B2_ALLOWED_HOSTS: `127.0.0.1:${port},127.0.0.1,localhost,mcp.example.com`,
    B2_DESTRUCTIVE_POLICY: "block",
    B2_REGISTER_ALL_TOOLS: "false",
    B2_ALLOW_LOCAL_FILES: "false",
    B2_MCP_PUBLIC_URL: publicUrl,
    B2_OAUTH_ISSUER: "https://issuer.example.com/",
    B2_OAUTH_AUTHORIZATION_ENDPOINT: "https://issuer.example.com/oauth2/authorize",
    B2_OAUTH_TOKEN_ENDPOINT: "https://issuer.example.com/oauth2/token",
    B2_OAUTH_INTROSPECTION_ENDPOINT: "https://issuer.example.com/oauth2/introspect",
    B2_OAUTH_INTROSPECTION_CLIENT_ID: "worker-smoke-client",
    B2_OAUTH_INTROSPECTION_CLIENT_SECRET: "worker-smoke-secret",
    B2_OAUTH_RESOURCE: publicUrl,
    B2_OAUTH_AUDIENCE: publicUrl,
    B2_OAUTH_ALLOWED_SUBJECTS: "worker-smoke-subject",
  };
}

function wranglerEnv(baseEnv) {
  const env = { ...baseEnv, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" };
  delete env.FORCE_COLOR;
  return env;
}

async function runWranglerStartupSmoke(config) {
  const port = await freePort();
  const workspace = mkdtempSync(path.join(os.tmpdir(), "b2-mcp-worker-smoke-"));
  const smokeConfigPath = path.join(workspace, "wrangler.jsonc");
  const runtimeConfig = { ...config };
  delete runtimeConfig.secrets;
  const smokeConfig = {
    ...runtimeConfig,
    main: path.join(root, "deploy/cloudflare-worker/worker.ts"),
    vars: { ...(config.vars ?? {}), ...workerSmokeVars(port) },
  };
  writeFileSync(smokeConfigPath, `${JSON.stringify(smokeConfig, null, 2)}\n`);

  const args = [
    "exec",
    "wrangler",
    "dev",
    "--config",
    smokeConfigPath,
    "--local",
    "--latest=false",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--log-level",
    "error",
    "--show-interactive-dev-session=false",
  ];
  const child = spawn("pnpm", args, {
    cwd: root,
    env: wranglerEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  try {
    const deadline = Date.now() + 30_000;
    let lastError = new Error("Worker did not start");
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { Host: `127.0.0.1:${port}` },
        });
        const body = await response.json();
        if (response.status === 200 && body.status === "ok" && body.server === "backblaze-b2-mcp") {
          return { healthStatus: response.status, healthBody: body };
        }
        lastError = new Error(
          `Unexpected /health response ${response.status}: ${JSON.stringify(body)}`,
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    fail(`${lastError.message}\n${output.trim()}`);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    rmSync(workspace, { recursive: true, force: true });
  }
}

const wranglerConfigText = readFileSync(wranglerConfigPath, "utf8");
const wranglerConfig = parseJsoncObject(wranglerConfigText);
const compatibility = validateWranglerConfig(wranglerConfig);
for (const entrypoint of entrypoints) {
  if (!existsSync(path.join(root, entrypoint))) fail(`${entrypoint} is missing`);
}

const files = collectLocalImportGraph(root, entrypoints);
const sourceBytes = [...files].reduce((sum, file) => sum + statSync(file).size, 0);

if (files.size > WORKER_SOURCE_GRAPH_FILES_BUDGET) {
  fail(
    `source graph file count exceeded budget: ${files.size} > ${WORKER_SOURCE_GRAPH_FILES_BUDGET}`,
  );
}
if (sourceBytes > WORKER_SOURCE_GRAPH_BYTES_BUDGET) {
  fail(`source graph bytes exceeded budget: ${sourceBytes} > ${WORKER_SOURCE_GRAPH_BYTES_BUDGET}`);
}

const smoke = await runWranglerStartupSmoke(wranglerConfig);

mkdirSync(reportDir, { recursive: true });
const metrics = {
  ...compatibility,
  sourceGraphFiles: files.size,
  sourceGraphBytes: sourceBytes,
  workerRuntimeSmoke: smoke,
  limits: {
    sourceGraphFiles: WORKER_SOURCE_GRAPH_FILES_BUDGET,
    sourceGraphBytes: WORKER_SOURCE_GRAPH_BYTES_BUDGET,
  },
};
writeFileSync(path.join(reportDir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
writeFileSync(
  path.join(reportDir, "summary.md"),
  [
    "# Cloudflare Worker Bundle Budget",
    "",
    "| Metric | Current | Budget |",
    "| --- | ---: | ---: |",
    `| Source graph files | ${files.size} | ${WORKER_SOURCE_GRAPH_FILES_BUDGET} |`,
    `| Source graph bytes | ${sourceBytes} | ${WORKER_SOURCE_GRAPH_BYTES_BUDGET} |`,
    `| Runtime smoke /health | ${smoke.healthStatus} | 200 |`,
    "",
  ].join("\n"),
);

console.log(
  `cloudflare-worker-bundle: ${files.size} files, ${sourceBytes} bytes, and workerd health smoke passed`,
);
