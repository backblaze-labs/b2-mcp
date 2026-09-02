#!/usr/bin/env node
/**
 * Pack the MCPB (MCP Bundle) for Smithery's Local publish path.
 *
 * The bundle is a versioned release artifact — its `version` must match
 * `package.json` (kept in lockstep by `scripts/update-server-json-version.mjs`).
 * The output `.mcpb` is not committed; it is built on release and uploaded to
 * Smithery / attached to the GitHub Release. See docs/DISCOVERABILITY.md.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const root = process.cwd();
const outDir = path.join(root, "dist-mcpb");
const outFile = path.join(outDir, "b2-mcp.mcpb");

const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const manifestVersion = JSON.parse(
  readFileSync(path.join(root, "mcpb", "manifest.json"), "utf8"),
).version;
if (manifestVersion !== packageVersion) {
  console.error(
    `build-mcpb: mcpb/manifest.json version ${manifestVersion} does not match package.json ${packageVersion}. ` +
      "Run `node scripts/update-server-json-version.mjs` first.",
  );
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
execFileSync("npx", ["-y", MCPB_CLI, "pack", "mcpb", outFile], {
  cwd: root,
  stdio: "inherit",
});
console.log(`build-mcpb: packed ${outFile} (b2-mcp@${packageVersion})`);
