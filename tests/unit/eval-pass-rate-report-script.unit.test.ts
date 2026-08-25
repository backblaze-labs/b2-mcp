import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { describe, expect, it } from "vitest";
import { root } from "../contract/support";

const script = join(root, "scripts/eval-pass-rate-report.mjs");

function tempReportPath(): string {
  return join(mkdtempSync(join(tmpdir(), "b2-mcp-eval-report-")), "report.json");
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-24T00:00:00.000Z",
    caseCount: 1,
    providers: [
      { provider: "Claude", model: "claude-haiku-4-5-20251001", passed: 1, total: 1, passRate: 1 },
      { provider: "OpenAI", model: "gpt-5-nano", passed: 1, total: 1, passRate: 1 },
    ],
    summary:
      "Pass-rate comparison (Claude vs OpenAI) across 1 shared case(s): " +
      "Claude: 1/1 (100.0%); OpenAI: 1/1 (100.0%).",
    results: [
      { provider: "Claude", caseName: "blocked delete bucket", status: "passed", passed: true },
      { provider: "OpenAI", caseName: "blocked delete bucket", status: "passed", passed: true },
    ],
    sensitivity: {
      secretSafe: true,
      omitted: ["provider API keys"],
    },
    ...overrides,
  };
}

function runScript(command: string, path: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script, command, path], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("eval pass-rate report script", () => {
  it("validates a schema-compatible report and renders the summary table", () => {
    const path = tempReportPath();
    writeFileSync(path, `${JSON.stringify(report())}\n`, "utf8");

    const validation = runScript("validate", path);
    const summary = runScript("summary", path);

    expect(validation.status).toBe(0);
    expect(summary.status).toBe(0);
    expect(summary.stdout).toContain("## Claude vs OpenAI pass rates");
    expect(summary.stdout).toContain("| OpenAI | gpt-5-nano | 1 | 1 | 100.0% |");
  });

  it("rejects reports containing exact provider secret values", () => {
    const path = tempReportPath();
    writeFileSync(
      path,
      `${JSON.stringify(report({ summary: "leaked sk-proj-secret123456789" }))}\n`,
      "utf8",
    );

    const validation = runScript("validate", path, {
      OPENAI_API_KEY: "sk-proj-secret123456789",
    });

    expect(validation.status).not.toBe(0);
    expect(validation.stderr).toContain("provider secret value");
    expect(validation.stderr).not.toContain("sk-proj-secret123456789");
  });

  it("validates a single configured provider (Anthropic-only)", () => {
    const path = tempReportPath();
    writeFileSync(
      path,
      `${JSON.stringify(
        report({
          providers: [
            {
              provider: "Claude",
              model: "claude-haiku-4-5-20251001",
              passed: 1,
              total: 1,
              passRate: 1,
            },
          ],
          summary: "Pass-rate comparison (Claude) across 1 shared case(s): Claude: 1/1 (100.0%).",
          results: [
            {
              provider: "Claude",
              caseName: "blocked delete bucket",
              status: "passed",
              passed: true,
            },
          ],
        }),
      )}\n`,
      "utf8",
    );

    const validation = runScript("validate", path);
    const summary = runScript("summary", path);

    expect(validation.status).toBe(0);
    expect(summary.status).toBe(0);
    expect(summary.stdout).toContain("## Claude pass rates");
    expect(summary.stdout).toContain("| Claude | claude-haiku-4-5-20251001 | 1 | 1 | 100.0% |");
    expect(summary.stdout).not.toContain("OpenAI");
  });

  it("rejects providers outside the allowed set", () => {
    const path = tempReportPath();
    writeFileSync(
      path,
      `${JSON.stringify(
        report({
          providers: [
            { provider: "Other", model: "other-model", passed: 1, total: 1, passRate: 1 },
          ],
          results: [
            {
              provider: "Other",
              caseName: "blocked delete bucket",
              status: "passed",
              passed: true,
            },
          ],
        }),
      )}\n`,
      "utf8",
    );

    const validation = runScript("validate", path);

    expect(validation.status).not.toBe(0);
    expect(validation.stderr).toContain("must be Claude or OpenAI");
  });

  it("rejects duplicate provider entries", () => {
    const path = tempReportPath();
    writeFileSync(
      path,
      `${JSON.stringify(
        report({
          providers: [
            {
              provider: "Claude",
              model: "claude-haiku-4-5-20251001",
              passed: 1,
              total: 1,
              passRate: 1,
            },
            {
              provider: "Claude",
              model: "claude-haiku-4-5-20251001",
              passed: 1,
              total: 1,
              passRate: 1,
            },
          ],
          results: [
            {
              provider: "Claude",
              caseName: "blocked delete bucket",
              status: "passed",
              passed: true,
            },
          ],
        }),
      )}\n`,
      "utf8",
    );

    const validation = runScript("validate", path);

    expect(validation.status).not.toBe(0);
    expect(validation.stderr).toContain("is duplicated");
  });

  it("rejects provider rates that do not match case totals", () => {
    const path = tempReportPath();
    writeFileSync(
      path,
      `${JSON.stringify(
        report({
          providers: [
            {
              provider: "Claude",
              model: "claude-haiku-4-5-20251001",
              passed: 0,
              total: 1,
              passRate: 1,
            },
            { provider: "OpenAI", model: "gpt-5-nano", passed: 1, total: 2, passRate: 0.5 },
          ],
        }),
      )}\n`,
      "utf8",
    );

    const validation = runScript("validate", path);

    expect(validation.status).not.toBe(0);
    expect(validation.stderr).toMatch(/passRate must equal passed \/ total|total must equal/);
  });

  it("rejects reports with unknown raw payload fields", () => {
    const path = tempReportPath();
    writeFileSync(
      path,
      `${JSON.stringify(
        report({
          providers: [
            {
              provider: "Claude",
              model: "claude-haiku-4-5-20251001",
              passed: 1,
              total: 1,
              passRate: 1,
            },
            { provider: "OpenAI", model: "gpt-5-nano", passed: 0, total: 1, passRate: 0 },
          ],
          results: [
            {
              provider: "Claude",
              caseName: "passed case",
              status: "passed",
              passed: true,
            },
            {
              provider: "OpenAI",
              caseName: "failed case",
              status: "failed",
              passed: false,
              failure: "failed",
              response: { toolCalls: [{ name: "b2_list_buckets", args: {} }] },
            },
          ],
        }),
      )}\n`,
      "utf8",
    );

    const validation = runScript("validate", path);

    expect(validation.status).not.toBe(0);
    expect(validation.stderr).toContain("report.results[1].response is not allowed");
  });

  it("rejects raw diagnostics in allowed result fields", () => {
    const path = tempReportPath();
    writeFileSync(
      path,
      `${JSON.stringify(
        report({
          providers: [
            {
              provider: "Claude",
              model: "claude-haiku-4-5-20251001",
              passed: 1,
              total: 1,
              passRate: 1,
            },
            { provider: "OpenAI", model: "gpt-5-nano", passed: 0, total: 1, passRate: 0 },
          ],
          results: [
            {
              provider: "Claude",
              caseName: "passed case",
              status: "passed",
              passed: true,
            },
            {
              provider: "OpenAI",
              caseName: "errored case",
              status: "errored",
              passed: false,
              error: "raw model text and tool payload",
            },
          ],
        }),
      )}\n`,
      "utf8",
    );

    const validation = runScript("validate", path);

    expect(validation.status).not.toBe(0);
    expect(validation.stderr).toContain("bounded errored diagnostic");
  });

  it("requires result passed flags to match status", () => {
    const path = tempReportPath();
    writeFileSync(
      path,
      `${JSON.stringify(
        report({
          results: [
            {
              provider: "Claude",
              caseName: "blocked delete bucket",
              status: "passed",
              passed: true,
            },
            {
              provider: "OpenAI",
              caseName: "blocked delete bucket",
              status: "passed",
              passed: false,
            },
          ],
        }),
      )}\n`,
      "utf8",
    );

    const validation = runScript("validate", path);

    expect(validation.status).not.toBe(0);
    expect(validation.stderr).toContain("passed must equal whether status is passed");
  });
});
