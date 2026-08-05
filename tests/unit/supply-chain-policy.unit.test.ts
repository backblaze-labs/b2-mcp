import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { createRequire } from "module";

const root = join(__dirname, "../..");
const nodeRequire = createRequire(__filename);
const { workflowJobBlock } = nodeRequire("../../scripts/lib/workflow-yaml.cjs") as {
  workflowJobBlock: (text: string, jobName: string) => string | null;
};
const semver = nodeRequire("semver") as {
  satisfies: (version: string, range: string, options?: { includePrerelease?: boolean }) => boolean;
};

describe("supply-chain audit policy", () => {
  const workflow = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");
  const publishWorkflow = readFileSync(join(root, ".github/workflows/publish.yml"), "utf8");
  const npmrc = readFileSync(join(root, ".npmrc"), "utf8");
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
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
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
    packages: Record<
      string,
      {
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        engines?: { node?: string };
        integrity?: string;
        version?: string;
      }
    >;
  };
  const braceExpansion = lock.packages["node_modules/brace-expansion"];
  const minimatch = lock.packages["node_modules/minimatch"];
  const exceptionPolicy = {
    allowedAdvisories: [
      {
        name: "brace-expansion",
        source: 999000,
        maxSeverity: "moderate",
        isDirect: false,
        nodes: ["node_modules/brace-expansion"],
        effects: ["minimatch"],
        package: { version: braceExpansion.version, integrity: braceExpansion.integrity },
        via: {
          path: "node_modules/minimatch",
          name: "minimatch",
          version: minimatch.version,
          dependencyRange: minimatch.dependencies?.["brace-expansion"],
        },
        expires: "2026-10-01",
        reason: "Test-only exception fixture for policy behavior.",
      },
    ],
  };

  function jobBlock(name: string): string {
    return workflowJobBlock(workflow, name) ?? "";
  }

  function publishJobBlock(name: string): string {
    return workflowJobBlock(publishWorkflow, name) ?? "";
  }

  function scopedAuditReport(overrides: Record<string, unknown> = {}) {
    return {
      auditReportVersion: 2,
      vulnerabilities: {
        "brace-expansion": {
          name: "brace-expansion",
          severity: "moderate",
          isDirect: false,
          via: [
            {
              source: 999000,
              name: "brace-expansion",
              dependency: "brace-expansion",
              title: "Test-only transitive advisory",
              url: "https://github.com/advisories/test-only",
              severity: "moderate",
              range: "<1.1.19",
            },
          ],
          effects: ["minimatch"],
          range: "<1.1.19",
          nodes: ["node_modules/brace-expansion"],
          fixAvailable: false,
          ...overrides,
        },
        minimatch: {
          name: "minimatch",
          severity: "moderate",
          isDirect: false,
          via: ["brace-expansion"],
          effects: [],
          range: "*",
          nodes: ["node_modules/minimatch"],
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

  it("runs the full lockfile audit on the ci-green deploy-gating path", () => {
    const productionJob = jobBlock("deterministic-linux-production");
    const currentJob = jobBlock("deterministic-linux-current");
    const auditJob = jobBlock("supply-chain-audit");
    const markGreenJob = jobBlock("mark-green");
    expect(workflow).toContain("supply-chain-audit:");
    expect(workflow).toContain("npm run audit:supply-chain");
    expect(workflow).toContain(
      "npm run audit:supply-chain:denylist -- --ref HEAD --ref origin/main --packlist",
    );
    expect(auditJob).toContain("fetch-depth: 0");
    expect(auditJob).toContain(
      "git fetch --prune --no-tags origin '+refs/heads/main:refs/remotes/origin/main'",
    );
    expect(auditJob).toContain('sleep "$attempt"');
    expect(auditJob).not.toContain("refs/heads/*:refs/remotes/origin/*");
    expect(auditJob).not.toContain("--all-branches");
    expect(workflow).not.toContain("npm audit --omit=dev");
    expect(auditJob).not.toContain("if: github.event_name == 'pull_request'");
    expect(auditJob).toContain("Reject injected audit fixtures");
    expect(auditJob).toContain("B2_MCP_AUDIT_REPORT_JSON is test-only");
    expect(auditJob).toContain("B2_MCP_AUDIT_EXPIRED_EXCEPTION_MODE: fail");
    expect(auditJob).not.toContain("B2_MCP_AUDIT_EXPIRED_EXCEPTION_MODE: warn");
    expect(productionJob).not.toContain("npm run audit:supply-chain");
    expect(currentJob).not.toContain("npm run audit:supply-chain");
    for (const required of [
      "runtime-engine-floor",
      "deterministic-linux-production",
      "deterministic-linux-current",
      "cross-platform-minimum",
      "supply-chain-audit",
    ]) {
      expect(markGreenJob).toContain(required);
    }
  });

  it("disables normal lifecycle scripts and isolates npm publishing", () => {
    expect(npmrc).toMatch(/^ignore-scripts=true$/m);
    expect(packageJson.scripts["audit:supply-chain"]).toContain(
      "npm run audit:supply-chain:denylist -- --packlist",
    );
    expect(packageJson.scripts["audit:supply-chain:denylist"]).toBe(
      "node scripts/check-supply-chain-denylist.mjs",
    );
    expect(packageJson.scripts.test).toBe("npm run typecheck && npm run test:unit");
    expect(packageJson.scripts.pretest).toBeUndefined();
    expect(packageJson.scripts.prepublishOnly).toBeUndefined();
    expect(publishWorkflow).toContain("permissions:");
    expect(publishWorkflow).toContain("id-token: write");
    expect(publishWorkflow).toContain("environment: npm-publish");
    expect(publishWorkflow).toContain("ci-green");
    expect(publishWorkflow).toContain(
      "npm run audit:supply-chain:denylist -- --ref HEAD --ref origin/main --packlist --expect-pack-file dist/index.js",
    );
    expect(publishWorkflow).toContain('--tarball "$tarball"');
    expect(publishWorkflow).toContain('sha256sum "$tarball"');
    expect(publishWorkflow).toContain("retention-days: 7");
    expect(publishWorkflow).toContain("--provenance --access public --ignore-scripts");
    expect(publishWorkflow).not.toContain("--ignore-scripts=false");
    expect(publishWorkflow).not.toContain("tar -xzf");
  });

  it("exact-pins executable doc lint tooling", () => {
    for (const name of [
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
        return range && !semver.satisfies("22.3.0", range);
      })
      .map((path) => {
        const pkg = lock.packages[path];
        return `${path}@${pkg.version}: ${pkg.engines?.node}`;
      });

    expect(unsupported).toEqual([]);
  });

  it("runs doc lint without persisted checkout credentials", () => {
    for (const name of ["deterministic-linux-production", "deterministic-linux-current"]) {
      const job = jobBlock(name);
      expect(job).toContain("persist-credentials: false");
      expect(job).toContain("npm run lint:docs");
    }
  });

  it("keeps npm trusted-publishing OIDC away from repo and dependency code", () => {
    const prepareJob = publishJobBlock("prepare");
    const publishJob = publishJobBlock("publish");

    expect(prepareJob).not.toContain("id-token: write");
    expect(prepareJob).toContain("npm run typecheck");
    expect(prepareJob).toContain("npm run build");
    expect(prepareJob).toContain("persist-credentials: false");
    expect(publishJob).toContain("id-token: write");
    expect(publishJob).not.toContain("npm run typecheck");
    expect(publishJob).not.toContain("npm run build");
    expect(publishJob).not.toContain("--ignore-scripts=false");
    expect(publishJob).toContain("npm publish");
    expect(publishJob).toContain("--ignore-scripts");
  });

  it.each([
    ["CI", workflow],
    ["publish", publishWorkflow],
  ])("pins every marketplace action used by the %s workflow", (_name, workflowText) => {
    const uses = [...workflowText.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/g)].map((match) => ({
      action: match[1],
      ref: match[2],
    }));

    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action.ref).toMatch(/^[a-f0-9]{40}$/);
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
    expect(markGreenJob).toContain("Advanced ci-green to");
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

  it("retries transient npm audit registry failures before evaluating advisories", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-audit-npm-"));
    const state = join(dir, "attempts");
    const fakeNpm = join(dir, "npm");
    writeFileSync(
      fakeNpm,
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
        '  console.error("npm ERR! code EAI_AGAIN");',
        '  console.error("npm ERR! registry network timeout");',
        "  process.exit(1);",
        "}",
        "console.log(JSON.stringify(report));",
        "process.exit(1);",
      ].join("\n"),
    );
    chmodSync(fakeNpm, 0o755);

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
    const fakeNpm = join(dir, "npm");
    writeFileSync(
      fakeNpm,
      [
        "#!/usr/bin/env node",
        `const report = ${JSON.stringify(devOnlyAuditReport())};`,
        "const args = process.argv.slice(2);",
        'const devIncluded = args.includes("--include=dev") && process.env.npm_config_include === "dev";',
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
    chmodSync(fakeNpm, 0o755);

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
    expect(result.stderr).toContain("::error::audit-policy: brace-expansion:999000");
    expect(result.stderr).toContain("exception expired on 2026-10-01");
  });

  it.each([
    ["missing", policyWithException({}, true), "undefined"],
    ["malformed", policyWithException({ expires: "never" }), '"never"'],
    ["impossible", policyWithException({ expires: "2026-02-30" }), '"2026-02-30"'],
  ])("fails closed for %s advisory exception expiry", (_name, policy, expectedValue) => {
    const result = runAudit(scopedAuditReport(), {}, policy);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error::audit-policy: brace-expansion:999000");
    expect(result.stderr).toContain("expires must be a real YYYY-MM-DD calendar date");
    expect(result.stderr).toContain(expectedValue);
  });

  it("supports warn mode only as a non-gating expired-exception reminder", () => {
    const result = runAudit(scopedAuditReport(), {
      B2_MCP_AUDIT_EXPIRED_EXCEPTION_MODE: "warn",
      B2_MCP_AUDIT_TODAY: "2026-10-02",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("::warning::audit-policy: brace-expansion:999000");
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
    expect(result.stderr).toContain("brace-expansion:999000");
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
            name: "brace-expansion",
            dependency: "brace-expansion",
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
    expect(result.stderr).toContain("brace-expansion:999000");
  });
});
