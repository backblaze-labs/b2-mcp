import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "../..");

const liveWorkflows = [
  {
    path: ".github/workflows/contract.yml",
    job: "contract",
    environment: "live-b2-contract",
    concurrency: "live-b2-contract-${{ github.repository }}",
  },
  {
    path: ".github/workflows/smoke.yml",
    job: "smoke",
    environment: "live-b2-smoke",
    concurrency: "live-b2-smoke-${{ github.repository }}",
  },
];

const workflowText = (path: string) => readFileSync(join(root, path), "utf8");

const topLevelMappingEntry = (key: string, childKey: string, value: string) =>
  new RegExp(
    `^${key}:\\s*\\n(?:\\s*#.*\\n)*\\s+${childKey}:\\s*${value.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    )}\\s*$`,
    "m",
  );

const jobField = (job: string, field: string, value: string) =>
  new RegExp(
    `^  ${job}:\\s*\\n[\\s\\S]*?^    ${field}:\\s*${value.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    )}\\s*$`,
    "m",
  );

describe("live secret workflow policy", () => {
  it.each(liveWorkflows)(
    "$path wires the protected environment, protected refs, and shared Node version",
    ({ path, job, environment }) => {
      const text = workflowText(path);
      expect(text).toMatch(topLevelMappingEntry("permissions", "contents", "read"));
      expect(text).toMatch(jobField(job, "environment", environment));
      expect(text).toMatch(/^\s{2}guard:\s*$/m);
      expect(text).toMatch(/if: github\.repository == 'backblaze-labs\/b2-mcp'/);
      expect(text).toContain('[[ "$GITHUB_REF" != "refs/heads/main" ]]');
      expect(text).toContain('[[ "$GITHUB_REF" != refs/tags/v* ]]');
      expect(text).toContain('protected_ref="refs/heads/ci-green"');
      expect(text).toContain('tag_sha="$(git ls-remote origin "${GITHUB_REF}^{}"');
      expect(text).toContain('"$tag_sha" != "$ci_green_sha"');
      expect(text).toContain("node-version-file: .nvmrc");
    },
  );

  it.each(liveWorkflows)(
    "$path serializes runs and never cancels in-progress cleanup",
    ({ path, concurrency }) => {
      const text = workflowText(path);
      expect(text).toMatch(topLevelMappingEntry("concurrency", "group", concurrency));
      expect(text).toContain("cancel-in-progress: false");
    },
  );

  it.each(liveWorkflows)("$path checks out ci-green before running package code", ({ path }) => {
    const text = workflowText(path);
    expect(text).toContain("ref: ${{ needs.guard.outputs.checkout-ref }}");
    expect(text).toContain('checkout_ref="ci-green"');
    expect(text).not.toContain("github.event_name == 'release'");
    expect(text).not.toContain("startsWith(github.ref, 'refs/tags/v')");
  });

  it("does not schedule recurring live contract writes", () => {
    const text = workflowText(".github/workflows/contract.yml");
    expect(text).not.toMatch(/^\s{2}schedule:\s*$/m);
    expect(text).not.toContain("cron:");
  });

  it("keeps live contract cleanup context visible in logs", () => {
    const text = workflowText(".github/workflows/contract.yml");
    expect(text).toContain("Print cleanup context");
    expect(text).toContain("contract_bucket_prefix=mcp-contract-");
    expect(text).toContain("contract_key_prefix=c-v");
  });

  it.each(liveWorkflows)("$path uses only environment-scoped B2 secrets", ({ path }) => {
    const text = workflowText(path);
    const secretRefs = [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
    expect(secretRefs.filter((name) => name.includes("B2"))).not.toEqual([]);
    expect(secretRefs.filter((name) => name.includes("B2"))).toEqual(
      expect.arrayContaining([
        "LIVE_B2_KEY_ID",
        "LIVE_B2_KEY",
        "LIVE_B2_APP_KEY_ID",
        "LIVE_B2_APP_KEY",
      ]),
    );
    expect(secretRefs.filter((name) => /^B2_/.test(name))).toEqual([]);
  });
});
