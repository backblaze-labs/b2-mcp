#!/usr/bin/env node
import { spawn, spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { createRequire } from "module";
import { createServer } from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { gzipSync } from "zlib";

const require = createRequire(import.meta.url);
const {
  WORKER_EMITTED_FILES_BUDGET,
  WORKER_EMITTED_TOTAL_BYTES_BUDGET,
  WORKER_SOURCE_GRAPH_BYTES_BUDGET,
  WORKER_SOURCE_GRAPH_FILES_BUDGET,
  WORKER_UPLOAD_SCRIPT_BYTES_BUDGET,
  WORKER_UPLOAD_SCRIPT_GZIP_BYTES_BUDGET,
  collectLocalImportGraph,
  parseJsoncObject,
} = require("./lib/local-import-graph.cjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = path.join(root, "reports", "cloudflare-worker-bundle");
const wranglerConfigPath = path.join(root, "deploy/cloudflare-worker/wrangler.jsonc");
const entrypoints = ["deploy/cloudflare-worker/worker.ts"];
const WORKER_SMOKE_TIMEOUT_MS = 30_000;
const WORKER_SMOKE_PROBE_TIMEOUT_MS = 1_000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Wrangler may emit ANSI colors.
const ansiEscapePattern = /\u001B\[[0-9;]*m/g;

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

function workerRuntimeConfig(config, port) {
  const runtimeConfig = { ...config };
  delete runtimeConfig.secrets;
  return {
    ...runtimeConfig,
    main: path.join(root, "deploy/cloudflare-worker/worker.ts"),
    vars: { ...(config.vars ?? {}), ...workerSmokeVars(port) },
  };
}

function writeWorkerRuntimeConfig(config, workspace, port) {
  const runtimeConfigPath = path.join(workspace, "wrangler.jsonc");
  writeFileSync(
    runtimeConfigPath,
    `${JSON.stringify(workerRuntimeConfig(config, port), null, 2)}\n`,
  );
  return runtimeConfigPath;
}

function wranglerEnv(baseEnv) {
  const env = { ...baseEnv, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" };
  delete env.FORCE_COLOR;
  return env;
}

function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(absolutePath) : [absolutePath];
  });
}

function stripAnsi(text) {
  return text.replace(ansiEscapePattern, "");
}

function runWranglerDryRun(config) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "b2-mcp-worker-dry-run-"));
  const outdir = path.join(workspace, "out");
  const configPath = writeWorkerRuntimeConfig(config, workspace, 8787);
  const args = [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    configPath,
    "--dry-run",
    "--outdir",
    outdir,
    "--metafile",
    path.join(outdir, "bundle-meta.json"),
    "--containers-rollout=none",
    "--keep-vars",
  ];

  try {
    const result = spawnSync("pnpm", args, {
      cwd: root,
      env: wranglerEnv(process.env),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.status !== 0) {
      fail(`wrangler deploy --dry-run failed\n${output.trim()}`);
    }

    if (!existsSync(outdir)) fail("wrangler deploy --dry-run did not create an output directory");
    const files = collectFiles(outdir).sort();
    if (files.length === 0) fail("wrangler deploy --dry-run emitted no bundle files");
    const workerScript = files.find((file) => path.basename(file) === "worker.js");
    if (!workerScript) fail("wrangler deploy --dry-run did not emit worker.js");

    const emittedFiles = files.map((file) => ({
      path: path.relative(outdir, file),
      bytes: statSync(file).size,
    }));
    const emittedTotalBytes = emittedFiles.reduce((sum, file) => sum + file.bytes, 0);
    const workerScriptBytes = statSync(workerScript).size;
    const workerScriptGzipBytes = gzipSync(readFileSync(workerScript)).byteLength;
    const uploadLine = output
      .split(/\r?\n/)
      .find((line) => stripAnsi(line).includes("Total Upload"));

    return {
      emittedFiles,
      emittedTotalBytes,
      uploadLine: uploadLine ? stripAnsi(uploadLine).trim() : undefined,
      workerScriptBytes,
      workerScriptGzipBytes,
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function runWranglerStartupSmoke(config) {
  const port = await freePort();
  const workspace = mkdtempSync(path.join(os.tmpdir(), "b2-mcp-worker-smoke-"));
  const smokeConfigPath = writeWorkerRuntimeConfig(config, workspace, port);

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
    const deadline = Date.now() + WORKER_SMOKE_TIMEOUT_MS;
    let lastError = new Error("Worker did not start");
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      const probeController = new AbortController();
      const probeTimeout = setTimeout(
        () => {
          probeController.abort();
        },
        Math.min(WORKER_SMOKE_PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
      );
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { Host: `127.0.0.1:${port}` },
          signal: probeController.signal,
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
      } finally {
        clearTimeout(probeTimeout);
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

const dryRun = runWranglerDryRun(wranglerConfig);
if (dryRun.emittedFiles.length > WORKER_EMITTED_FILES_BUDGET) {
  fail(
    `emitted bundle file count exceeded budget: ${dryRun.emittedFiles.length} > ${WORKER_EMITTED_FILES_BUDGET}`,
  );
}
if (dryRun.emittedTotalBytes > WORKER_EMITTED_TOTAL_BYTES_BUDGET) {
  fail(
    `emitted bundle bytes exceeded budget: ${dryRun.emittedTotalBytes} > ${WORKER_EMITTED_TOTAL_BYTES_BUDGET}`,
  );
}
if (dryRun.workerScriptBytes > WORKER_UPLOAD_SCRIPT_BYTES_BUDGET) {
  fail(
    `Worker upload script bytes exceeded budget: ${dryRun.workerScriptBytes} > ${WORKER_UPLOAD_SCRIPT_BYTES_BUDGET}`,
  );
}
if (dryRun.workerScriptGzipBytes > WORKER_UPLOAD_SCRIPT_GZIP_BYTES_BUDGET) {
  fail(
    `Worker upload gzip bytes exceeded budget: ${dryRun.workerScriptGzipBytes} > ${WORKER_UPLOAD_SCRIPT_GZIP_BYTES_BUDGET}`,
  );
}

const smoke = await runWranglerStartupSmoke(wranglerConfig);

mkdirSync(reportDir, { recursive: true });
const metrics = {
  ...compatibility,
  wranglerDryRun: dryRun,
  sourceGraphFiles: files.size,
  sourceGraphBytes: sourceBytes,
  workerRuntimeSmoke: smoke,
  limits: {
    emittedFiles: WORKER_EMITTED_FILES_BUDGET,
    emittedTotalBytes: WORKER_EMITTED_TOTAL_BYTES_BUDGET,
    sourceGraphFiles: WORKER_SOURCE_GRAPH_FILES_BUDGET,
    sourceGraphBytes: WORKER_SOURCE_GRAPH_BYTES_BUDGET,
    workerScriptBytes: WORKER_UPLOAD_SCRIPT_BYTES_BUDGET,
    workerScriptGzipBytes: WORKER_UPLOAD_SCRIPT_GZIP_BYTES_BUDGET,
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
    `| Emitted bundle files | ${dryRun.emittedFiles.length} | ${WORKER_EMITTED_FILES_BUDGET} |`,
    `| Emitted bundle bytes | ${dryRun.emittedTotalBytes} | ${WORKER_EMITTED_TOTAL_BYTES_BUDGET} |`,
    `| Worker upload script bytes | ${dryRun.workerScriptBytes} | ${WORKER_UPLOAD_SCRIPT_BYTES_BUDGET} |`,
    `| Worker upload gzip bytes | ${dryRun.workerScriptGzipBytes} | ${WORKER_UPLOAD_SCRIPT_GZIP_BYTES_BUDGET} |`,
    `| Source graph files | ${files.size} | ${WORKER_SOURCE_GRAPH_FILES_BUDGET} |`,
    `| Source graph bytes | ${sourceBytes} | ${WORKER_SOURCE_GRAPH_BYTES_BUDGET} |`,
    `| Runtime smoke /health | ${smoke.healthStatus} | 200 |`,
    "",
  ].join("\n"),
);

console.log(
  `cloudflare-worker-bundle: ${dryRun.workerScriptBytes} upload bytes, ${dryRun.workerScriptGzipBytes} gzip bytes, and workerd health smoke passed`,
);
