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

  function jobBlock(name: string): string {
    return workflowJobBlock(workflow, name) ?? "";
  }

  function scopedAuditReport(overrides: Record<string, unknown> = {}) {
    return {
      auditReportVersion: 2,
      vulnerabilities: {
        "@hono/node-server": {
          name: "@hono/node-server",
          severity: "moderate",
          isDirect: false,
          via: [
            {
              source: 1124006,
              name: "@hono/node-server",
              dependency: "@hono/node-server",
              title: "Node.js Adapter for Hono path traversal",
              url: "https://github.com/advisories/GHSA-frvp-7c67-39w9",
              severity: "moderate",
              range: "<2.0.5",
            },
          ],
          effects: ["@modelcontextprotocol/node"],
          range: "<2.0.5",
          nodes: ["node_modules/@hono/node-server"],
          fixAvailable: false,
          ...overrides,
        },
        "@modelcontextprotocol/node": {
          name: "@modelcontextprotocol/node",
          severity: "moderate",
          isDirect: true,
          via: ["@hono/node-server"],
          effects: [],
          range: "*",
          nodes: ["node_modules/@modelcontextprotocol/node"],
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

  function runAudit(report: unknown, extraEnv: Record<string, string> = {}) {
    return spawnSync(process.execPath, ["scripts/audit-supply-chain.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        B2_MCP_AUDIT_REPORT_JSON: JSON.stringify(report),
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
    expect(markGreenJob).toContain(
      "needs: [runtime-policy, deterministic-linux-production, supply-chain-audit]",
    );
    expect(markGreenJob).not.toContain("deterministic-linux-current");
    expect(markGreenJob).not.toContain("cross-platform-minimum");
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
        B2_MCP_FAKE_NPM_STATE: state,
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

  it("fails closed for expired advisory exceptions by default", () => {
    const result = runAudit(scopedAuditReport(), { B2_MCP_AUDIT_TODAY: "2026-10-02" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error::audit-policy: @hono/node-server:1124006");
    expect(result.stderr).toContain("exception expired on 2026-10-01");
  });

  it("supports warn mode only as a non-gating expired-exception reminder", () => {
    const result = runAudit(scopedAuditReport(), {
      B2_MCP_AUDIT_EXPIRED_EXCEPTION_MODE: "warn",
      B2_MCP_AUDIT_TODAY: "2026-10-02",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("::warning::audit-policy: @hono/node-server:1124006");
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

  it("tracks tightly scoped exceptions for known moderate advisories", () => {
    expect(auditPolicy.allowedAdvisories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "@hono/node-server",
          source: 1124006,
          maxSeverity: "moderate",
          isDirect: false,
          nodes: ["node_modules/@hono/node-server"],
          effects: ["@modelcontextprotocol/node"],
        }),
      ]),
    );
    for (const advisory of auditPolicy.allowedAdvisories) {
      expect(advisory.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(advisory.package.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(advisory.package.integrity).toMatch(/^sha512-/);
      expect(advisory.via.path).toBe(`node_modules/${advisory.via.name}`);
    }
  });

  it("allows only the documented scoped Hono advisory", () => {
    const result = runAudit(scopedAuditReport());
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("@hono/node-server:1124006");
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
            source: 1124006,
            name: "@hono/node-server",
            dependency: "@hono/node-server",
            title: "Node.js Adapter for Hono path traversal",
            url: "https://github.com/advisories/GHSA-frvp-7c67-39w9",
            severity: "high",
            range: "<2.0.5",
          },
        ],
      },
    ],
  ])("fails the audit for %s", (_name, overrides) => {
    const result = runAudit(scopedAuditReport(overrides));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@hono/node-server:1124006");
  });
});
