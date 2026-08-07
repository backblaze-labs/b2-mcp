#!/usr/bin/env node

/* global console, process */

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { b2CredentialPolicy, redactB2CredentialValues } from "./b2-credential-env.mjs";
import liveB2Contract from "./lib/live-b2-contract.cjs";

const {
  CONTRACT_BUCKET_PREFIX,
  CLEANUP_PAGINATION_GUARD_PAGES,
  bucketMatchesPrefix,
  cleanupContractBucketWithTools,
  createCleanupStats,
  isSafeLivePrefix,
  normalizeLivePrefix,
} = liveB2Contract;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function usage(message) {
  if (message) console.error(message);
  console.error(
    "Usage: node scripts/live-b2-janitor.mjs [--prefix <test-prefix>] [--exclude-prefix <active-prefix>] [--dry-run] [--best-effort]",
  );
}

export function parseArgs(argv) {
  const options = {
    prefix: CONTRACT_BUCKET_PREFIX,
    excludePrefixes: [],
    dryRun: false,
    bestEffort: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--best-effort") {
      options.bestEffort = true;
    } else if (arg === "--prefix") {
      const value = argv[++index];
      if (!value) throw new Error("--prefix requires a value");
      options.prefix = value;
    } else if (arg === "--exclude-prefix") {
      const value = argv[++index];
      if (!value) throw new Error("--exclude-prefix requires a value");
      options.excludePrefixes.push(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  options.prefix = normalizeLivePrefix(options.prefix);
  options.excludePrefixes = options.excludePrefixes.map(normalizeLivePrefix);
  return options;
}

function exactSecretMissing() {
  return b2CredentialPolicy.liveRequired.filter((name) => !process.env[name]);
}

function expectedLiveTestAccountId() {
  return String(process.env.B2_LIVE_TEST_ACCOUNT_ID ?? "").trim();
}

function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function redactDetail(value, prefix) {
  return liveB2Contract.redactKnownLiveResourceDetails(
    redactB2CredentialValues(String(value ?? ""), process.env),
    { prefix },
  );
}

async function loadRuntime() {
  const serverModule = await import(pathToFileURL(join(root, "dist/server.js")).href);
  const authModule = await import(pathToFileURL(join(root, "dist/auth.js")).href);
  const clientModule = await import(pathToFileURL(join(root, "dist/b2/client.js")).href);
  const config = serverModule.loadConfig();
  const authManager = new authModule.B2AuthManager(config);
  const server = serverModule.createServer({
    ...config,
    destructivePolicy: "allow",
  });
  const tools = serverModule.getRegisteredTools(server);
  if (!tools) throw new Error("Built server did not expose registered tools.");
  const b2Client = new clientModule.B2Client(authManager);
  return { authManager, b2Client, tools };
}

async function callTool(tools, name, args) {
  const tool = tools[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.execute(args, {});
}

export async function cleanupKeys(b2Client, stats, options) {
  let startApplicationKeyId;
  for (let page = 0; page < CLEANUP_PAGINATION_GUARD_PAGES; page++) {
    let listed;
    try {
      listed = await b2Client.listKeys({
        maxKeyCount: 1000,
        ...(startApplicationKeyId ? { startApplicationKeyId } : {}),
      });
    } catch (err) {
      stats.errors++;
      console.error(
        `live-b2-janitor: key listing failed: ${redactDetail(err?.message ?? err, options.prefix)}`,
      );
      return;
    }

    for (const key of listed.keys ?? []) {
      if (!key.keyName?.startsWith(options.prefix)) continue;
      if (key.applicationKeyId === process.env.B2_APPLICATION_KEY_ID) continue;
      stats.keys++;
      console.log(`live-b2-janitor: deleting key fingerprint=${fingerprint(key.keyName)}`);
      if (options.dryRun) continue;
      try {
        await b2Client.deleteKey(key.applicationKeyId);
      } catch (err) {
        stats.errors++;
        console.error(
          `live-b2-janitor: key cleanup failed key=${fingerprint(key.keyName)} ${redactDetail(
            err?.message ?? err,
            options.prefix,
          )}`,
        );
      }
    }

    if (!listed.nextApplicationKeyId) return;
    startApplicationKeyId = listed.nextApplicationKeyId;
  }
  stats.errors++;
  console.error("live-b2-janitor: key cleanup exceeded pagination guard");
}

export async function assertExpectedLiveTestAccount(authManager, expectedAccountId, options) {
  if (!expectedAccountId) {
    throw new Error("B2_LIVE_TEST_ACCOUNT_ID is required before live B2 janitor deletion.");
  }
  const auth = await authManager.getAuth();
  if (auth.accountId !== expectedAccountId) {
    throw new Error(
      `authorized account fingerprint=${fingerprint(
        auth.accountId,
      )} does not match B2_LIVE_TEST_ACCOUNT_ID fingerprint=${fingerprint(expectedAccountId)}`,
    );
  }
  if (options?.log) {
    options.log(`authorized account fingerprint=${fingerprint(auth.accountId)}`);
  }
}

function selectedBuckets(buckets, options) {
  return buckets.filter(
    (bucket) =>
      bucketMatchesPrefix(bucket.bucketName, options.prefix) &&
      !options.excludePrefixes.some((prefix) => bucketMatchesPrefix(bucket.bucketName, prefix)),
  );
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    usage(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  if (!isSafeLivePrefix(options.prefix)) {
    usage(`Refusing unsafe live B2 janitor prefix: ${options.prefix}`);
    process.exit(2);
  }

  const missing = exactSecretMissing();
  if (missing.length) {
    console.error(`live-b2-janitor: missing required live B2 credentials: ${missing.join(", ")}`);
    process.exit(2);
  }

  const { authManager, b2Client, tools } = await loadRuntime();
  const stats = createCleanupStats();
  try {
    await assertExpectedLiveTestAccount(authManager, expectedLiveTestAccountId(), {
      log: (message) => console.log(`live-b2-janitor: ${message}`),
    });
  } catch (err) {
    console.error(`live-b2-janitor: ${redactDetail(err?.message ?? err, options.prefix)}`);
    process.exit(2);
  }

  let buckets;
  try {
    buckets = selectedBuckets((await b2Client.listBuckets({})).buckets ?? [], options);
  } catch (err) {
    console.error(
      `live-b2-janitor: could not list buckets: ${redactDetail(err?.message ?? err, options.prefix)}`,
    );
    process.exit(1);
  }

  const cleanupOptions = {
    dryRun: options.dryRun,
    error: (message) => console.error(`live-b2-janitor: ${message}`),
    fingerprint,
    log: (message) => console.log(`live-b2-janitor: ${message}`),
    prefix: options.prefix,
    redact: (message) => redactDetail(message, options.prefix),
    stats,
  };
  for (const bucket of buckets) {
    await cleanupContractBucketWithTools(
      (name, args) => callTool(tools, name, args),
      bucket,
      cleanupOptions,
    );
  }
  await cleanupKeys(b2Client, stats, options);

  console.log(
    `live-b2-janitor: summary buckets=${stats.buckets} objectVersions=${stats.objectVersions} multipartUploads=${stats.multipartUploads} keys=${stats.keys} leakedBuckets=${stats.leakedBuckets} errors=${stats.errors}`,
  );
  if (stats.errors || stats.leakedBuckets) {
    const annotation = options.bestEffort ? "warning" : "error";
    console.error(
      `::${annotation} title=Live B2 janitor::cleanup_errors=${stats.errors} leaked_buckets=${stats.leakedBuckets}`,
    );
    if (options.bestEffort) return;
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`live-b2-janitor: ${redactB2CredentialValues(err?.message ?? err, process.env)}`);
    process.exit(1);
  });
}
