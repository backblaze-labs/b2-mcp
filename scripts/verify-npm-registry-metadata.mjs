#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const retryableViewFailure = [
  /\bE404\b/i,
  /not found/i,
  /\bEAI_AGAIN\b/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bENOTFOUND\b/i,
  /\bECONNREFUSED\b/i,
  /\bEPIPE\b/i,
  /fetch failed/i,
  /network socket/i,
  /network timeout/i,
  /rate limit/i,
  // Transient HTTP statuses, matched only as standalone tokens so an embedded
  // number (a version like 1.500.0, or 1500) is not misread as a 5xx/404/429.
  /(?<![\w.])(?:404|429|500|502|503|504)(?![\w.])/,
];

function usage() {
  return [
    "Usage: node scripts/verify-npm-registry-metadata.mjs --package <name@version>",
    "  [--timeout-ms <ms>] [--initial-interval-ms <ms>] [--max-interval-ms <ms>]",
    "  [--allow-legacy-local-path-metadata <name@version> ...]",
  ].join("\n");
}

function parsePositiveInteger(value, optionName) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${optionName} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    packageSpec: "",
    timeoutMs: 120_000,
    initialIntervalMs: 5_000,
    maxIntervalMs: 30_000,
    allowedLegacySpecs: new Set(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }

    const readValue = (optionName) => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${optionName} requires a value`);
      index += 1;
      return value;
    };

    if (arg === "--package") {
      options.packageSpec = readValue(arg);
      continue;
    }
    if (arg.startsWith("--package=")) {
      options.packageSpec = arg.slice("--package=".length);
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(readValue(arg), arg);
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = parsePositiveInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
      continue;
    }
    if (arg === "--initial-interval-ms") {
      options.initialIntervalMs = parsePositiveInteger(readValue(arg), arg);
      continue;
    }
    if (arg.startsWith("--initial-interval-ms=")) {
      options.initialIntervalMs = parsePositiveInteger(
        arg.slice("--initial-interval-ms=".length),
        "--initial-interval-ms",
      );
      continue;
    }
    if (arg === "--max-interval-ms") {
      options.maxIntervalMs = parsePositiveInteger(readValue(arg), arg);
      continue;
    }
    if (arg.startsWith("--max-interval-ms=")) {
      options.maxIntervalMs = parsePositiveInteger(
        arg.slice("--max-interval-ms=".length),
        "--max-interval-ms",
      );
      continue;
    }
    if (arg === "--allow-legacy-local-path-metadata") {
      options.allowedLegacySpecs.add(readValue(arg));
      continue;
    }
    if (arg.startsWith("--allow-legacy-local-path-metadata=")) {
      options.allowedLegacySpecs.add(arg.slice("--allow-legacy-local-path-metadata=".length));
      continue;
    }

    throw new Error(`unknown argument ${arg}`);
  }

  if (!options.packageSpec) throw new Error("--package is required");
  return options;
}

export function leakedRegistryMetadataKeys(metadata) {
  if (!metadata || typeof metadata !== "object") return [];
  return ["_from", "_resolved"].filter((key) => Boolean(metadata[key]));
}

export function parseRegistryMetadata(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed);
}

function compactErrorText(result) {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").replace(/\s+/g, " ").trim();
}

export function isRetryableNpmViewFailure(result) {
  const text = compactErrorText(result);
  return retryableViewFailure.some((pattern) => pattern.test(text));
}

function npmViewMetadata(packageSpec) {
  return spawnSync("npm", ["view", packageSpec, "_from", "_resolved", "--json"], {
    encoding: "utf8",
  });
}

function retryDelayMs(intervalMs, maxIntervalMs) {
  return Math.min(intervalMs * 2, maxIntervalMs);
}

export async function verifyNpmRegistryMetadata({
  packageSpec,
  timeoutMs = 120_000,
  initialIntervalMs = 5_000,
  maxIntervalMs = 30_000,
  allowedLegacySpecs = new Set(),
  viewMetadata = npmViewMetadata,
  wait = sleep,
  now = () => Date.now(),
  log = console,
}) {
  const deadline = now() + timeoutMs;
  let attempt = 1;
  let intervalMs = initialIntervalMs;
  let lastRetryableError = "";

  while (true) {
    const result = viewMetadata(packageSpec);

    if (result.status === 0) {
      let metadata;
      try {
        metadata = parseRegistryMetadata(result.stdout);
      } catch (error) {
        lastRetryableError = `invalid npm view JSON: ${
          error instanceof Error ? error.message : String(error)
        }`;
        metadata = null;
      }

      if (metadata) {
        const leaked = leakedRegistryMetadataKeys(metadata);
        if (leaked.length === 0) {
          log.log(`npm-registry-metadata: verified ${packageSpec} has no _from/_resolved metadata`);
          return { status: "verified", attempts: attempt };
        }

        if (allowedLegacySpecs.has(packageSpec)) {
          log.warn(
            `::warning::npm-registry-metadata: ${packageSpec} exposes legacy ${leaked.join(
              ", ",
            )} metadata; matching-integrity rerun is allowed for this immutable pre-fix version`,
          );
          return { status: "legacy-allowed", attempts: attempt, leaked };
        }

        throw new Error(
          `registry metadata exposes local publish coordinates for ${packageSpec}: ${leaked.join(
            ", ",
          )}`,
        );
      }
    } else {
      const failureKind = isRetryableNpmViewFailure(result) ? "retryable" : "unexpected";
      lastRetryableError = `${failureKind} npm view failure: ${
        compactErrorText(result) || `exit status ${result.status}`
      }`;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new Error(
        `registry metadata verification for ${packageSpec} did not complete within ${timeoutMs}ms: ${lastRetryableError}`,
      );
    }

    const delayMs = Math.min(intervalMs, remainingMs);
    log.warn(
      `npm-registry-metadata: retrying npm view for ${packageSpec} in ${delayMs}ms after attempt ${attempt}: ${lastRetryableError}`,
    );
    await wait(delayMs);
    attempt += 1;
    intervalMs = retryDelayMs(intervalMs, maxIntervalMs);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await verifyNpmRegistryMetadata(options);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(
      `npm-registry-metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(usage());
    process.exit(1);
  }
}
