#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, promises as fs, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { releaseRoot } from "./lib/release-utils.mjs";

// Batches the changie fragments in .changes/unreleased/ into .changes/v<version>.md
// and rebuilds CHANGELOG.md. Runs from the `pnpm version` lifecycle, so the
// version comes from the already-bumped package.json.

const require = createRequire(import.meta.url);

function changie(root, args) {
  const result = spawnSync(process.execPath, [require.resolve("changie/npm/changie.js"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`changie ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

async function main() {
  const root = releaseRoot();
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const version = String(pkg.version ?? "");
  if (!version) throw new Error("package.json version is missing");
  if (!existsSync(path.join(root, ".changie.yaml"))) throw new Error(".changie.yaml is missing");
  if (existsSync(path.join(root, ".changes", `v${version}.md`))) {
    throw new Error(`.changes/v${version}.md already exists`);
  }

  const unreleasedDir = path.join(root, ".changes", "unreleased");
  const fragments = existsSync(unreleasedDir)
    ? readdirSync(unreleasedDir).filter((name) => name.endsWith(".yaml"))
    : [];
  const batchArgs = ["batch", `v${version}`];
  if (fragments.length === 0) {
    console.warn(
      `cut-changelog: WARNING - no unreleased entries; releasing v${version} with no notes.`,
    );
    batchArgs.push("--allow-no-changes");
  }

  changie(root, batchArgs);
  changie(root, ["merge"]);
  console.log(`cut-changelog: batched ${fragments.length} change(s) into [${version}]`);
}

try {
  await main();
} catch (error) {
  console.error(`cut-changelog: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
