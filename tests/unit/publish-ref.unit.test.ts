import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

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

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function runResolver(remote: string, tag: string, outputPath?: string) {
  const args = [script, "--tag", tag, "--remote", remote];
  if (outputPath) args.push("--output", outputPath);
  return spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
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

describe("publish ref resolver", () => {
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
