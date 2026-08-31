#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  assertMcpRegistryManifestContract,
  assertRegistryResponseMatchesManifest,
  isPrereleaseVersion,
  mcpRegistryApiBaseUrl,
  mcpRegistryVersionUrl,
} from "./lib/mcp-registry-manifest.mjs";

function usage() {
  return [
    "Usage: node scripts/mcp-registry-publish.mjs",
    "--server-json <path> --publisher <path> --version <version> [--skip-prerelease]",
  ].join(" ");
}

function parsePositiveInt(raw, name) {
  if (!/^[1-9]\d*$/.test(String(raw ?? ""))) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseArgs(argv) {
  const options = {
    attempts: 3,
    initialDelayMs: 5000,
    lookupTimeoutMs: 30000,
    publisherPath: "",
    publisherTimeoutMs: 120000,
    registryBaseUrl: mcpRegistryApiBaseUrl,
    serverJsonPath: "",
    skipPrerelease: false,
    version: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--server-json") {
      const value = argv[index + 1];
      if (!value) throw new Error("--server-json requires a value");
      options.serverJsonPath = value;
      index += 1;
      continue;
    }
    if (arg === "--publisher") {
      const value = argv[index + 1];
      if (!value) throw new Error("--publisher requires a value");
      options.publisherPath = value;
      index += 1;
      continue;
    }
    if (arg === "--version") {
      const value = argv[index + 1];
      if (!value) throw new Error("--version requires a value");
      options.version = value;
      index += 1;
      continue;
    }
    if (arg === "--registry-base-url") {
      const value = argv[index + 1];
      if (!value) throw new Error("--registry-base-url requires a value");
      options.registryBaseUrl = value;
      index += 1;
      continue;
    }
    if (arg === "--attempts") {
      options.attempts = parsePositiveInt(argv[index + 1], "--attempts");
      index += 1;
      continue;
    }
    if (arg === "--initial-delay-ms") {
      options.initialDelayMs = parsePositiveInt(argv[index + 1], "--initial-delay-ms");
      index += 1;
      continue;
    }
    if (arg === "--lookup-timeout-ms") {
      options.lookupTimeoutMs = parsePositiveInt(argv[index + 1], "--lookup-timeout-ms");
      index += 1;
      continue;
    }
    if (arg === "--publisher-timeout-ms") {
      options.publisherTimeoutMs = parsePositiveInt(argv[index + 1], "--publisher-timeout-ms");
      index += 1;
      continue;
    }
    if (arg === "--skip-prerelease") {
      options.skipPrerelease = true;
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }

  if (!options.serverJsonPath) throw new Error("--server-json is required");
  if (!options.publisherPath) throw new Error("--publisher is required");
  if (!options.version) throw new Error("--version is required");
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientHttpStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function transientPublisherText(text) {
  return /\b(408|409|425|429|5\d\d)\b|bad gateway|connection reset|dns|econnreset|econnrefused|etimedout|gateway timeout|i\/o timeout|network|no such host|service unavailable|temporary|timeout|too many requests/i.test(
    text,
  );
}

export function isTransientMcpPublisherFailure(result) {
  if (result.timedOut || result.signal) return true;
  return transientPublisherText(`${result.stderr ?? ""}\n${result.stdout ?? ""}`);
}

function publisherOutput(result) {
  return `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
}

function attemptCountText(count) {
  return `${count} attempt${count === 1 ? "" : "s"}`;
}

function isDuplicateVersionFailure(result) {
  return /already exists|cannot publish duplicate version|duplicate version|version already exists/i.test(
    publisherOutput(result),
  );
}

function shouldRequeryAfterPublishFailure(result) {
  return isTransientMcpPublisherFailure(result) || isDuplicateVersionFailure(result);
}

function registryPublisherRootUrl(registryBaseUrl) {
  const root = String(registryBaseUrl).replace(/\/+$/, "");
  return root.endsWith("/v0") ? root.slice(0, -"/v0".length) : root;
}

async function defaultFetchText(url, { timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { body: await response.text(), status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

async function lookupRegistryVersion(url, options) {
  let lastError = null;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      const response = await options.fetchText(url, { timeoutMs: options.lookupTimeoutMs });
      if (isTransientHttpStatus(response.status) && attempt < options.attempts) {
        options.log.warn(
          `mcp-registry: lookup returned ${response.status}; retrying in ${options.initialDelayMs * attempt}ms`,
        );
        await options.sleep(options.initialDelayMs * attempt);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= options.attempts) break;
      options.log.warn(
        `mcp-registry: lookup failed (${error instanceof Error ? error.message : String(error)}); retrying in ${
          options.initialDelayMs * attempt
        }ms`,
      );
      await options.sleep(options.initialDelayMs * attempt);
    }
  }
  throw new Error(
    `MCP Registry lookup failed after ${options.attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function defaultRunPublisher(args, { publisherPath, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(publisherPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
    }, timeoutMs);

    const clearTimers = () => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimers();
      resolve({ code: 1, stderr: error.message, stdout, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimers();
      resolve({ code, signal, stderr, stdout, timedOut });
    });
  });
}

async function runPublisherWithRetry(label, args, options) {
  let lastResult = null;
  let attemptsRun = 0;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    attemptsRun = attempt;
    const result = await options.runPublisher(args, {
      publisherPath: options.publisherPath,
      timeoutMs: options.publisherTimeoutMs,
    });
    lastResult = result;
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.code === 0) return result;

    if (!isTransientMcpPublisherFailure(result) || attempt >= options.attempts) break;
    options.log.warn(
      `mcp-registry: ${label} failed transiently; retrying in ${options.initialDelayMs * attempt}ms`,
    );
    await options.sleep(options.initialDelayMs * attempt);
  }

  throw new Error(
    `mcp-publisher ${label} failed after ${attemptCountText(attemptsRun)} with exit ${lastResult?.code ?? "unknown"}`,
  );
}

async function registryVersionMatches(lookupUrl, manifest, options, context) {
  const lookup = await lookupRegistryVersion(lookupUrl, options);
  if (lookup.status === 200) {
    const responseJson = JSON.parse(lookup.body);
    assertRegistryResponseMatchesManifest(responseJson, manifest);
    options.log.log(
      `mcp-registry: ${manifest.name}@${manifest.version} exists and matches server.json after ${context}`,
    );
    return true;
  }
  if (lookup.status === 404) return false;
  throw new Error(`MCP Registry lookup returned ${lookup.status}: ${lookup.body}`);
}

async function publishWithRegistryRecheck(manifest, lookupUrl, options) {
  let lastResult = null;
  let attemptsRun = 0;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    attemptsRun = attempt;
    const result = await options.runPublisher(["publish", options.serverJsonPath], {
      publisherPath: options.publisherPath,
      timeoutMs: options.publisherTimeoutMs,
    });
    lastResult = result;
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.code === 0) return { status: "published" };

    if (shouldRequeryAfterPublishFailure(result)) {
      const matched = await registryVersionMatches(
        lookupUrl,
        manifest,
        options,
        "ambiguous publish failure",
      );
      if (matched) return { status: "already-published" };
    }

    if (!isTransientMcpPublisherFailure(result) || attempt >= options.attempts) break;
    options.log.warn(
      `mcp-registry: publish failed transiently; retrying in ${options.initialDelayMs * attempt}ms`,
    );
    await options.sleep(options.initialDelayMs * attempt);
  }

  throw new Error(
    `mcp-publisher publish failed after ${attemptCountText(attemptsRun)} with exit ${lastResult?.code ?? "unknown"}`,
  );
}

export async function publishMcpRegistry(options) {
  const runtimeOptions = {
    attempts: 3,
    fetchText: defaultFetchText,
    initialDelayMs: 5000,
    log: console,
    lookupTimeoutMs: 30000,
    publisherTimeoutMs: 120000,
    registryBaseUrl: mcpRegistryApiBaseUrl,
    runPublisher: defaultRunPublisher,
    skipPrerelease: false,
    sleep,
    ...options,
  };
  const manifest = JSON.parse(readFileSync(runtimeOptions.serverJsonPath, "utf8"));
  assertMcpRegistryManifestContract(manifest, { expectedVersion: runtimeOptions.version });

  if (runtimeOptions.skipPrerelease && isPrereleaseVersion(runtimeOptions.version)) {
    runtimeOptions.log.log(
      `mcp-registry: skipping prerelease ${manifest.name}@${runtimeOptions.version}`,
    );
    return { status: "skipped-prerelease" };
  }

  const lookupUrl = mcpRegistryVersionUrl(manifest, runtimeOptions.registryBaseUrl);
  const lookup = await lookupRegistryVersion(lookupUrl, runtimeOptions);
  if (lookup.status === 200) {
    const responseJson = JSON.parse(lookup.body);
    assertRegistryResponseMatchesManifest(responseJson, manifest);
    runtimeOptions.log.log(
      `mcp-registry: ${manifest.name}@${manifest.version} already exists and matches server.json`,
    );
    return { status: "already-published" };
  }
  if (lookup.status !== 404) {
    throw new Error(`MCP Registry lookup returned ${lookup.status}: ${lookup.body}`);
  }

  await runPublisherWithRetry(
    "login github-oidc",
    [
      "login",
      "github-oidc",
      "--registry",
      registryPublisherRootUrl(runtimeOptions.registryBaseUrl),
    ],
    runtimeOptions,
  );
  return publishWithRegistryRecheck(manifest, lookupUrl, runtimeOptions);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await publishMcpRegistry({
    attempts: args.attempts,
    fetchText: defaultFetchText,
    initialDelayMs: args.initialDelayMs,
    log: console,
    lookupTimeoutMs: args.lookupTimeoutMs,
    publisherPath: args.publisherPath,
    publisherTimeoutMs: args.publisherTimeoutMs,
    registryBaseUrl: args.registryBaseUrl,
    runPublisher: defaultRunPublisher,
    serverJsonPath: args.serverJsonPath,
    skipPrerelease: args.skipPrerelease,
    sleep,
    version: args.version,
  });
  console.log(`mcp-registry: ${result.status}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`mcp-registry: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exit(2);
  }
}
