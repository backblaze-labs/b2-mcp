import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { createRequire } from "module";

const root = join(__dirname, "../..");
const nodeRequire = createRequire(__filename);
const { workflowJobBlock } = nodeRequire("../../scripts/lib/workflow-yaml.cjs") as {
  workflowJobBlock: (text: string, jobName: string) => string | null;
};
const { valuesEqual, yamlBlockForKey, yamlValuesForKey } = nodeRequire(
  "../../scripts/lib/workflow-yaml.cjs",
) as {
  valuesEqual: (actual: unknown[], expected: unknown[]) => boolean;
  yamlBlockForKey: (text: string, key: string) => string | null;
  yamlValuesForKey: (text: string, key: string) => unknown[];
};
const { parseYaml, readPackageManagerLock } = nodeRequire("../../scripts/lib/pnpm-lock.cjs") as {
  parseYaml: (text: string) => unknown;
  readPackageManagerLock: (root: string) => unknown;
};
const semver = nodeRequire("semver") as {
  satisfies: (version: string, range: string, options?: { includePrerelease?: boolean }) => boolean;
};

describe("supply-chain audit policy", () => {
  const workflow = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");
  const publishWorkflow = readFileSync(join(root, ".github/workflows/publish.yml"), "utf8");
  const releaseTagWorkflow = readFileSync(join(root, ".github/workflows/release-tag.yml"), "utf8");
  const rawPnpmLock = parseYaml(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")) as {
    importers?: Record<
      string,
      {
        dependencies?: Record<string, { specifier?: string; version?: string }>;
        devDependencies?: Record<string, { specifier?: string; version?: string }>;
      }
    >;
    packages?: Record<string, { resolution?: { integrity?: string } }>;
    snapshots?: Record<
      string,
      {
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      }
    >;
  };
  const pnpmWorkspace = parseYaml(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")) as {
    allowBuilds?: Record<string, boolean>;
    minimumReleaseAgeExclude?: string[];
  };
  const customerHostedPnpmWorkspace = parseYaml(
    readFileSync(join(root, "deploy/customer-hosted/pnpm-workspace.yaml"), "utf8"),
  ) as {
    allowBuilds?: Record<string, boolean>;
    minimumReleaseAgeExclude?: string[];
  };
  const sdkAdoptionContract = readFileSync(join(root, "docs/SDK_ADOPTION_CONTRACT.md"), "utf8");
  const workflowDirectory = join(root, ".github/workflows");
  const allWorkflows = readdirSync(workflowDirectory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => [name, readFileSync(join(workflowDirectory, name), "utf8")] as const);
  const npmrc = readFileSync(join(root, ".npmrc"), "utf8");
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    mcpName?: string;
    scripts: Record<string, string>;
  };
  const auditPolicy = JSON.parse(readFileSync(join(root, "audit-policy.json"), "utf8")) as {
    allowedAdvisories: Array<{
      name: string;
      source: number;
      maxSeverity: string;
      isDirect: boolean;
      nodes: string[];
      effects: string[];
      package: { version: string; integrity: string };
      via: { path: string; name: string; version: string; dependencyRange: string };
      expires: string;
    }>;
  };
  type LockPackage = {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    engines?: { node?: string };
    integrity?: string;
    version?: string;
  };
  type LockPackageWithMetadata = LockPackage & { integrity: string; version: string };
  const lock = readPackageManagerLock(root) as { packages: Record<string, LockPackage> };

  it("keeps the fresh Backblaze SDK release-age exception time-bounded", () => {
    const sdkVersion = packageJson.dependencies["@backblaze-labs/b2-sdk"];
    const excludedPackage = `@backblaze-labs/b2-sdk@${sdkVersion}`;
    const rootExcludes = pnpmWorkspace.minimumReleaseAgeExclude ?? [];
    const customerHostedExcludes = customerHostedPnpmWorkspace.minimumReleaseAgeExclude ?? [];
    const exceptionExpiresAt = "2026-09-16T19:00:00.000Z";

    expect(rootExcludes).toContain(excludedPackage);
    expect(customerHostedExcludes).toContain(excludedPackage);
    expect(rootExcludes.filter((entry) => entry.startsWith("@backblaze-labs/b2-sdk@"))).toEqual([
      excludedPackage,
    ]);
    expect(
      customerHostedExcludes.filter((entry) => entry.startsWith("@backblaze-labs/b2-sdk@")),
    ).toEqual([excludedPackage]);
    expect(Date.now()).toBeLessThan(Date.parse(exceptionExpiresAt));

    const lockEntry = rawPnpmLock.packages?.[excludedPackage];
    const integrity = lockEntry?.resolution?.integrity;

    expect(integrity).toBeTruthy();
    expect(sdkAdoptionContract).toContain(excludedPackage);
    expect(sdkAdoptionContract).toContain(exceptionExpiresAt);
    expect(sdkAdoptionContract).toContain("SLSA v1 attestation");
    expect(sdkAdoptionContract).toContain(String(integrity));
    expect(sdkAdoptionContract).toContain(
      "npm diff --diff=@backblaze-labs/b2-sdk@0.3.0 --diff=@backblaze-labs/b2-sdk@0.4.0 --diff-name-only",
    );
    expect(sdkAdoptionContract).toContain("lifecycle script");
  });

  function requirePolicyFixturePackage(path: string, purpose: string): LockPackageWithMetadata {
    const pkg = lock.packages[path];
    if (!pkg) {
      throw new Error(
        `Missing supply-chain policy fixture package ${path} (${purpose}). Pick another present pnpm-lock.yaml package for this synthetic advisory fixture.`,
      );
    }
    if (!pkg.version || !pkg.integrity) {
      throw new Error(
        `Supply-chain policy fixture package ${path} (${purpose}) must have version and integrity metadata in pnpm-lock.yaml.`,
      );
    }
    return pkg as LockPackageWithMetadata;
  }

  function packageNameFromPath(path: string): string {
    return path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  }

  function findPolicyFixtureVia(dependencyName: string): {
    dependencyRange: string;
    name: string;
    path: string;
    pkg: LockPackageWithMetadata;
  } {
    const candidates = Object.entries(lock.packages)
      .filter(([path, pkg]) => {
        if (path === `node_modules/${dependencyName}`) return false;
        return !!(pkg.version && pkg.integrity && pkg.dependencies?.[dependencyName]);
      })
      .sort(([left], [right]) => left.localeCompare(right));
    const [path, pkg] = candidates[0] ?? [];
    if (!path || !pkg?.version || !pkg.integrity) {
      throw new Error(
        `Missing supply-chain policy fixture package with a real ${dependencyName} dependency edge in pnpm-lock.yaml.`,
      );
    }
    const dependencyRange = pkg.dependencies?.[dependencyName];
    if (!dependencyRange) {
      throw new Error(
        `Supply-chain policy fixture package ${path} must depend on ${dependencyName}; pick another present transitive fixture package.`,
      );
    }
    return {
      dependencyRange,
      name: packageNameFromPath(path),
      path,
      pkg: pkg as LockPackageWithMetadata,
    };
  }

  const auditFixturePackage = requirePolicyFixturePackage(
    "node_modules/acorn",
    "synthetic vulnerable package",
  );
  // This transitive package is an arbitrary stand-in used only to exercise
  // advisory via/effects policy matching. Select it by required lockfile shape
  // instead of package name so unrelated tooling swaps keep the test legible.
  const policyFixtureVia = findPolicyFixtureVia("acorn");
  const zodPackage = requirePolicyFixturePackage("node_modules/zod", "direct advisory fixture");
  const exceptionPolicy = {
    allowedAdvisories: [
      {
        name: "acorn",
        source: 999000,
        maxSeverity: "moderate",
        isDirect: false,
        nodes: ["node_modules/acorn"],
        effects: [policyFixtureVia.name],
        package: { version: auditFixturePackage.version, integrity: auditFixturePackage.integrity },
        via: {
          path: policyFixtureVia.path,
          name: policyFixtureVia.name,
          version: policyFixtureVia.pkg.version,
          dependencyRange: policyFixtureVia.dependencyRange,
        },
        expires: "2026-10-01",
        reason: "Test-only exception fixture for policy behavior.",
      },
    ],
  };
  const directPnpmPolicy = {
    allowedAdvisories: [
      {
        name: "zod",
        source: 998000,
        maxSeverity: "high",
        isDirect: true,
        nodes: [".>zod"],
        effects: [],
        package: { version: zodPackage.version, integrity: zodPackage.integrity },
        via: {
          path: "node_modules/zod",
          name: "zod",
          version: zodPackage.version,
        },
        expires: "2026-10-01",
        reason: "Test-only direct pnpm advisory exception fixture.",
      },
    ],
  };

  function jobBlock(name: string): string {
    return workflowJobBlock(workflow, name) ?? "";
  }

  function publishJobBlock(name: string): string {
    return workflowJobBlock(publishWorkflow, name) ?? "";
  }

  function workflowStepBlock(job: string, stepName: string): string {
    const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = job.match(
      new RegExp(
        `- name: ${escaped}[\\s\\S]*?(?=\\n\\s+- name:|\\n\\s+- uses:|\\n\\n  [A-Za-z0-9_-]+:|\\s*$)`,
      ),
    );
    if (!match) throw new Error(`Missing workflow step ${stepName}`);
    return match[0];
  }

  function scopedAuditReport(overrides: Record<string, unknown> = {}) {
    return {
      auditReportVersion: 2,
      vulnerabilities: {
        acorn: {
          name: "acorn",
          severity: "moderate",
          isDirect: false,
          via: [
            {
              source: 999000,
              name: "acorn",
              dependency: "acorn",
              title: "Test-only transitive advisory",
              url: "https://github.com/advisories/test-only",
              severity: "moderate",
              range: "<8.16.1",
            },
          ],
          effects: [policyFixtureVia.name],
          range: "<8.16.1",
          nodes: ["node_modules/acorn"],
          fixAvailable: false,
          ...overrides,
        },
        [policyFixtureVia.name]: {
          name: policyFixtureVia.name,
          severity: "moderate",
          isDirect: false,
          via: ["acorn"],
          effects: [],
          range: "*",
          nodes: [policyFixtureVia.path],
          fixAvailable: false,
        },
      },
      metadata: { vulnerabilities: { moderate: 2, total: 2 } },
    };
  }

  function unallowedAuditReport() {
    return {
      auditReportVersion: 2,
      vulnerabilities: {
        "new-vulnerable-package": {
          name: "new-vulnerable-package",
          severity: "high",
          isDirect: true,
          via: [
            {
              source: 999001,
              name: "new-vulnerable-package",
              dependency: "new-vulnerable-package",
              title: "New untracked advisory",
              url: "https://github.com/advisories/example",
              severity: "high",
              range: "<1.0.1",
            },
          ],
          effects: [],
          range: "<1.0.1",
          nodes: ["node_modules/new-vulnerable-package"],
          fixAvailable: false,
        },
      },
      metadata: { vulnerabilities: { high: 1, total: 1 } },
    };
  }

  function devOnlyAuditReport() {
    return {
      auditReportVersion: 2,
      vulnerabilities: {
        "dev-only-vulnerable-tool": {
          name: "dev-only-vulnerable-tool",
          severity: "high",
          isDirect: true,
          via: [
            {
              source: 999002,
              name: "dev-only-vulnerable-tool",
              dependency: "dev-only-vulnerable-tool",
              title: "Dev-only advisory",
              url: "https://github.com/advisories/dev-only-example",
              severity: "high",
              range: "<1.0.1",
            },
          ],
          effects: [],
          range: "<1.0.1",
          nodes: ["node_modules/dev-only-vulnerable-tool"],
          fixAvailable: false,
        },
      },
      metadata: { vulnerabilities: { high: 1, total: 1 } },
    };
  }

  function directPnpmAuditReport() {
    return {
      advisories: {
        998000: {
          id: 998000,
          module_name: "zod",
          severity: "high",
          title: "Direct dependency advisory",
          url: "https://github.com/advisories/direct-pnpm-fixture",
          vulnerable_versions: "<4.4.4",
          findings: [{ version: zodPackage.version, paths: [".>zod"], dev: false }],
        },
      },
    };
  }

  function policyWithException(overrides: Record<string, unknown>, omitExpires = false) {
    const entry = { ...exceptionPolicy.allowedAdvisories[0], ...overrides };
    if (omitExpires)
      delete (entry as Partial<(typeof exceptionPolicy.allowedAdvisories)[0]>).expires;
    return { allowedAdvisories: [entry] };
  }

  function runAudit(
    report: unknown,
    extraEnv: Record<string, string> = {},
    policy: unknown = exceptionPolicy,
  ) {
    return spawnSync(process.execPath, ["scripts/audit-supply-chain.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        B2_MCP_AUDIT_REPORT_JSON: JSON.stringify(report),
        B2_MCP_AUDIT_POLICY_JSON: JSON.stringify(policy),
        B2_MCP_AUDIT_TODAY: "2026-09-30",
        ...extraEnv,
      },
      encoding: "utf8",
    });
  }

  function emptyNpmAuditReport() {
    return {
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: { vulnerabilities: { total: 0 } },
    };
  }

  function productionNpmAuditReport() {
    return {
      auditReportVersion: 2,
      vulnerabilities: {
        zod: {
          name: "zod",
          severity: "high",
          isDirect: true,
          via: [
            {
              source: 998000,
              name: "zod",
              dependency: "zod",
              title: "Direct production advisory",
              url: "https://github.com/advisories/direct-production-fixture",
              severity: "high",
              range: "<4.4.4",
            },
          ],
          effects: [],
          range: "<4.4.4",
          nodes: ["node_modules/zod"],
          fixAvailable: false,
        },
      },
      metadata: { vulnerabilities: { high: 1, total: 1 } },
    };
  }

  function fakeNpmAudit(dir: string, report: unknown, exitCode: number) {
    const fakeNpm = join(dir, process.platform === "win32" ? "npm.cmd" : "npm");
    writeFileSync(
      fakeNpm,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args[0] !== 'audit' || !args.includes('--json')) {",
        "  console.error(`unexpected npm args: ${args.join(' ')}`);",
        "  process.exit(2);",
        "}",
        `console.log(JSON.stringify(${JSON.stringify(report)}));`,
        `process.exit(${exitCode});`,
      ].join("\n"),
    );
    chmodSync(fakeNpm, 0o755);
    return fakeNpm;
  }

  function productionGateEnv(fakeNpmDir: string, extraEnv: Record<string, string> = {}) {
    return {
      ...process.env,
      PATH: `${fakeNpmDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      NODE_ENV: "test",
      B2_MCP_AUDIT_TODAY: "2026-09-30",
      ...extraEnv,
    };
  }

  function writeProductionGateInputs(fixtureRoot: string, lockText?: string) {
    writeFileSync(join(fixtureRoot, ".npmrc"), npmrc);
    writeFileSync(
      join(fixtureRoot, "audit-policy.json"),
      JSON.stringify({ allowedAdvisories: [] }),
    );
    writeFileSync(
      join(fixtureRoot, "package.json"),
      JSON.stringify(
        {
          name: "b2-mcp-production-gate-fixture",
          version: "0.0.0",
          private: true,
          dependencies: { parent: "1.0.0" },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(fixtureRoot, "pnpm-lock.yaml"),
      lockText ??
        [
          "lockfileVersion: '9.0'",
          "importers:",
          "  .:",
          "    dependencies:",
          "      parent:",
          "        specifier: 1.0.0",
          "        version: 1.0.0",
          "packages:",
          "  parent@1.0.0:",
          "    resolution: {integrity: sha512-parent}",
          "snapshots:",
          "  parent@1.0.0: {}",
          "",
        ].join("\n"),
    );
  }

  function expectCycloneDx15LibrarySbom(sbom: {
    $schema?: string;
    bomFormat?: string;
    specVersion?: string;
    version?: number;
    metadata?: {
      component?: { "bom-ref"?: string; type?: string; name?: string; version?: string };
    };
    components?: Array<{
      "bom-ref"?: string;
      type?: string;
      name?: string;
      version?: string;
      purl?: string;
    }>;
    dependencies?: Array<{ ref?: string; dependsOn?: string[] }>;
  }) {
    expect(sbom.$schema).toBe("http://cyclonedx.org/schema/bom-1.5.schema.json");
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.specVersion).toBe("1.5");
    expect(sbom.version).toBe(1);
    expect(sbom.metadata?.component).toMatchObject({
      type: "library",
      name: expect.any(String),
      version: expect.any(String),
    });
    expect(sbom.metadata?.component?.["bom-ref"]).toBe(
      `${sbom.metadata?.component?.name}@${sbom.metadata?.component?.version}`,
    );
    expect(Array.isArray(sbom.components)).toBe(true);
    expect(Array.isArray(sbom.dependencies)).toBe(true);
    const refs = new Set([
      sbom.metadata?.component?.["bom-ref"],
      ...(sbom.components ?? []).map((component) => component["bom-ref"]),
    ]);
    for (const component of sbom.components ?? []) {
      expect(component).toMatchObject({
        "bom-ref": `${component.name}@${component.version}`,
        type: "library",
        name: expect.any(String),
        version: expect.any(String),
        purl: expect.stringMatching(/^pkg:npm\//),
      });
    }
    for (const dependency of sbom.dependencies ?? []) {
      expect(refs.has(dependency.ref)).toBe(true);
      expect(Array.isArray(dependency.dependsOn)).toBe(true);
      for (const ref of dependency.dependsOn ?? []) {
        expect(refs.has(ref)).toBe(true);
      }
    }
  }

  it("runs the full lockfile audit on the ci-green deploy-gating path", () => {
    const coverageJob = jobBlock("unit-coverage");
    const productionAuditJob = jobBlock("production-dependency-audit-matrix");
    const productionAuditAggregateJob = jobBlock("production-dependency-audit");
    const auditJob = jobBlock("supply-chain-audit");
    const markGreenJob = jobBlock("mark-green");
    expect(workflow).toContain("production-dependency-audit:");
    expect(workflow).toContain("supply-chain-audit:");
    expect(workflow).toContain("pnpm run audit:supply-chain");
    expect(workflow).toContain(
      "pnpm run audit:supply-chain:denylist --ref HEAD --ref origin/main --packlist",
    );
    expect(productionAuditJob).toContain("node scripts/production-security-gate.mjs");
    expect(productionAuditJob).toContain("node-version: [22.23.1, 24, 26]");
    expect(productionAuditJob).toContain("package-manager-cache: false");
    expect(productionAuditJob).not.toContain("pnpm install");
    expect(productionAuditJob).not.toContain("prepare-production-npm-audit.mjs");
    expect(productionAuditJob).not.toContain("npm install --package-lock-only");
    expect(auditJob).toContain("fetch-depth: 0");
    expect(auditJob).toContain("git show-ref --verify --quiet refs/remotes/origin/main");
    expect(auditJob).not.toContain("git fetch --prune --no-tags origin");
    expect(auditJob).not.toContain("refs/heads/*:refs/remotes/origin/*");
    expect(auditJob).not.toContain("--all-branches");
    expect(auditJob).not.toContain("if: github.event_name == 'pull_request'");
    expect(productionAuditJob).toContain("Reject injected audit fixtures");
    expect(productionAuditJob).toContain("B2_MCP_AUDIT_REPORT_JSON is test-only");
    expect(productionAuditJob).toContain("B2_MCP_AUDIT_POLICY_JSON is test-only");
    expect(productionAuditJob).toContain("B2_MCP_PRODUCTION_GATE_ROOT is test-only");
    expect(productionAuditAggregateJob).toContain("needs: production-dependency-audit-matrix");
    expect(auditJob).toContain("B2_MCP_AUDIT_EXPIRED_EXCEPTION_MODE: fail");
    expect(auditJob).not.toContain("B2_MCP_AUDIT_EXPIRED_EXCEPTION_MODE: warn");
    expect(coverageJob).not.toContain("pnpm run audit:supply-chain");
    for (const required of [
      "format-lint-typecheck",
      "unit-coverage",
      "package-install-smoke",
      "runtime-engine-floor",
      "cross-platform-minimum",
      "production-dependency-audit",
      "package-budget",
      "container-image",
      "supply-chain-audit",
      "codeql-workflow-security",
      "slow-lifecycle",
    ]) {
      expect(markGreenJob).toContain(required);
    }
  });

  it("disables normal lifecycle scripts and isolates npm publishing", () => {
    const githubReleaseJob = publishJobBlock("github-release");
    const containerImageJob = publishJobBlock("container-image");
    const publishJob = publishJobBlock("publish");
    const mcpRegistryPreflightJob = publishJobBlock("mcp-registry-preflight");
    const mcpPublisherInstallStep = workflowStepBlock(
      mcpRegistryPreflightJob,
      "Download and verify mcp-publisher",
    );
    const mcpRegistryPublishStep = workflowStepBlock(publishJob, "Publish MCP registry entry");

    expect(npmrc).toMatch(/^ignore-scripts=true$/m);
    expect(packageJson.scripts["audit:supply-chain"]).toContain(
      "pnpm run audit:supply-chain:denylist --packlist",
    );
    expect(packageJson.scripts["audit:supply-chain:denylist"]).toBe(
      "node scripts/check-supply-chain-denylist.mjs",
    );
    expect(packageJson.scripts["audit:production"]).toBe(
      "node scripts/production-security-gate.mjs",
    );
    expect(packageJson.scripts["release:sbom"]).toBe(
      "node scripts/production-security-gate.mjs --sbom publish-package/b2-mcp-production.cdx.json",
    );
    expect(packageJson.scripts["release:stamp"]).toBe("node scripts/write-release-version.mjs");
    expect(packageJson.scripts.version).toBe(
      "node scripts/cut-changelog.mjs && node scripts/update-server-json-version.mjs && git add CHANGELOG.md server.json lhm.plugin.json",
    );
    expect(packageJson.mcpName).toBe("io.github.backblaze-labs/b2-mcp");
    expect(packageJson.scripts.prepublishOnly).toContain("pnpm run build");
    expect(packageJson.scripts.prepublishOnly).toContain("scripts/verify-release-input.mjs");
    expect(packageJson.scripts.prepublishOnly).toContain("pnpm run release:stamp");
    expect(packageJson.scripts.postpack).toBe(
      "node -e \"require('node:fs').rmSync('dist/release-version.json',{force:true})\"",
    );
    expect(packageJson.scripts.test).toBe("pnpm run typecheck && pnpm run test:unit");
    expect(packageJson.scripts.pretest).toBeUndefined();
    expect(publishWorkflow).toContain("permissions:");
    expect(publishWorkflow).toContain("id-token: write");
    expect(publishWorkflow).not.toContain("environment: npm-publish");
    expect(publishWorkflow).toContain("ci-green");
    expect(publishWorkflow).toContain("node scripts/verify-release-input.mjs --tag");
    expect(publishWorkflow).toContain(
      "pnpm run audit:supply-chain:denylist --ref HEAD --ref origin/main --packlist --expect-pack-file dist/index.js",
    );
    expect(publishWorkflow).toContain("pnpm run release:stamp -- --version");
    expect(publishWorkflow).toContain("pnpm run release:sbom");
    expect(publishWorkflow).toContain("node scripts/extract-release-notes.mjs");
    expect(publishWorkflow).toContain("Dry-run npm publish from staged package directory");
    expect(publishWorkflow).toContain("--dry-run");
    expect(publishWorkflow).toContain("--access public");
    expect(publishWorkflow).toContain("--ignore-scripts");
    expect(publishWorkflow).toContain('--tag "${npm_tag}"');
    expect(publishWorkflow).not.toContain("prepare-production-npm-audit.mjs");
    expect(publishWorkflow).not.toContain("npm sbom");
    expect(publishWorkflow).toContain("publish-package/*.cdx.json");
    expect(publishWorkflow).toContain("publish-package/SHA256SUMS");
    expect(publishWorkflow).toContain("release-notes.md");
    expect(publishWorkflow).toContain("sbom-sha256");
    expect(publishWorkflow).toContain("EXPECTED_SBOM_SHA256");
    expect(publishWorkflow).toContain("Stage publish helper scripts");
    expect(publishWorkflow).toContain("scripts/npm-publish-metadata.mjs");
    expect(publishWorkflow).toContain("scripts/verify-npm-registry-metadata.mjs");
    expect(publishWorkflow).toContain("Stage MCP registry manifest");
    expect(publishWorkflow).toContain("publish-package/server.json");
    expect(publishWorkflow).toContain("scripts/mcp-registry-publish.mjs");
    expect(publishWorkflow).toContain("scripts/verify-mcp-registry-manifest.mjs");
    expect(publishWorkflow).toContain("scripts/lib/mcp-registry-manifest.mjs");
    expect(publishWorkflow).toContain("publish-package/release-tools/*.mjs");
    expect(publishWorkflow).toContain("Create GitHub release from verified artifact");
    expect(publishWorkflow).toContain("gh release upload");
    expect(publishWorkflow).toContain("gh release create");
    expect(publishWorkflow).toContain("release_flags+=(--prerelease)");
    expect(publishWorkflow).toContain("create_flags+=(--prerelease --latest=false)");
    expect(publishWorkflow).toContain("contents: write");
    expect(githubReleaseJob).toContain("actions: read");
    expect(githubReleaseJob).toContain("contents: write");
    expect(githubReleaseJob).not.toContain("id-token: write");
    expect(githubReleaseJob).toContain("needs: [prepare, publish, container-image]");
    expect(githubReleaseJob).toContain("Create GitHub release from verified artifact");
    expect(githubReleaseJob).toContain('sha256sum "$sbom"');
    expect(githubReleaseJob).toContain("sha256sum --check");
    expect(containerImageJob).toContain("needs: [prepare, publish]");
    expect(containerImageJob).not.toContain("environment: ghcr-publish");
    expect(containerImageJob).toContain("packages: write");
    expect(containerImageJob).toContain("id-token: write");
    expect(containerImageJob).toContain("ghcr.io/${{ github.repository }}");
    expect(containerImageJob).toContain("docker/setup-qemu-action");
    expect(containerImageJob).toContain("docker/setup-buildx-action");
    expect(containerImageJob).toContain("sigstore/cosign-installer");
    expect(containerImageJob).toContain("node scripts/smoke-container-image.mjs");
    expect(containerImageJob).toContain("node scripts/publish-container-image.mjs");
    expect(mcpRegistryPreflightJob).toContain("needs: prepare");
    expect(mcpRegistryPreflightJob).toContain("timeout-minutes: 20");
    expect(mcpRegistryPreflightJob).toContain("actions: read");
    expect(mcpRegistryPreflightJob).toContain("contents: read");
    expect(mcpRegistryPreflightJob).not.toContain("id-token: write");
    expect(mcpRegistryPreflightJob).toContain("Verify MCP registry manifest metadata");
    expect(mcpRegistryPreflightJob).not.toContain("mcp-publisher validate");
    expect(mcpRegistryPreflightJob).toContain("sigstore/cosign-installer");
    expect(mcpRegistryPreflightJob).toContain("cosign verify-blob");
    expect(mcpRegistryPreflightJob).toContain("--certificate-identity");
    expect(mcpRegistryPreflightJob).toContain("--certificate-oidc-issuer");
    expect(mcpRegistryPreflightJob).toContain("--certificate-github-workflow-repository");
    expect(mcpRegistryPreflightJob).toContain("--certificate-github-workflow-ref");
    expect(mcpRegistryPreflightJob).toContain("--certificate-github-workflow-sha");
    expect(mcpRegistryPreflightJob).toContain("--certificate-github-workflow-name");
    expect(mcpRegistryPreflightJob).toContain("--certificate-github-workflow-trigger");
    expect(mcpRegistryPreflightJob).toContain("name: mcp-publisher");
    expect(mcpRegistryPreflightJob).toContain("path: mcp-publisher-bin/mcp-publisher");
    expect(publishWorkflow).toContain("MCP_PUBLISHER_SHA256:");
    expect(publishWorkflow).toContain("MCP_PUBLISHER_BINARY_SHA256:");
    expect(mcpPublisherInstallStep).toContain(
      "printf '%s  mcp-publisher.tar.gz\\n' \"${MCP_PUBLISHER_SHA256}\" | sha256sum -c -",
    );
    expect(mcpPublisherInstallStep).toContain("curl --retry 3 --retry-all-errors");
    expect(mcpPublisherInstallStep).toContain("--connect-timeout 10 --max-time 60");
    expect(mcpPublisherInstallStep.indexOf("sha256sum -c -")).toBeLessThan(
      mcpPublisherInstallStep.indexOf("tar -xzf mcp-publisher.tar.gz"),
    );
    expect(mcpPublisherInstallStep.indexOf("cosign verify-blob")).toBeLessThan(
      mcpPublisherInstallStep.indexOf("tar -xzf mcp-publisher.tar.gz"),
    );
    expect(publishJob).toContain("needs: [prepare, live-contract, mcp-registry-preflight]");
    expect(publishJob).toContain("timeout-minutes: 30");
    expect(publishJob).toContain("actions: read");
    expect(publishJob).toContain("contents: read");
    expect(publishJob).toContain("id-token: write");
    expect(publishJob).not.toContain("contents: write");
    expect(publishJob).toContain("node-version: 24.19.0");
    expect(
      publishJob.indexOf("Publish staged package directory with trusted provenance"),
    ).toBeLessThan(publishJob.indexOf("Publish MCP registry entry"));
    expect(publishJob).toContain("bundles npm >=11.5.1");
    expect(publishJob).toContain("npm view");
    expect(publishJob).toContain("already exists on npm with matching integrity");
    expect(publishWorkflow).toContain('--tarball "$tarball"');
    expect(publishWorkflow).toContain('sha256sum "$tarball"');
    expect(publishWorkflow).toContain("retention-days: 7");
    expect(publishWorkflow).toContain("--provenance");
    expect(publishWorkflow).toContain('--tag "$npm_tag"');
    expect(publishWorkflow).not.toContain("--ignore-scripts=false");
    expect(publishWorkflow).toContain('tar -xzf "$tarball" -C publish-package/staged');
    expect(mcpRegistryPublishStep).toContain("mcp-registry-publish.mjs");
    expect(mcpRegistryPublishStep).toContain("--skip-prerelease");
    expect(mcpRegistryPublishStep).toContain("MCP_PUBLISHER_BINARY_SHA256");
    expect(mcpRegistryPublishStep).not.toContain("curl");
    expect(mcpRegistryPublishStep).not.toContain("mcp-publisher validate");
    expect(mcpRegistryPublishStep).not.toContain("node -e");
    expect(mcpRegistryPublishStep).not.toContain("encodeURIComponent");
  });

  it("keeps tsx dev-only and denies esbuild install builds", () => {
    const tsxPackage = rawPnpmLock.packages?.["tsx@4.23.12"];
    const tsxSnapshot = rawPnpmLock.snapshots?.["tsx@4.23.12"];
    const esbuildPackage = rawPnpmLock.packages?.["esbuild@0.28.1"];
    const esbuildPlatformPackages = Object.entries(rawPnpmLock.packages ?? {}).filter(([key]) =>
      key.startsWith("@esbuild/"),
    );

    expect(packageJson.dependencies).not.toHaveProperty("tsx");
    expect(packageJson.dependencies).not.toHaveProperty("esbuild");
    expect(packageJson.devDependencies.tsx).toBe("4.23.12");
    expect(rawPnpmLock.importers?.["."]?.devDependencies?.tsx).toEqual({
      specifier: "4.23.12",
      version: "4.23.12",
    });
    expect(tsxPackage?.resolution?.integrity).toBe(
      "sha512-FDf4L4sYzKtzWYhU/Xm0AQFdTjdIxNo9ElTf2mxXM6k8YMHXzYUe4yODVaXP4V9uMFbVg8c0qyBccK2OOxb45Q==",
    );
    expect(tsxSnapshot?.dependencies).toEqual({ esbuild: "0.28.1" });
    expect(tsxSnapshot?.optionalDependencies).toEqual({ fsevents: "2.3.3" });
    expect(esbuildPackage?.resolution?.integrity).toMatch(/^sha512-/);
    expect(esbuildPlatformPackages.length).toBeGreaterThan(0);
    for (const [key, metadata] of esbuildPlatformPackages) {
      expect(key).toMatch(/@0\.28\.1$/);
      expect(metadata.resolution?.integrity).toMatch(/^sha512-/);
    }
    expect(npmrc).toMatch(/^ignore-scripts=true$/m);
    expect(pnpmWorkspace.allowBuilds?.esbuild).toBe(false);
  });

  it("keeps release checksum entries aligned with uploaded GitHub assets", () => {
    const checksumStep = publishWorkflow.match(/sha256sum (.+) > SHA256SUMS/)?.[1] ?? "";
    const githubReleaseJob = publishJobBlock("github-release");
    const uploadBlock =
      githubReleaseJob.match(/gh release upload "\$\{PUBLISH_TAG\}"[\s\S]+?--clobber/)?.[0] ?? "";

    expect(checksumStep).toContain("*.tgz");
    expect(checksumStep).toContain("*.cdx.json");
    expect(checksumStep).toContain("release-notes.md");
    expect(checksumStep).toContain("npm-pack.json");
    expect(uploadBlock).toContain("EXPECTED_TARBALL_NAME");
    expect(uploadBlock).toContain("EXPECTED_SBOM_NAME");
    expect(uploadBlock).toContain("EXPECTED_RELEASE_NOTES_NAME");
    expect(uploadBlock).toContain("npm-pack.json");
    expect(uploadBlock).toContain("EXPECTED_CHECKSUMS_NAME");
  });

  it("derives npm dist-tags so prereleases do not publish as latest", () => {
    const prepareJob = publishJobBlock("prepare");
    const publishJob = publishJobBlock("publish");

    expect(prepareJob).toContain("node scripts/npm-publish-metadata.mjs");
    expect(prepareJob).toContain('--tag "${npm_tag}"');
    expect(publishJob).toContain("node publish-package/release-tools/npm-publish-metadata.mjs");
    expect(publishJob).not.toContain('const prerelease = String(pkg.version).split("-")[1]');
    expect(publishJob).not.toContain(
      'const tag = prerelease && ["alpha", "beta", "canary", "next", "rc"].includes(channel) ? channel : prerelease ? "next" : "latest"',
    );
    expect(publishJob).toContain('--tag "$npm_tag"');
  });

  it("exact-pins doc lint tooling", () => {
    for (const name of [
      "@microsoft/tsdoc-config",
      "eslint",
      "eslint-plugin-jsdoc",
      "eslint-plugin-tsdoc",
      "typescript-eslint",
    ]) {
      expect(packageJson.devDependencies[name]).toBeDefined();
      expect(packageJson.devDependencies[name]).not.toMatch(/^[~^]/);
    }
  });

  it("keeps the doc lint dependency closure installable on the Node runtime floor", () => {
    const pending = [
      "eslint",
      "eslint-plugin-jsdoc",
      "eslint-plugin-tsdoc",
      "typescript",
      "typescript-eslint",
    ].map((name) => `node_modules/${name}`);
    const docLintPackages = new Set<string>();

    while (pending.length > 0) {
      const packagePath = pending.pop() as string;
      if (docLintPackages.has(packagePath)) continue;
      const pkg = lock.packages[packagePath];
      if (!pkg) throw new Error(`Missing doc lint lockfile package: ${packagePath}`);
      docLintPackages.add(packagePath);

      const dependencies = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.optionalDependencies ?? {}),
      };
      for (const name of Object.keys(dependencies)) {
        let scope = packagePath;
        let resolvedPath: string | undefined;
        while (scope) {
          const candidate = `${scope}/node_modules/${name}`;
          if (lock.packages[candidate]) {
            resolvedPath = candidate;
            break;
          }
          const parentIndex = scope.lastIndexOf("/node_modules/");
          scope = parentIndex === -1 ? "" : scope.slice(0, parentIndex);
        }
        resolvedPath ??= lock.packages[`node_modules/${name}`] ? `node_modules/${name}` : undefined;
        if (!resolvedPath) {
          throw new Error(`Missing ${name} required by ${packagePath}`);
        }
        pending.push(resolvedPath);
      }
    }

    const unsupported = [...docLintPackages]
      .filter((path) => {
        const range = lock.packages[path].engines?.node;
        return range && !semver.satisfies("22.22.2", range);
      })
      .map((path) => {
        const pkg = lock.packages[path];
        return `${path}@${pkg.version}: ${pkg.engines?.node}`;
      });

    expect(unsupported).toEqual([]);
  });

  it("runs doc lint without persisted checkout credentials", () => {
    const job = jobBlock("docs-spelling-links");
    expect(job).toContain("persist-credentials: false");
    expect(job).toContain("pnpm run lint:docs");
    expect(job).toContain("pnpm run lint:links");
  });

  it("keeps npm trusted-publishing OIDC away from repo and dependency code", () => {
    const prepareJob = publishJobBlock("prepare");
    const githubReleaseJob = publishJobBlock("github-release");
    const containerImageJob = publishJobBlock("container-image");
    const publishJob = publishJobBlock("publish");
    const publishStep = workflowStepBlock(
      publishJob,
      "Publish staged package directory with trusted provenance",
    );
    const publishOnBlock = yamlBlockForKey(publishWorkflow, "on") ?? "";
    const publishWorkflowRunBlock = yamlBlockForKey(publishOnBlock, "workflow_run") ?? "";
    const releaseTagOnBlock = yamlBlockForKey(releaseTagWorkflow, "on") ?? "";
    const releaseTagPushBlock = yamlBlockForKey(releaseTagOnBlock, "push") ?? "";
    const releaseTagDispatchBlock = yamlBlockForKey(releaseTagOnBlock, "workflow_dispatch") ?? "";
    const releaseTagPushTags = yamlValuesForKey(releaseTagPushBlock, "tags");

    expect(
      releaseTagPushTags.some((value) => Array.isArray(value) && valuesEqual(value, ["v*"])),
    ).toBe(true);
    expect(releaseTagDispatchBlock).toContain("tag:");
    expect(releaseTagWorkflow).toContain("REQUEST_TAG:");
    expect(releaseTagWorkflow).toContain("actions/upload-artifact@");
    expect(releaseTagWorkflow).toContain("release-tag-request");
    expect(releaseTagWorkflow).toContain("permissions:\n  contents: read");
    expect(releaseTagWorkflow).not.toContain("id-token: write");
    expect(releaseTagWorkflow).not.toContain("actions/checkout");
    expect(releaseTagWorkflow).not.toContain("npm publish");
    expect(releaseTagWorkflow).not.toContain("GHCR_TOKEN");
    expect(publishWorkflow).toContain("zizmor: ignore[dangerous-triggers]");
    expect(publishWorkflow).toContain("tag artifact");
    expect(publishWorkflow).toContain("validates protected refs");
    expect(publishWorkflowRunBlock).toContain("Release Tag Request");
    expect(yamlBlockForKey(publishOnBlock, "release")).toBeNull();
    expect(yamlBlockForKey(publishOnBlock, "push")).toBeNull();
    expect(yamlBlockForKey(publishOnBlock, "workflow_dispatch")).toBeNull();
    expect(publishWorkflow).not.toContain("inputs.tag");
    expect(publishWorkflow).not.toContain("github.event.workflow_run.head_branch");
    expect(publishWorkflow).not.toContain("${{ github.event.release.tag_name }}");
    expect(prepareJob).not.toContain("id-token: write");
    expect(prepareJob).toContain("actions/download-artifact@");
    expect(prepareJob).toContain("github.event.workflow_run.id");
    expect(prepareJob).toContain("release-request/tag.txt");
    expect(prepareJob).toContain("steps.request.outputs.tag");
    expect(publishWorkflow).toContain("needs.prepare.outputs.publish-tag");
    expect(prepareJob).toContain("ref: refs/heads/ci-green");
    expect(prepareJob).toContain("--wait-for-ci-green-timeout-ms 1200000");
    expect(prepareJob).toContain("--wait-for-ci-green-interval-ms");
    expect(prepareJob).toContain("pnpm run verify");
    expect(prepareJob).not.toContain("actions/setup-python");
    expect(prepareJob).toContain("pnpm run typecheck");
    expect(prepareJob).toContain("pnpm run build");
    expect(prepareJob).toContain("persist-credentials: false");
    expect(prepareJob).toContain("package-manager-cache: false");
    expect(prepareJob).toContain("Dry-run npm publish from staged package directory");
    expect(prepareJob).toContain('stage_dir="publish-package/dry-run-stage"');
    expect(githubReleaseJob).toContain("actions: read");
    expect(githubReleaseJob).toContain("contents: write");
    expect(githubReleaseJob).not.toContain("id-token: write");
    expect(containerImageJob).toContain("packages: write");
    expect(containerImageJob).toContain("id-token: write");
    expect(publishJob).toContain("id-token: write");
    expect(publishJob).toContain("actions: read");
    expect(publishJob).toContain("contents: read");
    expect(publishJob).toContain("package-manager-cache: false");
    expect(publishJob).not.toContain("contents: write");
    expect(publishJob).not.toContain("actions/checkout");
    expect(publishJob).not.toContain("pnpm install");
    expect(publishJob).not.toContain("pnpm run typecheck");
    expect(publishJob).not.toContain("pnpm run build");
    expect(publishJob).not.toContain("--ignore-scripts=false");
    expect(publishJob).toContain("npm publish");
    expect(publishJob).toContain("--ignore-scripts");
    expect(publishJob).toContain('package_dir="./publish-package/staged/package"');
    expect(publishStep).toContain("node publish-package/release-tools/npm-publish-metadata.mjs");
    expect(publishStep).toContain(
      "node publish-package/release-tools/verify-npm-registry-metadata.mjs",
    );
    expect(publishStep).toContain("--timeout-ms 120000");
    expect(publishStep).toContain("--initial-interval-ms 5000");
    expect(publishStep).toContain("--max-interval-ms 30000");
    expect(publishStep).toContain(
      '--allow-legacy-local-path-metadata "@backblaze-labs/b2-mcp@0.1.0"',
    );
    expect(publishStep).toContain(
      '--allow-legacy-local-path-metadata "@backblaze-labs/b2-mcp@0.1.1"',
    );
    expect(publishStep).toContain('"${legacy_metadata_args[@]}"');
    expect(publishStep).toContain('npm publish "$package_dir"');
    expect(publishStep).not.toContain('npm publish "$tarball"');
    expect(publishStep).not.toContain("EXPECTED_TARBALL_NAME");
    expect(publishStep).toContain('npm pack "$package_dir" --json --ignore-scripts');
    expect(publishStep).toContain("Staged package tarball SHA-256 mismatch");
    expect(publishStep.indexOf('npm publish "$package_dir"')).toBeLessThan(
      publishStep.lastIndexOf("verify-npm-registry-metadata.mjs"),
    );
    expect(publishStep.slice(publishStep.lastIndexOf('npm publish "$package_dir"'))).not.toContain(
      '"${legacy_metadata_args[@]}"',
    );
  });

  it.each(allWorkflows)("pins every marketplace action used by %s", (_name, workflowText) => {
    const uses = [...workflowText.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/g)].map((match) => ({
      action: match[1],
      ref: match[2],
    }));

    for (const action of uses) {
      expect(action.ref).toMatch(/^[a-f0-9]{40}$/);
    }
  });

  it.each(allWorkflows)("documents every marketplace action pin used by %s", (_name, text) => {
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const match = line.match(/uses:\s*([^@\s]+)@([a-f0-9]{40})/);
      if (!match) continue;
      const nearbyComment = lines
        .slice(Math.max(0, index - 3), index)
        .reverse()
        .find((candidate) => candidate.trim().startsWith("#"));
      expect(nearbyComment, `${match[1]}@${match[2]} must have a release comment`).toMatch(
        new RegExp(
          `${match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} .*reviewed 20\\d{2}-\\d{2}-\\d{2}`,
        ),
      );
    }
  });

  it("prepares an isolated npm production audit lock from pnpm-lock.yaml", () => {
    const target = join(root, ".audit/test-production-manifest");

    try {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/production-security-gate.mjs",
          "--prepare-only",
          "--audit-root",
          ".audit/test-production-manifest",
        ],
        {
          cwd: root,
          encoding: "utf8",
        },
      );
      const productionPackage = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
        devDependencies?: Record<string, string>;
        private?: boolean;
      };
      const packageLock = JSON.parse(readFileSync(join(target, "package-lock.json"), "utf8")) as {
        packages: Record<
          string,
          {
            dependencies?: Record<string, string>;
            dev?: boolean;
            devDependencies?: unknown;
            version?: string;
          }
        >;
      };

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(".audit/test-production-manifest");
      expect(result.stdout).toContain("pnpm-lock.yaml");
      expect(productionPackage.private).toBe(true);
      expect(productionPackage.dependencies).toEqual(packageJson.dependencies);
      expect(productionPackage.devDependencies).toBeUndefined();
      expect(packageLock.packages["node_modules/zod"].version).toBe(
        lock.packages["node_modules/zod"].version,
      );
      expect(packageLock.packages[""].devDependencies).toBeUndefined();
      for (const name of Object.keys(packageJson.dependencies)) {
        expect(packageLock.packages[`node_modules/${name}`]?.dev).toBe(false);
      }
      expect(packageLock.packages["node_modules/@biomejs/biome"]).toBeUndefined();
      expect(readFileSync(join(target, ".npmrc"), "utf8")).toContain("ignore-scripts=true");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it.each([
    { badTarget: "..", sentinelRoot: null },
    { badTarget: ".audit", sentinelRoot: null },
    {
      badTarget: "../b2-mcp-audit-outside-test",
      sentinelRoot: resolve(root, "../b2-mcp-audit-outside-test"),
    },
    {
      badTarget: join(tmpdir(), "b2-mcp-audit-outside"),
      sentinelRoot: join(tmpdir(), "b2-mcp-audit-outside"),
    },
    { badTarget: ".audit-evil", sentinelRoot: resolve(root, ".audit-evil") },
  ])("refuses audit roots outside .audit/ for $badTarget", ({ badTarget, sentinelRoot }) => {
    const sentinel = sentinelRoot ? join(sentinelRoot, "sentinel") : null;

    if (sentinelRoot && sentinel) {
      rmSync(sentinelRoot, { recursive: true, force: true });
      mkdirSync(sentinelRoot, { recursive: true });
      writeFileSync(sentinel, "do-not-delete", { flag: "wx" });
    }

    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/production-security-gate.mjs", "--prepare-only", "--audit-root", badTarget],
        {
          cwd: root,
          encoding: "utf8",
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("audit root must be inside .audit/");
      if (sentinel) expect(existsSync(sentinel)).toBe(true);
    } finally {
      if (sentinelRoot) rmSync(sentinelRoot, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked child path under .audit/", () => {
    if (process.platform === "win32") return;

    const auditRoot = join(root, ".audit");
    const outside = mkdtempSync(join(tmpdir(), "b2-mcp-audit-link-outside-"));
    const link = join(auditRoot, "test-production-link");
    const sentinel = join(outside, "sentinel");

    mkdirSync(auditRoot, { recursive: true });
    rmSync(link, { recursive: true, force: true });
    writeFileSync(sentinel, "do-not-delete", { flag: "wx" });

    try {
      symlinkSync(outside, link, "dir");
      const result = spawnSync(
        process.execPath,
        [
          "scripts/production-security-gate.mjs",
          "--prepare-only",
          "--audit-root",
          ".audit/test-production-link/generated",
        ],
        {
          cwd: root,
          encoding: "utf8",
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("audit root real path must be inside .audit/");
      expect(existsSync(sentinel)).toBe(true);
      expect(existsSync(join(outside, "generated"))).toBe(false);
    } finally {
      if (existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link);
      else rmSync(link, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked .audit directory", () => {
    if (process.platform === "win32") return;

    const fixtureRoot = mkdtempSync(join(tmpdir(), "b2-mcp-audit-fixture-"));
    const auditRoot = join(fixtureRoot, ".audit");
    const outside = mkdtempSync(join(tmpdir(), "b2-mcp-audit-root-outside-"));
    const sentinel = join(outside, "sentinel");

    try {
      writeProductionGateInputs(fixtureRoot);
      writeFileSync(sentinel, "do-not-delete", { flag: "wx" });
      symlinkSync(outside, auditRoot, "dir");

      const result = spawnSync(
        process.execPath,
        [
          "scripts/production-security-gate.mjs",
          "--prepare-only",
          "--audit-root",
          ".audit/test-production-symlinked-root",
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            NODE_ENV: "test",
            B2_MCP_PRODUCTION_GATE_ROOT: fixtureRoot,
          },
          encoding: "utf8",
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(".audit/ must not be a symbolic link");
      expect(existsSync(sentinel)).toBe(true);
      expect(existsSync(join(outside, "test-production-symlinked-root"))).toBe(false);
    } finally {
      if (existsSync(auditRoot) && lstatSync(auditRoot).isSymbolicLink()) unlinkSync(auditRoot);
      rmSync(outside, { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails the production npm audit gate for an unaccepted production advisory", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-production-audit-fail-"));
    const target = ".audit/test-production-advisory-fail";

    try {
      fakeNpmAudit(dir, productionNpmAuditReport(), 1);
      const result = spawnSync(
        process.execPath,
        ["scripts/production-security-gate.mjs", "--audit-root", target],
        {
          cwd: root,
          env: productionGateEnv(dir, {
            B2_MCP_AUDIT_POLICY_JSON: JSON.stringify({ allowedAdvisories: [] }),
          }),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("zod:998000 high: Direct production advisory");
    } finally {
      rmSync(join(root, target), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors scoped audit-policy exceptions in the production npm audit gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-production-audit-allow-"));
    const target = ".audit/test-production-advisory-allow";

    try {
      fakeNpmAudit(dir, productionNpmAuditReport(), 1);
      const result = spawnSync(
        process.execPath,
        ["scripts/production-security-gate.mjs", "--audit-root", target],
        {
          cwd: root,
          env: productionGateEnv(dir, {
            B2_MCP_AUDIT_POLICY_JSON: JSON.stringify({
              allowedAdvisories: [
                {
                  ...directPnpmPolicy.allowedAdvisories[0],
                  nodes: ["node_modules/zod"],
                },
              ],
            }),
          }),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("zod:998000 (high) allowed until 2026-10-01");
      expect(result.stdout).toContain("no unallowed moderate/high/critical advisories");
    } finally {
      rmSync(join(root, target), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a CycloneDX 1.5 production SBOM from the pnpm-locked graph", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-production-sbom-"));
    const target = ".audit/test-production-sbom";
    const sbomPath = `${target}/b2-mcp-production.cdx.json`;

    try {
      fakeNpmAudit(dir, emptyNpmAuditReport(), 0);
      const result = spawnSync(
        process.execPath,
        ["scripts/production-security-gate.mjs", "--audit-root", target, "--sbom", sbomPath],
        {
          cwd: root,
          env: productionGateEnv(dir),
          encoding: "utf8",
        },
      );
      const sbom = JSON.parse(readFileSync(join(root, sbomPath), "utf8"));

      expect(result.status).toBe(0);
      expectCycloneDx15LibrarySbom(sbom);
      expect(sbom.components.length).toBeGreaterThan(0);
    } finally {
      rmSync(join(root, target), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves SBOM dependency edges for peer-suffixed pnpm snapshot versions", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "b2-mcp-production-peer-sbom-"));
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-production-peer-npm-"));
    const target = ".audit/peer-sbom";
    const sbomPath = `${target}/fixture.cdx.json`;

    writeProductionGateInputs(
      fixtureRoot,
      [
        "lockfileVersion: '9.0'",
        "importers:",
        "  .:",
        "    dependencies:",
        "      parent:",
        "        specifier: 1.0.0",
        "        version: 1.0.0(peer@2.0.0)",
        "packages:",
        "  parent@1.0.0:",
        "    resolution: {integrity: sha512-parent}",
        "  child@1.0.0:",
        "    resolution: {integrity: sha512-child}",
        "  peer@2.0.0:",
        "    resolution: {integrity: sha512-peer}",
        "snapshots:",
        "  parent@1.0.0(peer@2.0.0):",
        "    dependencies:",
        "      child: 1.0.0(peer@2.0.0)",
        "      peer: 2.0.0",
        "  child@1.0.0(peer@2.0.0): {}",
        "  peer@2.0.0: {}",
        "",
      ].join("\n"),
    );

    try {
      fakeNpmAudit(dir, emptyNpmAuditReport(), 0);
      const result = spawnSync(
        process.execPath,
        ["scripts/production-security-gate.mjs", "--audit-root", target, "--sbom", sbomPath],
        {
          cwd: root,
          env: productionGateEnv(dir, {
            B2_MCP_PRODUCTION_GATE_ROOT: fixtureRoot,
          }),
          encoding: "utf8",
        },
      );
      const sbom = JSON.parse(readFileSync(join(fixtureRoot, sbomPath), "utf8"));
      const parentDependencies = sbom.dependencies.find(
        (entry: { ref?: string }) => entry.ref === "parent@1.0.0",
      );

      expect(result.status).toBe(0);
      expectCycloneDx15LibrarySbom(sbom);
      expect(parentDependencies?.dependsOn).toContain("child@1.0.0");
      expect(parentDependencies?.dependsOn).toContain("peer@2.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("retries transient npm production audit registry failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-production-audit-"));
    const target = ".audit/test-production-retry";
    const state = join(dir, "attempts");
    const fakeNpm = join(dir, process.platform === "win32" ? "npm.cmd" : "npm");

    writeFileSync(
      fakeNpm,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "const state = process.env.B2_MCP_FAKE_NPM_STATE;",
        "let attempt = 0;",
        'try { attempt = Number(fs.readFileSync(state, "utf8")); } catch {}',
        "attempt += 1;",
        "fs.writeFileSync(state, String(attempt));",
        "const args = process.argv.slice(2);",
        "if (args[0] !== 'audit' || !args.includes('--json')) process.exit(2);",
        "if (attempt === 1) {",
        '  console.error("npm ERR! code EAI_AGAIN");',
        '  console.error("npm ERR! advisory endpoint timed out");',
        "  process.exit(1);",
        "}",
        `console.log(JSON.stringify(${JSON.stringify(emptyNpmAuditReport())}));`,
        "process.exit(0);",
      ].join("\n"),
    );
    chmodSync(fakeNpm, 0o755);

    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        B2_MCP_FAKE_NPM_STATE: state,
      };
      const result = spawnSync(
        process.execPath,
        ["scripts/production-security-gate.mjs", "--audit-root", target],
        {
          cwd: root,
          env,
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("no unallowed moderate/high/critical advisories");
      expect(result.stderr).toContain("npm audit returned a transient non-report response");
      expect(readFileSync(state, "utf8")).toBe("2");
    } finally {
      rmSync(join(root, target), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("guards ci-green against stale main workflow runs", () => {
    const markGreenJob = jobBlock("mark-green");
    expect(markGreenJob).toContain("group: ci-green-${{ github.repository }}-main");
    expect(markGreenJob).toContain("cancel-in-progress: false");
    expect(markGreenJob).toContain("current_main_sha");
    expect(markGreenJob).toContain("git ls-remote origin refs/heads/main");
    expect(markGreenJob).toContain("Skipping ci-green update for stale run");
    expect(markGreenJob).toContain('git push origin "${GITHUB_SHA}:refs/heads/ci-green" --force');
    expect(markGreenJob).toContain("Advanced owned ci-green marker to");
  });

  it("refuses environment-injected audit fixtures outside tests", () => {
    const result = spawnSync(process.execPath, ["scripts/audit-supply-chain.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        NODE_ENV: "production",
        B2_MCP_AUDIT_REPORT_JSON: JSON.stringify({
          auditReportVersion: 2,
          vulnerabilities: {},
        }),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing B2_MCP_AUDIT_REPORT_JSON outside NODE_ENV=test");
  });

  it("refuses environment-injected audit policy outside tests", () => {
    const result = spawnSync(process.execPath, ["scripts/audit-supply-chain.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        NODE_ENV: "production",
        B2_MCP_AUDIT_POLICY_JSON: JSON.stringify(exceptionPolicy),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing B2_MCP_AUDIT_POLICY_JSON outside NODE_ENV=test");
  });

  it("fails closed when pnpm audit reports multiple advisories for one package", () => {
    const result = spawnSync(process.execPath, ["scripts/audit-supply-chain.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        B2_MCP_AUDIT_POLICY_JSON: JSON.stringify({ allowedAdvisories: [] }),
        B2_MCP_AUDIT_REPORT_JSON: JSON.stringify({
          advisories: {
            1001: {
              id: 1001,
              module_name: "evilpkg",
              severity: "high",
              title: "High severity advisory",
              url: "https://advisories.example/1001",
              vulnerable_versions: "<1.0.1",
              findings: [{ paths: ["node_modules/evilpkg"] }],
            },
            1002: {
              id: 1002,
              module_name: "evilpkg",
              severity: "low",
              title: "Low severity advisory",
              url: "https://advisories.example/1002",
              vulnerable_versions: "<1.0.2",
              findings: [{ paths: ["node_modules/evilpkg"] }],
            },
          },
        }),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("evilpkg:1001 high: High severity advisory");
  });

  it("derives direct pnpm advisories from finding paths", () => {
    const result = runAudit(directPnpmAuditReport(), {}, directPnpmPolicy);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("zod:998000 (high) allowed until 2026-10-01");
  });

  it("evaluates parseable pnpm audit reports with severity exit codes", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-audit-exit-"));
    const fakePnpm = join(dir, "pnpm");
    writeFileSync(
      fakePnpm,
      [
        "#!/usr/bin/env node",
        `const report = ${JSON.stringify(scopedAuditReport())};`,
        "console.log(JSON.stringify(report));",
        "process.exit(16);",
      ].join("\n"),
    );
    chmodSync(fakePnpm, 0o755);

    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        NODE_ENV: "test",
        B2_MCP_AUDIT_POLICY_JSON: JSON.stringify(exceptionPolicy),
      };
      delete env.B2_MCP_AUDIT_REPORT_JSON;
      const result = spawnSync(process.execPath, ["scripts/audit-supply-chain.mjs"], {
        cwd: root,
        env,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("acorn:999000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries transient pnpm audit registry failures before evaluating advisories", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-audit-pnpm-"));
    const state = join(dir, "attempts");
    const fakePnpm = join(dir, "pnpm");
    writeFileSync(
      fakePnpm,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `const report = ${JSON.stringify(scopedAuditReport())};`,
        "const state = process.env.B2_MCP_FAKE_NPM_STATE;",
        "let attempt = 0;",
        'try { attempt = Number(fs.readFileSync(state, "utf8")); } catch {}',
        "attempt += 1;",
        "fs.writeFileSync(state, String(attempt));",
        "if (attempt === 1) {",
        '  console.error("pnpm ERR! code EAI_AGAIN");',
        '  console.error("pnpm ERR! registry network timeout");',
        "  process.exit(1);",
        "}",
        "console.log(JSON.stringify(report));",
        "process.exit(1);",
      ].join("\n"),
    );
    chmodSync(fakePnpm, 0o755);

    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        NODE_ENV: "test",
        B2_MCP_FAKE_NPM_STATE: state,
        B2_MCP_AUDIT_POLICY_JSON: JSON.stringify(exceptionPolicy),
      };
      delete env.B2_MCP_AUDIT_REPORT_JSON;
      const result = spawnSync(process.execPath, ["scripts/audit-supply-chain.mjs"], {
        cwd: root,
        env,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("transient non-report response");
      expect(readFileSync(state, "utf8")).toBe("2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["NODE_ENV=production", { NODE_ENV: "production" }],
    ["npm_config_omit=dev", { NODE_ENV: "test", npm_config_omit: "dev", NPM_CONFIG_OMIT: "dev" }],
  ])("reports dev-only high advisories when %s is inherited", (_name, inheritedEnv) => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-audit-dev-"));
    const fakePnpm = join(dir, "pnpm");
    writeFileSync(
      fakePnpm,
      [
        "#!/usr/bin/env node",
        `const report = ${JSON.stringify(devOnlyAuditReport())};`,
        "const args = process.argv.slice(2);",
        'const devIncluded = args[0] === "audit" && args.includes("--json") && process.env.npm_config_include === "dev";',
        "const omitCleared =",
        "  !process.env.npm_config_omit && !process.env.NPM_CONFIG_OMIT &&",
        "  !process.env.npm_config_only && !process.env.NPM_CONFIG_ONLY &&",
        '  process.env.NODE_ENV === "development" &&',
        '  process.env.npm_config_production === "false";',
        "if (devIncluded && omitCleared) {",
        "  console.log(JSON.stringify(report));",
        "  process.exit(1);",
        "}",
        "console.log(JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }));",
        "process.exit(0);",
      ].join("\n"),
    );
    chmodSync(fakePnpm, 0o755);

    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        ...inheritedEnv,
      };
      delete env.B2_MCP_AUDIT_REPORT_JSON;
      delete env.B2_MCP_AUDIT_POLICY_JSON;
      delete env.B2_MCP_AUDIT_TODAY;
      const result = spawnSync(process.execPath, ["scripts/audit-supply-chain.mjs"], {
        cwd: root,
        env,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dev-only-vulnerable-tool:999002 high");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for expired advisory exceptions by default", () => {
    const result = runAudit(scopedAuditReport(), { B2_MCP_AUDIT_TODAY: "2026-10-02" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error::audit-policy: acorn:999000");
    expect(result.stderr).toContain("exception expired on 2026-10-01");
  });

  it.each([
    ["missing", policyWithException({}, true), "undefined"],
    ["malformed", policyWithException({ expires: "never" }), '"never"'],
    ["impossible", policyWithException({ expires: "2026-02-30" }), '"2026-02-30"'],
  ])("fails closed for %s advisory exception expiry", (_name, policy, expectedValue) => {
    const result = runAudit(scopedAuditReport(), {}, policy);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error::audit-policy: acorn:999000");
    expect(result.stderr).toContain("expires must be a real YYYY-MM-DD calendar date");
    expect(result.stderr).toContain(expectedValue);
  });

  it("supports warn mode only as a non-gating expired-exception reminder", () => {
    const result = runAudit(scopedAuditReport(), {
      B2_MCP_AUDIT_EXPIRED_EXCEPTION_MODE: "warn",
      B2_MCP_AUDIT_TODAY: "2026-10-02",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("::warning::audit-policy: acorn:999000");
    expect(result.stderr).toContain("exception expired on 2026-10-01");
  });

  it("still fails for unallowed advisories in warn mode", () => {
    const result = runAudit(unallowedAuditReport(), {
      B2_MCP_AUDIT_EXPIRED_EXCEPTION_MODE: "warn",
      B2_MCP_AUDIT_TODAY: "2026-10-02",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error::audit-policy: new-vulnerable-package:999001");
  });

  it("ships without advisory exceptions", () => {
    expect(auditPolicy.allowedAdvisories).toEqual([]);
  });

  it("allows only a tightly scoped test advisory", () => {
    const result = runAudit(scopedAuditReport());
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("acorn:999000");
  });

  it.each([
    ["direct dependency", { isDirect: true }],
    ["unexpected dependency path", { effects: ["unexpected-parent"] }],
    [
      "re-rated high severity",
      {
        severity: "high",
        via: [
          {
            source: 999000,
            name: "acorn",
            dependency: "acorn",
            title: "Test-only transitive advisory",
            url: "https://github.com/advisories/test-only",
            severity: "high",
            range: "<4.0.7",
          },
        ],
      },
    ],
  ])("fails the audit for %s", (_name, overrides) => {
    const result = runAudit(scopedAuditReport(overrides));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("acorn:999000");
  });
});
