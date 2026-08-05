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

describe("supply-chain audit policy", () => {
  const workflow = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");
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
      { version?: string; integrity?: string; dependencies?: Record<string, string> }
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
