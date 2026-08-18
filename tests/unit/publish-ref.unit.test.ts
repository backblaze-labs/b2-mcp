import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, spawnSync } from "child_process";

const root = join(__dirname, "../..");
const script = join(root, "scripts/resolve-publish-ref.mjs");

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "b2-mcp-publish-ref-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "b2-mcp-publish-ref-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function runResolver(remote: string, tag: string, outputPath?: string, extraArgs: string[] = []) {
  const args = [script, "--tag", tag, "--remote", remote];
  if (outputPath) args.push("--output", outputPath);
  args.push(...extraArgs);
  return spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
}

function runResolverAsync(
  remote: string,
  tag: string,
  outputPath: string,
  extraArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const args = [script, "--tag", tag, "--remote", remote, "--output", outputPath, ...extraArgs];
  const child = spawn(process.execPath, args, { cwd: root, env });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function createRepo(dir: string) {
  runGit(dir, ["init", "-b", "main"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  writeFileSync(join(dir, "README.md"), "initial\n");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "initial"]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

function realGitPath() {
  const result = spawnSync("which", ["git"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`which git failed: ${result.stderr}`);
  return result.stdout.trim();
}

function fakeGitFetchFailsOnceEnv(dir: string): NodeJS.ProcessEnv {
  const fakeGit = join(dir, "git");
  const state = join(dir, "fake-git-state");
  writeFileSync(
    fakeGit,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const cp = require("node:child_process");',
      "const args = process.argv.slice(2);",
      "const attempts = fs.existsSync(process.env.B2_MCP_FAKE_GIT_STATE)",
      "  ? Number(fs.readFileSync(process.env.B2_MCP_FAKE_GIT_STATE, 'utf8'))",
      "  : 0;",
      "if (args[0] === 'fetch' && attempts < 3) {",
      "  fs.writeFileSync(process.env.B2_MCP_FAKE_GIT_STATE, String(attempts + 1));",
      "  console.error('fake transient git fetch failure');",
      "  process.exit(128);",
      "}",
      "const result = cp.spawnSync(process.env.B2_MCP_REAL_GIT, args, { stdio: 'inherit' });",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGit, 0o755);
  return {
    ...process.env,
    B2_MCP_FAKE_GIT_STATE: state,
    B2_MCP_REAL_GIT: realGitPath(),
    PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
  };
}

describe("publish ref resolver", () => {
  it("documents every accepted wait option in help output", () => {
    const result = spawnSync(process.execPath, [script, "--help"], { cwd: root, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--wait-for-ci-green-timeout-ms");
    expect(result.stdout).toContain("--wait-for-ci-green-interval-ms");
  });

  it.each(["v0.1.0", "v1.2.3-rc.1"])("accepts release tag %s at ci-green", (tag) => {
    withTempDir((dir) => {
      const sha = createRepo(dir);
      runGit(dir, ["branch", "ci-green", sha]);
      runGit(dir, ["tag", "--no-sign", tag, sha]);
      const output = join(dir, "github-output");

      const result = runResolver(dir, tag, output);

      expect(result.status).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(`checkout_sha=${sha}\n`);
    });
  });

  it("peels an annotated release tag to its commit", () => {
    withTempDir((dir) => {
      const sha = createRepo(dir);
      runGit(dir, ["branch", "ci-green", sha]);
      runGit(dir, ["tag", "--annotate", "v0.1.0", "--message", "release", sha]);
      const tagObjectSha = runGit(dir, ["rev-parse", "refs/tags/v0.1.0"]);
      const output = join(dir, "github-output");

      const result = runResolver(dir, "v0.1.0", output);

      expect(tagObjectSha).not.toBe(sha);
      expect(result.status).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(`checkout_sha=${sha}\n`);
      expect(result.stdout).toContain(`v0.1.0 resolves to ${sha}`);
    });
  });

  it("accepts a v tag that is an ancestor of the current ci-green tip", () => {
    withTempDir((dir) => {
      const tagSha = createRepo(dir);
      runGit(dir, ["tag", "--no-sign", "v0.1.0", tagSha]);
      writeFileSync(join(dir, "README.md"), "later green commit\n");
      runGit(dir, ["add", "README.md"]);
      runGit(dir, ["commit", "-m", "later"]);
      const ciGreenSha = runGit(dir, ["rev-parse", "HEAD"]);
      runGit(dir, ["branch", "ci-green", ciGreenSha]);
      const output = join(dir, "github-output");

      const result = runResolver(dir, "v0.1.0", output);

      expect(result.status).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(`checkout_sha=${tagSha}\n`);
      expect(result.stdout).toContain(`reachable from ci-green ${ciGreenSha}`);
    });
  });

  it("rejects tags that do not use the release tag format", () => {
    withTempDir((dir) => {
      const sha = createRepo(dir);
      runGit(dir, ["branch", "ci-green", sha]);
      runGit(dir, ["tag", "--no-sign", "release-0.1.0", sha]);

      const result = runResolver(dir, "release-0.1.0");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Publish tag must be a valid vMAJOR.MINOR.PATCH tag");
    });
  });

  it.each([
    "v0.1.0:refs/heads/main",
    "v0.1.0 candidate",
    "v0.1",
    "v01.2.3",
    "v0.1.0^{}",
    "v0.1.0+build",
    "v0.1.0-01",
  ])("rejects unsafe or malformed publish tag %s before invoking git", (tag) => {
    withTempDir((dir) => {
      const result = runResolver(dir, tag);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Publish tag must be a valid vMAJOR.MINOR.PATCH tag");
      expect(result.stderr).not.toContain("git ls-remote failed");
    });
  });

  it("rejects a release tag that is not reachable from ci-green", () => {
    withTempDir((dir) => {
      const ciGreenSha = createRepo(dir);
      runGit(dir, ["branch", "ci-green", ciGreenSha]);
      writeFileSync(join(dir, "README.md"), "changed\n");
      runGit(dir, ["add", "README.md"]);
      runGit(dir, ["commit", "-m", "changed"]);
      const tagSha = runGit(dir, ["rev-parse", "HEAD"]);
      runGit(dir, ["tag", "--no-sign", "v0.2.0", tagSha]);

      const result = runResolver(dir, "v0.2.0");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must be reachable from refs/heads/ci-green");
      expect(result.stderr).toContain(`ci_green_sha=${ciGreenSha}`);
      expect(result.stderr).toContain(`tag_sha=${tagSha}`);
    });
  });

  it("times out while waiting for a tag that never reaches ci-green", () => {
    withTempDir((dir) => {
      const ciGreenSha = createRepo(dir);
      runGit(dir, ["branch", "ci-green", ciGreenSha]);
      writeFileSync(join(dir, "README.md"), "changed\n");
      runGit(dir, ["add", "README.md"]);
      runGit(dir, ["commit", "-m", "changed"]);
      const tagSha = runGit(dir, ["rev-parse", "HEAD"]);
      runGit(dir, ["tag", "--no-sign", "v0.2.0", tagSha]);

      const result = runResolver(dir, "v0.2.0", undefined, [
        "--wait-for-ci-green-timeout-ms",
        "1",
        "--wait-for-ci-green-interval-ms",
        "1",
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Timed out waiting for refs/tags/v0.2.0 to reach refs/heads/ci-green",
      );
      expect(result.stderr).toContain(`ci_green_sha=${ciGreenSha}`);
      expect(result.stderr).toContain(`tag_sha=${tagSha}`);
    });
  });

  it("succeeds when a pending main tag reaches ci-green during the wait", async () => {
    await withTempDirAsync(async (dir) => {
      const ciGreenSha = createRepo(dir);
      runGit(dir, ["branch", "ci-green", ciGreenSha]);
      writeFileSync(join(dir, "README.md"), "release commit\n");
      runGit(dir, ["add", "README.md"]);
      runGit(dir, ["commit", "-m", "release"]);
      const tagSha = runGit(dir, ["rev-parse", "HEAD"]);
      runGit(dir, ["tag", "--no-sign", "v0.2.0", tagSha]);
      const output = join(dir, "github-output");
      const resultPromise = runResolverAsync(dir, "v0.2.0", output, [
        "--wait-for-ci-green-timeout-ms",
        "5000",
        "--wait-for-ci-green-interval-ms",
        "100",
      ]);

      setTimeout(() => {
        runGit(dir, ["branch", "-f", "ci-green", tagSha]);
      }, 250);

      const result = await resultPromise;
      expect(result.status).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(`checkout_sha=${tagSha}\n`);
      expect(result.stdout).toContain(`reachable from ci-green ${tagSha}`);
    });
  });

  it("keeps waiting after a transient git fetch failure", async () => {
    await withTempDirAsync(async (dir) => {
      const ciGreenSha = createRepo(dir);
      runGit(dir, ["branch", "ci-green", ciGreenSha]);
      writeFileSync(join(dir, "README.md"), "release commit\n");
      runGit(dir, ["add", "README.md"]);
      runGit(dir, ["commit", "-m", "release"]);
      const tagSha = runGit(dir, ["rev-parse", "HEAD"]);
      runGit(dir, ["tag", "--no-sign", "v0.2.0", tagSha]);
      const output = join(dir, "github-output");
      const resultPromise = runResolverAsync(
        dir,
        "v0.2.0",
        output,
        ["--wait-for-ci-green-timeout-ms", "5000", "--wait-for-ci-green-interval-ms", "100"],
        fakeGitFetchFailsOnceEnv(dir),
      );

      setTimeout(() => {
        runGit(dir, ["branch", "-f", "ci-green", tagSha]);
      }, 250);

      const result = await resultPromise;
      expect(result.status).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(`checkout_sha=${tagSha}\n`);
      expect(result.stderr).toContain("retryable remote ref verification failure");
      expect(result.stdout).toContain(`reachable from ci-green ${tagSha}`);
    });
  });

  it("fails fast when a pending tag is not reachable from main", () => {
    withTempDir((dir) => {
      const ciGreenSha = createRepo(dir);
      runGit(dir, ["branch", "ci-green", ciGreenSha]);
      runGit(dir, ["checkout", "-b", "attacker"]);
      writeFileSync(join(dir, "README.md"), "unreviewed tag commit\n");
      runGit(dir, ["add", "README.md"]);
      runGit(dir, ["commit", "-m", "unreviewed"]);
      const tagSha = runGit(dir, ["rev-parse", "HEAD"]);
      runGit(dir, ["tag", "--no-sign", "v9.9.9", tagSha]);
      runGit(dir, ["checkout", "main"]);

      const result = runResolver(dir, "v9.9.9", undefined, [
        "--wait-for-ci-green-timeout-ms",
        "5000",
        "--wait-for-ci-green-interval-ms",
        "100",
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "refs/tags/v9.9.9 is not reachable from refs/heads/main or refs/heads/ci-green",
      );
      expect(result.stderr).toContain(`ci_green_sha=${ciGreenSha}`);
      expect(result.stderr).toContain(`tag_sha=${tagSha}`);
    });
  });

  it("rejects a missing ci-green ref", () => {
    withTempDir((dir) => {
      const sha = createRepo(dir);
      runGit(dir, ["tag", "--no-sign", "v0.1.0", sha]);

      const result = runResolver(dir, "v0.1.0");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("refs/heads/ci-green is missing");
    });
  });
});
