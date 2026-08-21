import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const root = join(__dirname, "../..");

type RegistryMetadataModule = {
  verifyNpmRegistryMetadata: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  isRetryableNpmViewFailure: (result: {
    status: number | null;
    stdout?: string;
    stderr?: string;
  }) => boolean;
  parseRegistryMetadata: (raw: unknown) => Record<string, unknown>;
  leakedRegistryMetadataKeys: (metadata: unknown) => string[];
};

async function registryMetadataModule(): Promise<RegistryMetadataModule> {
  return (await import(
    "../../scripts/verify-npm-registry-metadata.mjs"
  )) as unknown as RegistryMetadataModule;
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function withFixture(run: (fixtureRoot: string) => void): void {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "b2-mcp-release-scripts-"));
  try {
    mkdirSync(join(fixtureRoot, "docs"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "package.json"),
      JSON.stringify(
        {
          name: "@backblaze-labs/b2-mcp",
          version: "0.1.0",
          license: "MIT",
          repository: {
            type: "git",
            url: "git+https://github.com/backblaze-labs/b2-mcp.git",
          },
          bugs: { url: "https://github.com/backblaze-labs/b2-mcp/issues" },
          homepage: "https://github.com/backblaze-labs/b2-mcp#readme",
          engines: { node: "^22.3.0 || ^24 || ^26" },
          bin: { "b2-mcp": "dist/index.js", "b2-mcp-server": "dist/index.js" },
          files: [
            "dist/**/*",
            "docs/AUTHENTICATION.md",
            "docs/CLIENTS.md",
            "docs/DEPLOY.md",
            "docs/tool-profile-contract.json",
            "docs/TOOL_PROFILES.md",
            "README.md",
            "CHANGELOG.md",
            "SECURITY.md",
            "LICENSE",
          ],
          dependencies: { "@backblaze-labs/b2-sdk": "0.2.0" },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(fixtureRoot, "CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "### Added",
        "- Future change.",
        "",
        "## [0.1.0] - 2026-08-07",
        "",
        "### Added",
        "- Initial public package.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(fixtureRoot, "runtime-policy.json"),
      JSON.stringify({ engineRange: "^22.3.0 || ^24 || ^26" }, null, 2),
    );
    run(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function scriptEnv(fixtureRoot: string): NodeJS.ProcessEnv {
  return { ...process.env, NODE_ENV: "test", B2_MCP_RELEASE_ROOT: fixtureRoot };
}

describe("release scripts", () => {
  it("extracts release notes from the matching changelog version section", () => {
    withFixture((fixtureRoot) => {
      const output = join(fixtureRoot, "release-notes.md");
      const result = spawnSync(
        process.execPath,
        ["scripts/extract-release-notes.mjs", "--version", "0.1.0", "--output", output],
        { cwd: root, env: scriptEnv(fixtureRoot), encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(output, "utf8")).toContain("# @backblaze-labs/b2-mcp v0.1.0");
      expect(readFileSync(output, "utf8")).toContain("Initial public package.");
      expect(readFileSync(output, "utf8")).not.toContain("Future change.");
    });
  });

  it("promotes Unreleased notes into the bumped version changelog section", () => {
    withFixture((fixtureRoot) => {
      const packagePath = join(fixtureRoot, "package.json");
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      writeFileSync(packagePath, JSON.stringify({ ...pkg, version: "0.2.0" }, null, 2));

      const result = spawnSync(process.execPath, ["scripts/cut-changelog.mjs"], {
        cwd: root,
        env: scriptEnv(fixtureRoot),
        encoding: "utf8",
      });

      const changelog = readFileSync(join(fixtureRoot, "CHANGELOG.md"), "utf8");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("cut-changelog: promoted [Unreleased] to [0.2.0]");
      expect(changelog).toMatch(/^## \[Unreleased\]\n\n## \[0\.2\.0\] - \d{4}-\d{2}-\d{2}/m);
      expect(changelog).toContain("Future change.");
      expect(changelog).toContain(
        "[Unreleased]: https://github.com/backblaze-labs/b2-mcp/compare/v0.2.0...HEAD",
      );
      expect(changelog).toContain(
        "[0.2.0]: https://github.com/backblaze-labs/b2-mcp/compare/v0.1.0...v0.2.0",
      );
    });
  });

  it("runs the pnpm version changelog lifecycle with install scripts disabled", () => {
    withFixture((fixtureRoot) => {
      const packagePath = join(fixtureRoot, "package.json");
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      writeFileSync(
        packagePath,
        JSON.stringify(
          {
            ...pkg,
            scripts: {
              version: `node ${join(root, "scripts/cut-changelog.mjs")} && git add CHANGELOG.md`,
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(join(fixtureRoot, ".npmrc"), "ignore-scripts=true\n");
      runGit(fixtureRoot, ["init", "-b", "main"]);
      runGit(fixtureRoot, ["config", "user.email", "release@example.com"]);
      runGit(fixtureRoot, ["config", "user.name", "Release Test"]);
      runGit(fixtureRoot, ["add", "."]);
      runGit(fixtureRoot, ["commit", "-m", "initial"]);

      const result = spawnSync(
        "pnpm",
        ["version", "patch", "--no-git-tag-version", "--no-commit-hooks"],
        { cwd: fixtureRoot, env: scriptEnv(fixtureRoot), encoding: "utf8" },
      );
      const changelog = readFileSync(join(fixtureRoot, "CHANGELOG.md"), "utf8");
      const bumpedPackage = JSON.parse(readFileSync(packagePath, "utf8"));
      const stagedFiles = runGit(fixtureRoot, ["diff", "--cached", "--name-only"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("cut-changelog: promoted [Unreleased] to [0.1.1]");
      expect(bumpedPackage.version).toBe("0.1.1");
      expect(changelog).toMatch(/^## \[Unreleased\]\n\n## \[0\.1\.1\] - \d{4}-\d{2}-\d{2}/m);
      expect(stagedFiles.split(/\r?\n/)).toContain("CHANGELOG.md");
    });
  });

  it("keeps the issue 64 release automation entry in the changelog", () => {
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

    expect(changelog).toContain("issue #64 release verification");
  });

  it("derives safe npm dist-tags for stable and prerelease versions", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          'import { npmDistTag } from "./scripts/lib/release-utils.mjs";',
          "process.stdout.write(JSON.stringify([",
          '  npmDistTag("0.1.0"),',
          '  npmDistTag("0.2.0-rc.1"),',
          '  npmDistTag("0.2.0-preview.1"),',
          "]));",
        ].join("\n"),
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["latest", "rc", "next"]);
  });

  it("prints package publish metadata through the shared helper", () => {
    withFixture((fixtureRoot) => {
      const packagePath = join(fixtureRoot, "package.json");
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      writeFileSync(packagePath, JSON.stringify({ ...pkg, version: "0.2.0-preview.1" }, null, 2));

      const result = spawnSync(
        process.execPath,
        ["scripts/npm-publish-metadata.mjs", "--package-json", packagePath],
        { cwd: root, encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        spec: "@backblaze-labs/b2-mcp@0.2.0-preview.1",
        tag: "next",
      });
    });
  });

  it("writes a stable release marker after build output exists", () => {
    withFixture((fixtureRoot) => {
      mkdirSync(join(fixtureRoot, "dist"));

      const result = spawnSync(
        process.execPath,
        ["scripts/write-release-version.mjs", "--version", "0.1.0"],
        { cwd: root, env: scriptEnv(fixtureRoot), encoding: "utf8" },
      );
      const marker = JSON.parse(
        readFileSync(join(fixtureRoot, "dist/release-version.json"), "utf8"),
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("release-version: wrote dist/release-version.json");
      expect(marker).toEqual({
        name: "@backblaze-labs/b2-mcp",
        releaseChannel: "published",
        version: "0.1.0",
      });
    });
  });

  it("skips release markers for prerelease package versions", () => {
    withFixture((fixtureRoot) => {
      const packagePath = join(fixtureRoot, "package.json");
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      mkdirSync(join(fixtureRoot, "dist"));
      writeFileSync(packagePath, JSON.stringify({ ...pkg, version: "0.2.0-rc.1" }, null, 2));
      writeFileSync(join(fixtureRoot, "dist/release-version.json"), '{"version":"stale"}\n');

      const result = spawnSync(
        process.execPath,
        ["scripts/write-release-version.mjs", "--version", "0.2.0-rc.1"],
        { cwd: root, env: scriptEnv(fixtureRoot), encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("release-version: skipped dist/release-version.json");
      expect(() => readFileSync(join(fixtureRoot, "dist/release-version.json"), "utf8")).toThrow();
    });
  });

  it("cleans release markers after package lifecycle packing", () => {
    withFixture((fixtureRoot) => {
      mkdirSync(join(fixtureRoot, "dist"));
      writeFileSync(join(fixtureRoot, "dist/release-version.json"), '{"version":"stale"}\n');

      const result = spawnSync(process.execPath, ["scripts/write-release-version.mjs", "--clean"], {
        cwd: root,
        env: scriptEnv(fixtureRoot),
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("release-version: removed dist/release-version.json");
      expect(() => readFileSync(join(fixtureRoot, "dist/release-version.json"), "utf8")).toThrow();
    });
  });

  it("rejects leaked npm registry _from/_resolved metadata", async () => {
    const { verifyNpmRegistryMetadata } = await registryMetadataModule();

    await expect(
      verifyNpmRegistryMetadata({
        packageSpec: "@backblaze-labs/b2-mcp@9.9.9",
        viewMetadata: () => ({
          status: 0,
          stdout: JSON.stringify({
            _resolved:
              "/home/runner/work/b2-mcp/b2-mcp/publish-package/backblaze-labs-b2-mcp-9.9.9.tgz",
          }),
          stderr: "",
        }),
        wait: async () => undefined,
        log: { log: () => undefined, warn: () => undefined },
      }),
    ).rejects.toThrow("registry metadata exposes local publish coordinates");
  });

  it("classifies npm view failures as retryable only for transient signals", async () => {
    const { isRetryableNpmViewFailure } = await registryMetadataModule();
    const failing = (stderr: string) =>
      isRetryableNpmViewFailure({ status: 1, stdout: "", stderr });

    expect(failing("npm error 503 registry busy")).toBe(true);
    expect(failing("npm error 429 Too Many Requests")).toBe(true);
    expect(failing("npm error code E404")).toBe(true);
    expect(failing("npm error network timeout while fetching")).toBe(true);
    // Non-transient failures must fail fast, not retry to the deadline.
    expect(failing("npm error code E403 403 Forbidden")).toBe(false);
    expect(failing("EACCES: permission denied")).toBe(false);
    // An embedded version/number must not be misread as an HTTP status.
    expect(failing("cannot find matching version 1.500.0")).toBe(false);
  });

  it("reads registry metadata without assuming absent _from/_resolved are present", async () => {
    const { parseRegistryMetadata, leakedRegistryMetadataKeys } = await registryMetadataModule();

    expect(parseRegistryMetadata("")).toEqual({});
    expect(parseRegistryMetadata("{}")).toEqual({});
    expect(leakedRegistryMetadataKeys(parseRegistryMetadata("{}"))).toEqual([]);
    expect(leakedRegistryMetadataKeys({ _resolved: "" })).toEqual([]);
    expect(
      leakedRegistryMetadataKeys({ _from: "file:x.tgz", _resolved: "/Users/x/x.tgz" }),
    ).toEqual(["_from", "_resolved"]);
  });

  it("retries not-yet-visible npm registry metadata before passing", async () => {
    const { verifyNpmRegistryMetadata } = await registryMetadataModule();
    const warnings: string[] = [];
    const delays: number[] = [];
    let attempts = 0;

    const result = await verifyNpmRegistryMetadata({
      packageSpec: "@backblaze-labs/b2-mcp@9.9.9",
      timeoutMs: 1_000,
      initialIntervalMs: 1,
      maxIntervalMs: 4,
      viewMetadata: () => {
        attempts += 1;
        return attempts === 1
          ? { status: 1, stdout: "", stderr: "npm ERR! 404 not found" }
          : { status: 0, stdout: "{}", stderr: "" };
      },
      wait: async (delayMs: number) => {
        delays.push(delayMs);
      },
      log: { log: () => undefined, warn: (message: string) => warnings.push(message) },
    });

    expect(result).toMatchObject({ status: "verified", attempts: 2 });
    expect(delays).toEqual([1]);
    expect(warnings.join("\n")).toContain("retrying npm view");
  });

  it("allows matching-integrity reruns for documented legacy metadata leaks", async () => {
    const { verifyNpmRegistryMetadata } = await registryMetadataModule();
    const warnings: string[] = [];

    const result = await verifyNpmRegistryMetadata({
      packageSpec: "@backblaze-labs/b2-mcp@0.1.1",
      allowedLegacySpecs: new Set(["@backblaze-labs/b2-mcp@0.1.1"]),
      viewMetadata: () => ({
        status: 0,
        stdout: JSON.stringify({
          _from: "file:publish-package/backblaze-labs-b2-mcp-0.1.1.tgz",
          _resolved:
            "/home/runner/work/b2-mcp/b2-mcp/publish-package/backblaze-labs-b2-mcp-0.1.1.tgz",
        }),
        stderr: "",
      }),
      wait: async () => undefined,
      log: { log: () => undefined, warn: (message: string) => warnings.push(message) },
    });

    expect(result).toMatchObject({ status: "legacy-allowed", leaked: ["_from", "_resolved"] });
    expect(warnings.join("\n")).toContain("matching-integrity rerun is allowed");
  });

  it("fails registry metadata verification when the retry deadline expires", async () => {
    const { verifyNpmRegistryMetadata } = await registryMetadataModule();
    let nowCalls = 0;

    await expect(
      verifyNpmRegistryMetadata({
        packageSpec: "@backblaze-labs/b2-mcp@9.9.9",
        timeoutMs: 5,
        initialIntervalMs: 1,
        viewMetadata: () => ({ status: 1, stdout: "", stderr: "npm ERR! 503 registry busy" }),
        wait: async () => undefined,
        now: () => {
          nowCalls += 1;
          return nowCalls === 1 ? 0 : 10;
        },
        log: { log: () => undefined, warn: () => undefined },
      }),
    ).rejects.toThrow("did not complete within 5ms");
  });

  it("verifies tag, metadata, package files, and changelog agreement", () => {
    withFixture((fixtureRoot) => {
      const result = spawnSync(
        process.execPath,
        ["scripts/verify-release-input.mjs", "--tag", "v0.1.0"],
        { cwd: root, env: scriptEnv(fixtureRoot), encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("release-input: verified v0.1.0");
    });
  });

  it("rejects tag/version mismatches", () => {
    withFixture((fixtureRoot) => {
      const result = spawnSync(
        process.execPath,
        ["scripts/verify-release-input.mjs", "--tag", "v0.2.0"],
        { cwd: root, env: scriptEnv(fixtureRoot), encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("does not match package version 0.1.0");
    });
  });
});
