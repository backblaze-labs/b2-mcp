#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import http from "node:http";

const DEFAULT_READY_PORT = 3106;
const DEFAULT_MISSING_CREDENTIALS_PORT = 3107;
const DEFAULT_ATTEMPTS = 30;
const DEFAULT_DELAY_MS = 2_000;

// retry-utils.cjs is for retrying registry/tool commands with blocking sleeps.
// This smoke path needs non-retrying Docker lifecycle commands plus async waits.
function usage() {
  return [
    "Usage: node scripts/smoke-container-image.mjs --image <image> [--build]",
    "",
    "Options:",
    "  --image <image>       Local image tag to smoke",
    "  --build               Build the image from the current checkout first",
    "  --ready-port <port>   Host port for the ready smoke (default: 3106)",
    "  --missing-port <port> Host port for the missing-credential smoke (default: 3107)",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    build: false,
    readyPort: DEFAULT_READY_PORT,
    missingPort: DEFAULT_MISSING_CREDENTIALS_PORT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--build") {
      options.build = true;
      continue;
    }
    if (arg === "--image") {
      options.image = argv[++index];
      continue;
    }
    if (arg === "--ready-port") {
      options.readyPort = Number(argv[++index]);
      continue;
    }
    if (arg === "--missing-port") {
      options.missingPort = Number(argv[++index]);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.image) throw new Error("--image is required");
  for (const [label, port] of [
    ["--ready-port", options.readyPort],
    ["--missing-port", options.missingPort],
  ]) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`${label} must be a valid TCP port`);
    }
  }
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.input ? "utf8" : undefined,
    input: options.input,
    stdio: options.input ? ["pipe", "inherit", "inherit"] : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
  return result;
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}: ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 2_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "" });
    });
    req.on("error", () => resolve({ status: 0, body: "" }));
  });
}

async function waitForHealth({ port, expectedStatus, expectedBody }) {
  for (let attempt = 1; attempt <= DEFAULT_ATTEMPTS; attempt += 1) {
    const response = await requestHealth(port);
    const bodyMatches = !expectedBody || response.body.includes(expectedBody);
    if (response.status === expectedStatus && bodyMatches) return response;
    await sleep(DEFAULT_DELAY_MS);
  }
  throw new Error(`container health did not return HTTP ${expectedStatus} on port ${port}`);
}

function startContainer(image, port, env = {}) {
  const args = [
    "run",
    "--detach",
    "--publish",
    `127.0.0.1:${port}:3000`,
    "--env",
    "B2_HTTP_CREDENTIAL_MODE=server",
  ];
  for (const [name, value] of Object.entries(env)) {
    args.push("--env", `${name}=${value}`);
  }
  args.push(image);
  return capture("docker", args);
}

async function smokeReadyImage(image, port) {
  const containerId = startContainer(image, port, {
    B2_APPLICATION_KEY_ID: "container-smoke-key-id",
    B2_APPLICATION_KEY: "container-smoke-key-secret",
    B2_ALLOWED_HOSTS: "127.0.0.1",
  });
  try {
    await waitForHealth({ port, expectedStatus: 200 });
  } catch (err) {
    run("docker", ["logs", containerId]);
    throw err;
  } finally {
    run("docker", ["rm", "-f", containerId]);
  }
}

async function smokeMissingCredentials(image, port) {
  const containerId = startContainer(image, port);
  try {
    await waitForHealth({
      port,
      expectedStatus: 503,
      expectedBody: "Credential configuration invalid",
    });
  } catch (err) {
    run("docker", ["logs", containerId]);
    throw err;
  } finally {
    run("docker", ["rm", "-f", containerId]);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.build) {
    run("docker", ["build", "--tag", options.image, "."]);
  }
  await smokeReadyImage(options.image, options.readyPort);
  await smokeMissingCredentials(options.image, options.missingPort);
  console.log(`container-smoke: ${options.image} passed HTTP readiness checks`);
}

main().catch((err) => {
  process.stderr.write(`container-smoke: ${err instanceof Error ? err.message : String(err)}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exit(1);
});
