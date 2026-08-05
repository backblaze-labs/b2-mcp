import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
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
          },
          "node_modules/@backblaze-labs/b2-sdk": {
            version: lockEntry.version,
            resolved: lockEntry.resolved,
            integrity: lockEntry.integrity,
          },
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
    jest.restoreAllMocks();
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
});
