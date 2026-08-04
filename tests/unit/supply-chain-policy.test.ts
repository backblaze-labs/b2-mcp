import { readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const root = join(__dirname, "../..");

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
    const start = workflow.indexOf(`  ${name}:`);
    if (start === -1) return "";
    const rest = workflow.slice(start + 1);
    const next = rest.search(/\n {2}[a-zA-Z0-9_-]+:/);
    return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
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

  function runAudit(report: unknown) {
    return spawnSync(process.execPath, ["scripts/audit-supply-chain.mjs"], {
      cwd: root,
      env: { ...process.env, B2_MCP_AUDIT_REPORT_JSON: JSON.stringify(report) },
      encoding: "utf8",
    });
  }

  it("runs the full lockfile audit on the ci-green deploy-gating path", () => {
    const deterministicJob = jobBlock("deterministic-linux");
    const auditJob = jobBlock("supply-chain-audit");
    const markGreenJob = jobBlock("mark-green");
    expect(workflow).toContain("supply-chain-audit:");
    expect(workflow).toContain("npm run audit:supply-chain");
    expect(workflow).not.toContain("npm audit --omit=dev");
    expect(auditJob).not.toContain("if: github.event_name == 'pull_request'");
    expect(deterministicJob).not.toContain("npm run audit:supply-chain");
    expect(markGreenJob).toContain(
      "needs: [runtime-policy, deterministic-linux, supply-chain-audit]",
    );
    expect(markGreenJob).not.toContain("cross-platform-minimum");
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
