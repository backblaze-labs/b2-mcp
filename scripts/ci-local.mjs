#!/usr/bin/env node

/* global console, process */

// Local mirror of the required PR jobs in .github/workflows/test.yml.
// tests/contract/ci-local.contract.test.ts fails when a workflow command is
// missing here, so keep both files in the same PR.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { vercelBuildKnownSecretCanaries } from "./b2-credential-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const logDir = join(root, "reports", "ci-local");
const defaultTimeoutMs = 30 * 60 * 1000;

function zizmorImage() {
  const workflow = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");
  const match = workflow.match(/^\s*ZIZMOR_IMAGE:\s*(\S+)\s*$/m);
  if (!match) throw new Error("ZIZMOR_IMAGE is not set in .github/workflows/test.yml");
  return match[1];
}

/**
 * Ordered local CI steps. `job` is the required check the step mirrors.
 * `requires: "docker"` steps are skipped, and reported, when Docker is unavailable.
 */
export const ciLocalSteps = [
  { id: "install", job: "all", commands: [["pnpm", "install", "--frozen-lockfile"]] },
  {
    id: "runtime-policy",
    job: "runtime policy",
    commands: [["pnpm", "run", "check:runtime-policy"]],
  },
  {
    id: "verify",
    job: "format/lint/typecheck",
    commands: [
      ["pnpm", "run", "verify"],
      ["pnpm", "run", "smoke:local"],
    ],
  },
  {
    id: "docs",
    job: "docs/spelling/links",
    commands: [
      ["pnpm", "run", "docs"],
      ["pnpm", "run", "lint:docs"],
      ["pnpm", "run", "spell"],
      ["pnpm", "run", "lint:links"],
    ],
  },
  {
    id: "coverage",
    job: "unit/coverage",
    commands: [
      ["pnpm", "run", "build"],
      ["pnpm", "run", "test:coverage"],
    ],
  },
  {
    id: "reliability",
    job: "reliability/resilience",
    commands: [["pnpm", "run", "test:reliability"]],
  },
  {
    id: "contract",
    job: "MCP contract",
    commands: [
      ["pnpm", "run", "build"],
      ["pnpm", "run", "test:contract"],
    ],
  },
  {
    id: "protocol",
    job: "modern and legacy protocol/transport",
    commands: [["pnpm", "run", "test:protocol"]],
  },
  {
    id: "observability",
    job: "observability/logging behavior",
    commands: [["pnpm", "run", "test:observability"]],
  },
  { id: "package", job: "package install smoke", commands: [["pnpm", "run", "test:package"]] },
  {
    id: "production-audit",
    job: "production dependency audit",
    commands: [["node", "scripts/production-security-gate.mjs"]],
  },
  {
    id: "package-budget",
    job: "package budget",
    commands: [
      ["pnpm", "run", "build"],
      ["pnpm", "run", "check:package-budget"],
      ["pnpm", "run", "check:vercel-bundle"],
      ["pnpm", "run", "check:cloudflare-worker-bundle"],
    ],
  },
  {
    id: "vercel-output",
    job: "Vercel build output scan",
    env: { CI: "true", ...vercelBuildKnownSecretCanaries },
    preserve: [".vercel"],
    commands: [
      ["pnpm", "run", "typecheck"],
      ["pnpm", "run", "build"],
      ["pnpm", "run", "prepare:vercel-local-build"],
      ["pnpm", "run", "build:vercel-local"],
      ["pnpm", "run", "check:vercel-build-output"],
      ["pnpm", "run", "audit:supply-chain:denylist", "--artifacts-dir", ".vercel/output"],
    ],
  },
  {
    id: "container-image",
    job: "container image",
    requires: "docker",
    commands: [["node", "scripts/smoke-container-image.mjs", "--build", "--image", "b2-mcp:local"]],
  },
  {
    id: "supply-chain",
    job: "supply-chain audit",
    env: { B2_MCP_AUDIT_EXPIRED_EXCEPTION_MODE: "fail" },
    commands: [
      [
        "pnpm",
        "run",
        "audit:supply-chain:denylist",
        "--ref",
        "HEAD",
        "--ref",
        "origin/main",
        "--packlist",
      ],
      ["pnpm", "run", "audit:supply-chain"],
    ],
  },
  {
    id: "zizmor",
    job: "CodeQL/workflow security",
    requires: "docker",
    commands: [
      [
        "docker",
        "run",
        "--rm",
        "--network=none",
        "--volume",
        `${root}:/workspace:ro`,
        "--workdir",
        "/workspace",
        zizmorImage(),
        "--config",
        "zizmor.yml",
        "--persona=pedantic",
        "--no-online-audits",
        "--min-severity=medium",
        "--min-confidence=medium",
        "--color=never",
        ".",
      ],
    ],
  },
  {
    id: "slow",
    job: "slow/lifecycle",
    commands: [["pnpm", "run", "test:slow", "--", "--maxWorkers=1"]],
  },
  {
    id: "changelog",
    job: "changelog",
    commands: [["pnpm", "run", "changelog:check"]],
  },
  {
    id: "cross-platform",
    job: "cross-platform minimum",
    commands: [
      ["pnpm", "run", "build"],
      ["pnpm", "run", "test:cross-platform"],
      ["pnpm", "run", "build:mcpb"],
    ],
  },
];

/**
 * Workflow commands that only run in CI, with the reason. The contract test
 * accepts a test.yml command when it is either here or in a step above.
 */
export const ciOnlyCommands = {
  "node scripts/packed-consumer-smoke.mjs":
    "runtime engine floor: needs the Node.js 22.22.2 engine floor and the CI package artifact",
  "node scripts/local-mcp-smoke.mjs":
    "runtime engine floor: runs the packed tarball on Node.js 22.22.2; `pnpm run smoke:local` covers the source build",
  "node scripts/print-vercel-build-canaries.mjs":
    "the vercel-output step imports the same canaries directly",
};

function parseArgs(argv) {
  const options = { only: null, skip: new Set(), from: null, failFast: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--") continue;
    else if (arg === "--list") options.list = true;
    else if (arg === "--fail-fast") options.failFast = true;
    else if (arg === "--only") options.only = new Set(value().split(","));
    else if (arg === "--skip") for (const id of value().split(",")) options.skip.add(id);
    else if (arg === "--from") options.from = value();
    else throw new Error(`unknown option ${arg}`);
  }
  const ids = new Set(ciLocalSteps.map((step) => step.id));
  for (const id of [
    ...(options.only ?? []),
    ...options.skip,
    ...(options.from ? [options.from] : []),
  ]) {
    if (!ids.has(id)) throw new Error(`unknown step ${id}; run with --list`);
  }
  return options;
}

function hasDocker() {
  const result = spawnSync("docker", ["info"], { stdio: "ignore" });
  return result.status === 0;
}

/**
 * Runs `fn` with each existing path in `paths` moved aside, then removes what
 * `fn` created there and restores the originals, even when `fn` throws.
 * @param {string} base - Directory the paths are relative to.
 * @param {string[]} paths
 * @param {() => T} fn
 * @template T
 */
export function withPreservedPaths(base, paths, fn) {
  const saved = [];
  for (const path of paths) {
    const target = join(base, path);
    if (!existsSync(target)) continue;
    const backup = `${target}.ci-local-backup-${process.pid}`;
    if (existsSync(backup)) throw new Error(`${backup} already exists; move it before rerunning`);
    renameSync(target, backup);
    saved.push([target, backup]);
  }
  try {
    return fn();
  } finally {
    for (const path of paths) rmSync(join(base, path), { recursive: true, force: true });
    for (const [target, backup] of saved) renameSync(backup, target);
  }
}

function runStep(step) {
  const logPath = join(logDir, `${step.id}.log`);
  const chunks = [];
  const started = Date.now();
  let status = 0;
  try {
    status = withPreservedPaths(root, step.preserve ?? [], () => {
      for (const [command, ...args] of step.commands) {
        chunks.push(`$ ${[command, ...args].join(" ")}\n`);
        const result = spawnSync(command, args, {
          cwd: root,
          // CI sets CI=true; without it pnpm can stop on a no-TTY modules purge prompt.
          env: { ...process.env, CI: "true", ...step.env },
          encoding: "utf8",
          maxBuffer: 256 * 1024 * 1024,
          shell: process.platform === "win32",
          timeout: defaultTimeoutMs,
        });
        chunks.push(result.stdout ?? "", result.stderr ?? "");
        if (result.error) chunks.push(`\n${result.error.message}\n`);
        const commandStatus = result.status ?? 1;
        if (commandStatus !== 0) return commandStatus;
      }
      return 0;
    });
  } finally {
    writeFileSync(logPath, chunks.join(""));
  }
  return { status, seconds: (Date.now() - started) / 1000, logPath };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const step of ciLocalSteps) console.log(`${step.id.padEnd(18)} ${step.job}`);
    return 0;
  }

  let steps = ciLocalSteps;
  if (options.from) steps = steps.slice(steps.findIndex((step) => step.id === options.from));
  if (options.only) steps = steps.filter((step) => options.only.has(step.id));
  steps = steps.filter((step) => !options.skip.has(step.id));

  mkdirSync(logDir, { recursive: true });
  const docker = steps.some((step) => step.requires === "docker") && hasDocker();
  const results = [];
  for (const step of steps) {
    if (step.requires === "docker" && !docker) {
      console.log(`SKIP ${step.id} (Docker is not available; CI still runs "${step.job}")`);
      results.push({ step, outcome: "skip" });
      continue;
    }
    process.stdout.write(`RUN  ${step.id} ... `);
    const { status, seconds, logPath } = runStep(step);
    const outcome = status === 0 ? "pass" : "fail";
    console.log(`${outcome.toUpperCase()} (${seconds.toFixed(1)}s)`);
    if (outcome === "fail") {
      const tail = readFileSync(logPath, "utf8").trimEnd().split("\n").slice(-40).join("\n");
      console.log(`--- last lines of ${logPath} ---\n${tail}\n---`);
    }
    results.push({ step, outcome });
    if (outcome === "fail" && options.failFast) break;
  }

  const failed = results.filter((result) => result.outcome === "fail");
  const skipped = results.filter((result) => result.outcome === "skip");
  console.log(
    `\nci-local: ${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped. Logs: ${logDir}`,
  );
  for (const { step } of failed) console.log(`  failed: ${step.id} (${step.job})`);
  console.log("  CI only: runtime engine floor (Node.js 22.22.2), CodeQL analysis, Node.js matrix");
  return failed.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`ci-local: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
