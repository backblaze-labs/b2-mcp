#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = mkdtempSync(path.join(os.tmpdir(), "b2-mcp-consumer-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspace,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) throw result.error;
  if (options.allowFailure !== true && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

try {
  const packed = run("npm", ["pack", "--json", "--pack-destination", workspace], { cwd: root });
  const [{ filename }] = JSON.parse(packed.stdout);
  const tarball = path.join(workspace, filename);

  writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({ private: true, name: "b2-mcp-packed-consumer", version: "0.0.0" }, null, 2),
  );

  run("npm", ["install", "--engine-strict", "--omit=dev", tarball]);
  run(process.execPath, [
    "-e",
    [
      'const pkg = require("@backblaze-labs/b2-mcp");',
      'const meta = require("@backblaze-labs/b2-mcp/package.json");',
      'if (typeof pkg.startStdio !== "function") throw new Error("missing startStdio export");',
      'if (meta.engines.node !== ">=22.3.0") throw new Error("wrong package engine");',
      'if (meta.bin["b2-mcp"] !== "dist/index.js") throw new Error("wrong b2-mcp bin");',
    ].join(" "),
  ]);

  const entrypoint = path.join(
    workspace,
    "node_modules",
    "@backblaze-labs",
    "b2-mcp",
    "dist",
    "index.js",
  );
  const withoutCreds = run(process.execPath, [entrypoint], {
    allowFailure: true,
    env: {
      ...process.env,
      B2_APPLICATION_KEY_ID: "",
      B2_APPLICATION_KEY: "",
      B2_REGISTER_ALL_TOOLS: "true",
    },
    timeout: 10_000,
  });
  if (withoutCreds.status !== 1) {
    throw new Error(`expected missing-credential startup to exit 1, got ${withoutCreds.status}`);
  }

  console.log(`packed-consumer-smoke: installed and executed ${filename}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
