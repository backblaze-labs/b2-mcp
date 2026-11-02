import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { root } from "../contract/support";

// The wrapper derives its project root from its own location, so it is copied
// into a temp tree to keep the test from touching the real repo's .vercel dir.
function runInTempProject(pnpmScript: string) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "b2-mcp-vercel-project-build-"));
  try {
    const scriptsDir = path.join(tmpDir, "project", "scripts");
    const binDir = path.join(tmpDir, "bin");
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    for (const file of ["run-vercel-project-build.mjs", "vercel-build-policy.mjs"]) {
      copyFileSync(path.join(root, "scripts", file), path.join(scriptsDir, file));
    }
    writeFileSync(path.join(binDir, "pnpm"), pnpmScript);
    chmodSync(path.join(binDir, "pnpm"), 0o755);
    const result = spawnSync(process.execPath, [path.join(scriptsDir, "run-vercel-project-build.mjs")], {
      cwd: path.join(tmpDir, "project"),
      encoding: "utf8",
      timeout: 20_000,
      env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    const vercelDir = path.join(tmpDir, "project", ".vercel");
    return {
      result,
      lockLeft: existsSync(path.join(vercelDir, "project-build.lock")),
      markerWritten: existsSync(path.join(vercelDir, "project-build-complete")),
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("Vercel project build wrapper", () => {
  it("removes the build lock and keeps the exit status when a build step fails", () => {
    const { result, lockLeft, markerWritten } = runInTempProject("#!/bin/sh\nexit 3\n");

    expect(result.status).toBe(3);
    expect(markerWritten).toBe(false);
    expect(lockLeft).toBe(false);
  });

  it("removes the build lock after a successful build and writes the completion marker", () => {
    const { result, lockLeft, markerWritten } = runInTempProject("#!/bin/sh\nexit 0\n");

    expect(result.status).toBe(0);
    expect(markerWritten).toBe(true);
    expect(lockLeft).toBe(false);
  });
});
