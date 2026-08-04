import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "../..");

describe("supply-chain audit policy", () => {
  const workflow = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");
  const auditPolicy = JSON.parse(readFileSync(join(root, "audit-policy.json"), "utf8")) as {
    allowedAdvisories: Array<{ name: string; source: number; expires: string }>;
  };

  function jobBlock(name: string): string {
    const start = workflow.indexOf(`  ${name}:`);
    if (start === -1) return "";
    const rest = workflow.slice(start + 1);
    const next = rest.search(/\n {2}[a-zA-Z0-9_-]+:/);
    return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
  }

  it("runs the full lockfile audit outside the deploy-gating path", () => {
    const deterministicJob = jobBlock("deterministic-linux");
    expect(workflow).toContain("supply-chain-audit:");
    expect(workflow).toContain("npm run audit:supply-chain");
    expect(workflow).not.toContain("npm audit --omit=dev");
    expect(deterministicJob).not.toContain("npm run audit:supply-chain");
    expect(workflow).toContain(
      "needs: [runtime-policy, deterministic-linux, cross-platform-minimum]",
    );
  });

  it("tracks expiring exceptions for known moderate or dev-tool advisories", () => {
    expect(auditPolicy.allowedAdvisories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "@hono/node-server", source: 1124006 }),
      ]),
    );
    for (const advisory of auditPolicy.allowedAdvisories) {
      expect(advisory.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
