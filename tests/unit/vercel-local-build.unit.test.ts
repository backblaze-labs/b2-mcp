import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { root } from "../contract/support";

const scriptPath = path.join(root, "scripts/run-vercel-local-build.mjs");

function runWithFakePnpm(script: string) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "b2-mcp-vercel-local-build-"));
  const binDir = path.join(tmpDir, "bin");
  const globalConfigDir = path.join(tmpDir, "vercel-global");
  const fakePnpm = path.join(binDir, "pnpm");
  try {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(fakePnpm, script);
    chmodSync(fakePnpm, 0o755);

    return spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        B2_MCP_VERCEL_GLOBAL_CONFIG_DIR: globalConfigDir,
        NPM_TOKEN: "npm-token-must-not-reach-child",
      },
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("Vercel local build wrapper", () => {
  it("fails when Vercel exits zero but emits TypeScript diagnostics", () => {
    const result = runWithFakePnpm(`#!/bin/sh
printf '%s\\n' 'api/mcp.js(1,1): error TS2322: type mismatch'
exit 0
`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Vercel emitted TypeScript diagnostics");
  });

  it("passes through a clean successful Vercel build", () => {
    const result = runWithFakePnpm(`#!/bin/sh
printf '%s\\n' 'vercel build completed'
exit 0
`);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("vercel build completed");
  });
});
