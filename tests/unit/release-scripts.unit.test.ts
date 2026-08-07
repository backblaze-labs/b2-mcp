import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const root = join(__dirname, "../..");

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
          engines: { node: ">=22.3.0" },
          bin: { "b2-mcp": "dist/index.js", "b2-mcp-server": "dist/index.js" },
          files: [
            "dist/**/*",
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

  it("includes the issue 64 release automation entry in v0.1.0 notes", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/extract-release-notes.mjs", "--version", "0.1.0"],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("issue #64 release verification");
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
