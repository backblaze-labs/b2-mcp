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
          engines: { node: "^22.22.2 || ^24 || ^26" },
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
          engineRange: "^22.22.2 || ^24 || ^26",
          engineFloor: ">=22.22.2",
          backblazeSdkEngineFloor: ">=22.3.0",
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
        "          node-version: 22.22.2",
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
      `^22.22.2 || ^24 || ^26\n22.23.1\n${packageManager}\n`,
    );
    writeFixtureFile(
      fixtureRoot,
      "CONTRIBUTING.md",
      `^22.22.2 || ^24 || ^26\n22.23.1\n${packageManager}\n`,
    );
    writeFixtureFile(fixtureRoot, "docs/V1_SCOPE.md", "^22.22.2 || ^24 || ^26\n>=22.22.2\n");
    writeFixtureFile(
      fixtureRoot,
      "docs/DEPLOY.md",
      `^22.22.2 || ^24 || ^26\n22.23.1\n${packageManager}\n`,
    );
    writeFixtureFile(fixtureRoot, "docs/deployment/vercel.md", "^22.22.2 || ^24 || ^26\n");
    writeFixtureFile(fixtureRoot, "deploy/vercel/README.md", "^22.22.2 || ^24 || ^26\n");
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
      expect(result.stderr).toContain("^22.22.2 || ^24 || ^26");
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
        ".github/workflows/docs.yml: Pages artifact job build must run pnpm install with --ignore-scripts",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages docs build step must blank ACTIONS_RUNTIME_TOKEN",
      );
    });
  });

  it("rejects indented Pages workflows without package hardening", () => {
    withRuntimePolicyFixture((fixtureRoot) => {
      writeFixtureFile(
        fixtureRoot,
        ".github/workflows/docs.yml",
        [
          "on:",
          "  workflow_dispatch:",
          "jobs:",
          "    build:",
          "        runs-on: ubuntu-latest",
          "        steps:",
          "          - run: npm install",
          "          - uses: actions/upload-pages-artifact@abc",
          "    deploy:",
          "        runs-on: ubuntu-latest",
          "        permissions:",
          "          pages: write",
          "          id-token: write",
          "        steps:",
          "          - uses: actions/deploy-pages@def",
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
        ".github/workflows/docs.yml: Pages artifact job build has unexpected package command",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages artifact job build must run pnpm install with --ignore-scripts",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages artifact job build must run pnpm run docs",
      );
    });
  });

  it("rejects commented Pages workflows without package hardening", () => {
    withRuntimePolicyFixture((fixtureRoot) => {
      writeFixtureFile(
        fixtureRoot,
        ".github/workflows/docs.yml",
        [
          "on:",
          "  workflow_dispatch:",
          "jobs:",
          "# comment before build",
          "  build: # docs job",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: npm install",
          "      - uses: actions/upload-pages-artifact@abc",
          "# comment before deploy",
          "  deploy: # pages job",
          "    if: github.ref == 'refs/heads/main'",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
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
        ".github/workflows/docs.yml: Pages artifact job build has unexpected package command",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages artifact job build must run pnpm install with --ignore-scripts",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages artifact job build must run pnpm run docs",
      );
    });
  });

  it("rejects Pages package commands after comment-only step lines", () => {
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
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: pnpm install --frozen-lockfile --ignore-scripts",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "# comment before unexpected command",
          "      - run: npm install",
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    if: github.ref == 'refs/heads/main'",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
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
        ".github/workflows/docs.yml: Pages artifact job build has unexpected package command",
      );
    });
  });

  it("rejects anchored Pages workflows after nested jobs metadata", () => {
    withRuntimePolicyFixture((fixtureRoot) => {
      writeFixtureFile(
        fixtureRoot,
        ".github/workflows/docs.yml",
        [
          "on:",
          "  workflow_call:",
          "    inputs:",
          "      jobs:",
          "        type: string",
          "jobs:",
          "  build: &docs-build",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: npm install",
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy: &pages-deploy",
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
        ".github/workflows/docs.yml: Pages job deploy must declare timeout-minutes",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages artifact job build has unexpected package command",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages artifact job build must run pnpm install with --ignore-scripts",
      );
    });
  });

  it("rejects Pages workflows using escaped and aliased scalars", () => {
    withRuntimePolicyFixture((fixtureRoot) => {
      writeFixtureFile(
        fixtureRoot,
        ".github/workflows/docs.yml",
        [
          "on:",
          "  workflow_dispatch:",
          "x-upload: &upload actions/upload-pages-artifact@abc",
          "x-unsafe: &unsafe npm install",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: pnpm install --frozen-lockfile --ignore-scripts",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - run: *unsafe",
          "      - uses: *upload",
          "  deploy:",
          "    runs-on: ubuntu-latest",
          "    permissions:",
          "      pages: write",
          "      id-token: write",
          "    steps:",
          '      - uses: "actions/deploy-\\u0070ages@def"',
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
        ".github/workflows/docs.yml: Pages job deploy must declare timeout-minutes",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages artifact job build has unexpected package command",
      );
    });
  });

  it("rejects Pages workflows using quoted keys and mixed-case bare sequence steps", () => {
    withRuntimePolicyFixture((fixtureRoot) => {
      writeFixtureFile(
        fixtureRoot,
        ".github/workflows/docs.yml",
        [
          "on:",
          "  workflow_dispatch:",
          '"jobs":',
          '  "build":',
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 15",
          '    "steps":',
          "      -",
          "        run: npm install",
          "      -",
          "        uses: Actions/Upload-Pages-Artifact@abc",
          "  'deploy':",
          "    runs-on: ubuntu-latest",
          "    permissions:",
          "      pages: write",
          "      id-token: write",
          "    steps:",
          "      -",
          "        uses: Actions/Deploy-Pages@def",
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
        ".github/workflows/docs.yml: Pages job deploy must declare timeout-minutes",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages artifact job build has unexpected package command",
      );
    });
  });

  it("rejects Pages run aliases spoofed by block scalar text", () => {
    withRuntimePolicyFixture((fixtureRoot) => {
      writeFixtureFile(
        fixtureRoot,
        ".github/workflows/docs.yml",
        [
          "on:",
          "  workflow_dispatch:",
          "x-cmd: &cmd npm install",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: *cmd",
          "      - name: |",
          "          ignored: &cmd pnpm install --frozen-lockfile --ignore-scripts",
          "      - run: pnpm install --frozen-lockfile --ignore-scripts",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    if: github.ref == 'refs/heads/main'",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
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
        ".github/workflows/docs.yml: Pages artifact job build has unexpected package command",
      );
    });
  });

  it("rejects obfuscated Pages package commands", () => {
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
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: pnpm install --frozen-lockfile --ignore-scripts",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - run: n\\pm install",
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    if: github.ref == 'refs/heads/main'",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
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
        ".github/workflows/docs.yml: Pages artifact job build has unexpected package command",
      );
    });
  });

  it("rejects Pages artifact jobs missing the expected package steps", () => {
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
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: npm install",
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    if: github.ref == 'refs/heads/main'",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
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
        ".github/workflows/docs.yml: Pages artifact job build has unexpected package command",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages artifact job build must run pnpm install with --ignore-scripts",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages artifact job build must run pnpm run docs",
      );
    });
  });

  it("rejects Pages exact package steps without blanked env", () => {
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
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: pnpm install --frozen-lockfile --ignore-scripts",
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    if: github.ref == 'refs/heads/main'",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
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
        ".github/workflows/docs.yml: Pages pnpm install step must blank ACTIONS_RUNTIME_TOKEN",
      );
      expect(result.stderr).not.toContain(
        ".github/workflows/docs.yml: Pages docs build step must blank ACTIONS_RUNTIME_TOKEN",
      );
    });
  });

  it("rejects Pages package steps with heredoc-spoofed env blanks", () => {
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
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: |",
          "          pnpm install --frozen-lockfile --ignore-scripts",
          "          cat <<'EOF'",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "          EOF",
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    if: github.ref == 'refs/heads/main'",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
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
        ".github/workflows/docs.yml: Pages artifact job build has unexpected package command",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages artifact job build must run pnpm install with --ignore-scripts",
      );
    });
  });

  it("rejects Pages commands present only in heredoc or comment text", () => {
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
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: |",
          "          cat <<'EOF'",
          "          pnpm install --frozen-lockfile --ignore-scripts",
          "          pnpm run docs",
          "          EOF",
          "          # pnpm install --frozen-lockfile --ignore-scripts",
          "          # pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    if: github.ref == 'refs/heads/main'",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
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
        ".github/workflows/docs.yml: Pages artifact job build has unexpected package command",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages artifact job build must run pnpm install with --ignore-scripts",
      );
      expect(result.stderr).toContain(
        ".github/workflows/docs.yml: Pages artifact job build must run pnpm run docs",
      );
    });
  });

  it("rejects Pages deploy jobs hidden in flow-style mappings", () => {
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
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: pnpm install --frozen-lockfile --ignore-scripts",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - uses: actions/upload-pages-artifact@abc",
          '  deploy: { runs-on: ubuntu-latest, steps: [{ uses: "actions/deploy-\\u0070ages@def" }] }',
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
        ".github/workflows/docs.yml: job deploy uses an unsupported inline mapping form",
      );
    });
  });

  it("rejects Pages run aliases resolving a redefined anchor", () => {
    withRuntimePolicyFixture((fixtureRoot) => {
      writeFixtureFile(
        fixtureRoot,
        ".github/workflows/docs.yml",
        [
          "on:",
          "  workflow_dispatch:",
          "x-approved: &cmd pnpm install --frozen-lockfile --ignore-scripts",
          "x-later: &cmd npm install",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: *cmd",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    if: github.ref == 'refs/heads/main'",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
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
        ".github/workflows/docs.yml: alias *cmd resolves a redefined anchor",
      );
    });
  });

  it("rejects Pages deploy actions hidden in flow-style steps", () => {
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
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: pnpm install --frozen-lockfile --ignore-scripts",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
          '    steps: [{ uses: "actions/deploy-\\u0070ages@def" }]',
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
        ".github/workflows/docs.yml: job deploy uses an unsupported inline steps form",
      );
    });
  });

  it("rejects individual Pages steps written in flow-mapping form", () => {
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
          "    timeout-minutes: 15",
          "    steps:",
          '      - { uses: "actions/deploy-\\u0070ages@def" }',
          "  deploy:",
          "    if: github.ref == 'refs/heads/main'",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
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
        ".github/workflows/docs.yml: job build uses an unsupported inline step form",
      );
    });
  });

  it("rejects Pages deploy actions written with escaped keys and values", () => {
    withRuntimePolicyFixture((fixtureRoot) => {
      writeFixtureFile(
        fixtureRoot,
        ".github/workflows/docs.yml",
        [
          "on:",
          "  workflow_dispatch:",
          "jobs:",
          "  deploy:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          '      - "\\x75ses": "actions/deploy-\\x70ages@def"',
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
        ".github/workflows/docs.yml: Pages job deploy must declare timeout-minutes",
      );
    });
  });

  it("rejects Pages steps that run under a custom shell wrapper", () => {
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
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: pnpm install --frozen-lockfile --ignore-scripts",
          "        shell: custom-wrapper {0}",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    if: github.ref == 'refs/heads/main'",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
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
        ".github/workflows/docs.yml: Pages workflow must use a trusted default shell",
      );
    });
  });

  it("rejects a custom shell declared on a step dash line", () => {
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
          "    timeout-minutes: 15",
          "    steps:",
          "      - shell: custom-wrapper {0}",
          "        run: pnpm install --frozen-lockfile --ignore-scripts",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    if: github.ref == 'refs/heads/main'",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
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
        ".github/workflows/docs.yml: Pages workflow must use a trusted default shell",
      );
    });
  });

  it("rejects Pages deploy actions split across continued quoted scalars", () => {
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
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: pnpm install --frozen-lockfile --ignore-scripts",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
          "    steps:",
          '      - uses: "actions/deploy-\\',
          'pages@def"',
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
        ".github/workflows/docs.yml: continued double-quoted scalar is not supported",
      );
    });
  });

  it("rejects aliases to anchors nested in flow collections", () => {
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
          "    timeout-minutes: 15",
          "    strategy:",
          "      matrix:",
          '        marker: [&pages "actions/deploy-\\u0070ages@sha"]',
          "    steps:",
          "      - run: pnpm install --frozen-lockfile --ignore-scripts",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
          "    steps:",
          "      - uses: *pages",
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
        ".github/workflows/docs.yml: alias *pages refers to an unresolved anchor",
      );
    });
  });

  it("rejects Pages step keys split across continued quoted scalars", () => {
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
          "    timeout-minutes: 15",
          "    steps:",
          '      - "r\\',
          'un": npm install',
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    if: github.ref == 'refs/heads/main'",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
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
        ".github/workflows/docs.yml: continued double-quoted scalar is not supported",
      );
    });
  });

  it("rejects Pages deploy actions in indentationless step sequences", () => {
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
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: pnpm install --frozen-lockfile --ignore-scripts",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
          "    steps:",
          '    - uses: "actions/deploy-\\u0070ages@def"',
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
        ".github/workflows/docs.yml: job deploy uses an unsupported indentationless steps form",
      );
    });
  });

  it("reads Pages commands from block scalars with an indentation indicator", () => {
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
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: |2-",
          "          pnpm install --frozen-lockfile --ignore-scripts",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    if: github.ref == 'refs/heads/main'",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
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

      // The indented-indicator block scalar must resolve to the approved install
      // command, so neither the unexpected-command nor missing-install error fires.
      expect(result.stderr).not.toContain(
        ".github/workflows/docs.yml: Pages artifact job build has unexpected package command",
      );
      expect(result.stderr).not.toContain(
        ".github/workflows/docs.yml: Pages artifact job build must run pnpm install with --ignore-scripts",
      );
    });
  });

  it("rejects a custom shell hidden in flow-style defaults", () => {
    withRuntimePolicyFixture((fixtureRoot) => {
      writeFixtureFile(
        fixtureRoot,
        ".github/workflows/docs.yml",
        [
          "on:",
          "  workflow_dispatch:",
          'defaults: { run: { shell: "custom-wrapper {0}" } }',
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 15",
          "    steps:",
          "      - run: pnpm install --frozen-lockfile --ignore-scripts",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - run: pnpm run docs",
          "        env:",
          '          ACTIONS_CACHE_URL: ""',
          '          ACTIONS_RESULTS_URL: ""',
          '          ACTIONS_RUNTIME_TOKEN: ""',
          '          ACTIONS_RUNTIME_URL: ""',
          "      - uses: actions/upload-pages-artifact@abc",
          "  deploy:",
          "    if: github.ref == 'refs/heads/main'",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
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
        ".github/workflows/docs.yml: Pages workflow must not use a flow-style defaults mapping",
      );
    });
  });

  it("rejects anchored flow-mapping Pages steps", () => {
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
          "    timeout-minutes: 15",
          "    steps:",
          '      - &deploy { uses: "actions/deploy-\\u0070ages@sha" }',
          "  deploy:",
          "    if: github.ref == 'refs/heads/main'",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
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
        ".github/workflows/docs.yml: job build uses an unsupported inline step form",
      );
    });
  });
});
