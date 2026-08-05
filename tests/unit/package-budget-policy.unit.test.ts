import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const root = join(__dirname, "../..");
const script = join(root, "scripts/check-package-budget.mjs");
const sdkProvenance = {
  version: "0.2.0",
  resolved: "https://registry.npmjs.org/@backblaze-labs/b2-sdk/-/b2-sdk-0.2.0.tgz",
  integrity:
    "sha512-qYjCVtFuiHp54R8okZbuG7oVU0U0Xj9A/Yn4VBLeMKp5JxVKFp3+M3Ywry+aB6ZKX24P3NTh8JURZMGuayFWDQ==",
};

function writeFixture(
  sourceText: string,
  options: {
    packageSpec?: string;
    lockEntry?: Partial<typeof sdkProvenance>;
    optionalDependencies?: Record<string, string>;
    lockPackages?: Record<
      string,
      {
        version: string;
        resolved: string;
        integrity: string;
        dependencies?: Record<string, string>;
      }
    >;
  } = {},
): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "b2-mcp-package-budget-policy-"));
  mkdirSync(join(fixtureRoot, "src"), { recursive: true });
  writeFileSync(join(fixtureRoot, "src/index.ts"), sourceText);

  const packageSpec = options.packageSpec ?? sdkProvenance.version;
  const lockEntry = { ...sdkProvenance, ...(options.lockEntry ?? {}) };
  writeFileSync(
    join(fixtureRoot, "package.json"),
    JSON.stringify(
      {
        name: "@backblaze-labs/b2-mcp-policy-fixture",
        version: "0.0.0",
        private: true,
        dependencies: {
          "@backblaze-labs/b2-sdk": packageSpec,
        },
        ...(options.optionalDependencies
          ? { optionalDependencies: options.optionalDependencies }
          : {}),
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(fixtureRoot, "package-lock.json"),
    JSON.stringify(
      {
        name: "@backblaze-labs/b2-mcp-policy-fixture",
        version: "0.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "@backblaze-labs/b2-mcp-policy-fixture",
            version: "0.0.0",
            dependencies: {
              "@backblaze-labs/b2-sdk": packageSpec,
            },
            ...(options.optionalDependencies
              ? { optionalDependencies: options.optionalDependencies }
              : {}),
          },
          "node_modules/@backblaze-labs/b2-sdk": {
            version: lockEntry.version,
            resolved: lockEntry.resolved,
            integrity: lockEntry.integrity,
          },
          ...(options.lockPackages ?? {}),
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(fixtureRoot, "package-budget.json"),
    JSON.stringify(
      {
        issue: {
          number: 75,
          url: "https://github.com/backblaze-labs/b2-mcp/issues/75",
          planningId: "P1-RUNTIME-02",
        },
        limits: {
          directProductionDependencyCount: 1,
          totalProductionPackageCount: 1,
          packedTarballBytes: 1,
          unpackedPackageBytes: 1,
          packedEntryCount: 1,
          cleanConsumerInstallFootprintBytes: 1,
        },
        directProductionDependencies: {
          "@backblaze-labs/b2-sdk": {
            purpose: "Fixture primary B2 SDK dependency.",
            policy: "Fixture dependency must remain exact-pinned.",
            ...sdkProvenance,
          },
        },
        runtimeImportPolicy: {
          allowedBackblazeSdkSpecifiers: ["@backblaze-labs/b2-sdk", "@backblaze-labs/b2-sdk/s3"],
          allowedAwsRuntimeImports: [],
          forbiddenRuntimeDependencies: ["axios"],
        },
        temporaryAdapters: [],
        approvedDuplicatePackageVersions: {},
      },
      null,
      2,
    ),
  );
  return fixtureRoot;
}

function runPolicyFixture(fixtureRoot: string) {
  return spawnSync(process.execPath, [script, "--policy-only"], {
    cwd: root,
    env: { ...process.env, B2_MCP_PACKAGE_BUDGET_ROOT: fixtureRoot },
    encoding: "utf8",
  });
}

describe("package budget policy gate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["static import", 'import "@aws-sdk/client-s3";'],
    ["static export", 'export { S3Client } from "@aws-sdk/client-s3";'],
    ["dynamic import", 'await import("@aws-sdk/client-s3");'],
    ["require", 'require("axios");'],
    [
      "createRequire alias",
      'import { createRequire } from "node:module"; const nodeRequire = createRequire(import.meta.url); nodeRequire("@aws-sdk/client-s3");',
    ],
    [
      "createRequire immediate",
      'import { createRequire } from "node:module"; createRequire(import.meta.url)("axios");',
    ],
    ["private SDK dynamic import", 'await import("@backblaze-labs/b2-sdk/dist/internal/x.js");'],
    [
      "non-literal dynamic import",
      'const specifier = "@aws-sdk/client-s3"; await import(specifier);',
    ],
  ])("rejects forbidden runtime import syntax: %s", (_label, sourceText) => {
    const fixtureRoot = writeFixture(sourceText);
    try {
      const result = runPolicyFixture(fixtureRoot);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(
        /AWS SDK import|direct Axios|SDK private|non-literal dynamic-import/,
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "ranged package dependency",
      { packageSpec: "^0.2.0" },
      /must be exact-pinned to reviewed version 0\.2\.0, got \^0\.2\.0/,
    ],
    [
      "registry drift",
      { lockEntry: { resolved: "https://registry.example.test/b2-sdk-0.2.0.tgz" } },
      /resolved expected https:\/\/registry\.npmjs\.org\//,
    ],
  ])("rejects direct dependency provenance drift: %s", (_label, options, expected) => {
    const fixtureRoot = writeFixture('import "@backblaze-labs/b2-sdk";', options);
    try {
      const result = runPolicyFixture(fixtureRoot);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(expected);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects transitive production lockfile entries outside the npm registry", () => {
    const fixtureRoot = writeFixture('import "@backblaze-labs/b2-sdk";', {
      lockPackages: {
        "node_modules/@smithy/util-utf8": {
          version: "4.2.0",
          resolved: "https://attacker.example/@smithy/util-utf8-4.2.0.tgz",
          integrity:
            "sha512-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
    });
    try {
      const result = runPolicyFixture(fixtureRoot);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "node_modules/@smithy/util-utf8: production package must resolve from the npm registry",
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("counts optionalDependencies as direct production dependencies", () => {
    const fixtureRoot = writeFixture('import "@backblaze-labs/b2-sdk";', {
      optionalDependencies: {
        pino: "10.3.1",
      },
      lockPackages: {
        "node_modules/pino": {
          version: "10.3.1",
          resolved: "https://registry.npmjs.org/pino/-/pino-10.3.1.tgz",
          integrity:
            "sha512-r34yH/GlQpKZbU1BvFFqOjhISRo1MNx1tWYsYvmj6KIRHSPMT2+yHOEb1SG6NMvRoHRF0a07kCOox/9yakl1vg==",
        },
      },
    });
    try {
      const result = runPolicyFixture(fixtureRoot);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "direct production dependency count expected 1, got 2",
      );
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "unapproved direct production dependency: pino",
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("records transitive package count without direct dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const budget = JSON.parse(readFileSync(join(root, "package-budget.json"), "utf8")) as {
      reviewedBaseline: {
        totalProductionPackageCount: number;
        transitiveProductionPackageCount: number;
      };
    };
    const directProductionDependencyCount =
      Object.keys(pkg.dependencies ?? {}).length +
      Object.keys(pkg.optionalDependencies ?? {}).length;

    expect(budget.reviewedBaseline.transitiveProductionPackageCount).toBe(
      budget.reviewedBaseline.totalProductionPackageCount - 1 - directProductionDependencyCount,
    );
  });

  it("runs the package budget before npm publish", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const publishWorkflow = readFileSync(join(root, ".github/workflows/publish.yml"), "utf8");
    const packageBudgetStep = publishWorkflow.indexOf("- run: npm run check:package-budget");
    const packStep = publishWorkflow.indexOf("- name: Build and scan publish tarball");

    expect(pkg.scripts.prepublishOnly).toBeUndefined();
    expect(packageBudgetStep).toBeGreaterThan(-1);
    expect(packageBudgetStep).toBeLessThan(packStep);
  });
});
