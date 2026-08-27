import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";

const root = join(__dirname, "../..");

function writeFixtureFile(fixtureRoot: string, relativePath: string, contents: string): void {
  const absolutePath = join(fixtureRoot, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function withRuntimePolicyFixture(run: (fixtureRoot: string) => void): void {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "b2-mcp-runtime-policy-"));
  const packageManager = "pnpm@11.20.0+sha256.test";

  try {
    writeFixtureFile(
      fixtureRoot,
      "package.json",
      JSON.stringify(
        {
          name: "@backblaze-labs/b2-mcp",
          version: "0.1.0",
          packageManager,
          engines: { node: "^22.3.0 || ^24 || ^26" },
          dependencies: { "@backblaze-labs/b2-sdk": "0.3.0" },
          devDependencies: { "@types/node": "22.3.0" },
        },
        null,
        2,
      ),
    );
    writeFixtureFile(
      fixtureRoot,
      "runtime-policy.json",
      JSON.stringify(
        {
          engineRange: "^22.3.0 || ^24 || ^26",
          engineFloor: ">=22.3.0",
          runtimeInstallNode: "22.23.1",
          minimumEvidenceNode: "22.23.1",
          node22LtsMinimum: "22.11.0",
          node22Pinned: "22.23.1",
          deterministicLinuxMatrix: ["22.23.1", "24", "26"],
          crossPlatformNode: "22.23.1",
          liveNodeMatrix: ["22.23.1", "24", "26"],
          unsupportedMajors: [18, 20],
          typesNodeVersion: "22.3.0",
        },
        null,
        2,
      ),
    );
    writeFixtureFile(fixtureRoot, ".nvmrc", "22.23.1\n");
    writeFixtureFile(
      fixtureRoot,
      "environment.yml",
      "name: b2-mcp-test\ndependencies:\n  - nodejs=22.23.1=h35957e4_0\n",
    );
    writeFixtureFile(
      fixtureRoot,
      "pnpm-lock.yaml",
      [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      '@backblaze-labs/b2-sdk':",
        "        specifier: 0.3.0",
        "        version: 0.3.0",
        "    devDependencies:",
        "      '@types/node':",
        "        specifier: 22.3.0",
        "        version: 22.3.0",
        "",
        "packages:",
        "",
        "  '@backblaze-labs/b2-sdk@0.3.0':",
        "    resolution: {integrity: sha512-test}",
        "    engines: {node: '>=22.3.0'}",
        "",
        "  '@types/node@22.3.0':",
        "    resolution: {integrity: sha512-test}",
        "",
        "snapshots:",
        "",
        "  '@backblaze-labs/b2-sdk@0.3.0': {}",
        "",
        "  '@types/node@22.3.0': {}",
        "",
      ].join("\n"),
    );
    writeFixtureFile(
      fixtureRoot,
      ".github/workflows/test.yml",
      [
        "jobs:",
        "  format-lint-typecheck:",
        "    steps:",
        "      - with:",
        "          node-version: 22.23.1",
        "      - run: pnpm run verify",
        "  package-install-smoke:",
        "    steps:",
        "      - with:",
        "          node-version: 22.23.1",
        '      - run: node scripts/packed-consumer-smoke.mjs --tarball "$tarball"',
        "  runtime-engine-floor:",
        "    steps:",
        "      - with:",
        "          node-version: 22.3.0",
        "  unit-coverage-matrix:",
        "    strategy:",
        "      matrix:",
        "        node-version: [22.23.1, 24, 26]",
        "  production-dependency-audit-matrix:",
        "    strategy:",
        "      matrix:",
        "        node-version: [22.23.1, 24, 26]",
        "  cross-platform-minimum-matrix:",
        "    strategy:",
        "      matrix:",
        "        os: [ubuntu-latest, windows-latest, macos-latest]",
        "    steps:",
        "      - with:",
        "          node-version: 22.23.1",
        "  unsupported-node-23:",
        "    steps:",
        "      - with:",
        "          node-version: 23",
        "  unsupported-node-25:",
        "    steps:",
        "      - with:",
        "          node-version: 25.9.0",
        "",
      ].join("\n"),
    );
    for (const [workflow, jobName] of [
      [".github/workflows/contract.yml", "contract"],
      [".github/workflows/smoke.yml", "smoke"],
    ]) {
      writeFixtureFile(
        fixtureRoot,
        workflow,
        [
          "jobs:",
          `  ${jobName}:`,
          "    strategy:",
          "      max-parallel: 1",
          "      matrix:",
          "        node-version: [22.23.1, 24, 26]",
          "",
        ].join("\n"),
      );
    }
    writeFixtureFile(
      fixtureRoot,
      "README.md",
      `^22.3.0 || ^24 || ^26\n22.23.1\n${packageManager}\n`,
    );
    writeFixtureFile(
      fixtureRoot,
      "CONTRIBUTING.md",
      `^22.3.0 || ^24 || ^26\n22.23.1\n${packageManager}\n`,
    );
    writeFixtureFile(fixtureRoot, "docs/V1_SCOPE.md", "^22.3.0 || ^24 || ^26\n>=22.3.0\n");
    writeFixtureFile(
      fixtureRoot,
      "docs/DEPLOY.md",
      `^22.3.0 || ^24 || ^26\n22.23.1\n${packageManager}\n`,
    );
    writeFixtureFile(fixtureRoot, "docs/deployment/vercel.md", "^22.3.0 || ^24 || ^26\n");
    writeFixtureFile(fixtureRoot, "deploy/vercel/README.md", "^22.3.0 || ^24 || ^26\n");
    writeFixtureFile(fixtureRoot, "RELEASE.md", "22.23.1\n");
    writeFixtureFile(fixtureRoot, "CHANGELOG.md", "22.23.1\n");

    run(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe("runtime policy", () => {
  it("rejects workflow Node versions outside the supported engine range", () => {
    withRuntimePolicyFixture((fixtureRoot) => {
      const result = spawnSync(process.execPath, ["scripts/check-runtime-policy.mjs"], {
        cwd: root,
        env: { ...process.env, B2_MCP_RUNTIME_POLICY_ROOT: fixtureRoot },
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unsupported Node 23 is present");
      expect(result.stderr).toContain("unsupported Node 25.9.0 is present");
      expect(result.stderr).toContain("^22.3.0 || ^24 || ^26");
    });
  });

  it("rejects Pages workflows without deploy and package hardening", () => {
    withRuntimePolicyFixture((fixtureRoot) => {
      writeFixtureFile(
        fixtureRoot,
        ".github/workflows/docs.yml",
        [
          "on:",
          "  workflow_dispatch:",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: pnpm install --frozen-lockfile",
          "      - run: pnpm run docs",
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    runs-on: ubuntu-latest",
          "    permissions:",
          "      pages: write",
          "      id-token: write",
          "    steps:",
          "      - uses: actions/deploy-pages@def",
          "",
        ].join("\n"),
      );

      const result = spawnSync(process.execPath, ["scripts/check-runtime-policy.mjs"], {
        cwd: root,
        env: { ...process.env, B2_MCP_RUNTIME_POLICY_ROOT: fixtureRoot },
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages deploy job deploy must require github.ref == refs/heads/main",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages job build must declare timeout-minutes",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages job deploy must declare timeout-minutes",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages pnpm install step must use --ignore-scripts",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages pnpm install step must blank ACTIONS_RUNTIME_TOKEN",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages docs build step must blank ACTIONS_RUNTIME_TOKEN",
      );
    });
  });
});
