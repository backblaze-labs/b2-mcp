import { readFileSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import { root } from "./support";

const nodeRequire = createRequire(__filename);
const { yamlValuesForKey } = nodeRequire("../../scripts/lib/workflow-yaml.cjs") as {
  yamlValuesForKey: (text: string, key: string) => Array<string | string[]>;
};
const runtimePolicy = JSON.parse(readFileSync(join(root, "runtime-policy.json"), "utf8")) as {
  liveNodeMatrix: string[];
};

const liveWorkflows = [
  {
    path: ".github/workflows/contract.yml",
    job: "contract",
    environment: "live-b2-contract",
    concurrency: "live-b2-contract-${{ github.repository }}",
    b2Secrets: ["LIVE_B2_KEY_ID", "LIVE_B2_KEY"],
  },
  {
    path: ".github/workflows/smoke.yml",
    job: "smoke",
    environment: "live-b2-smoke",
    concurrency: "live-b2-smoke-${{ github.repository }}",
    b2Secrets: ["LIVE_B2_KEY_ID", "LIVE_B2_KEY", "LIVE_B2_APP_KEY_ID", "LIVE_B2_APP_KEY"],
  },
];

const workflowText = (path: string) => readFileSync(join(root, path), "utf8");

function expectYamlList(text: string, key: string, expected: string[]) {
  const lists = yamlValuesForKey(text, key).filter(Array.isArray);
  expect(lists.some((list) => list.join("\0") === expected.join("\0"))).toBe(true);
}

function expectYamlScalar(text: string, key: string, expected: string) {
  const scalars = yamlValuesForKey(text, key).filter(
    (value): value is string => !Array.isArray(value),
  );
  expect(scalars).toContain(expected);
}

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
    "$path wires the protected environment, protected refs, and serialized Node matrix",
    ({ path, job, environment }) => {
      const text = workflowText(path);
      expect(text).toMatch(topLevelMappingEntry("permissions", "contents", "read"));
      expect(text).toMatch(jobField(job, "environment", environment));
      expectYamlList(text, "node-version", runtimePolicy.liveNodeMatrix);
      expectYamlScalar(text, "max-parallel", "1");
      expect(text).toMatch(/^\s{2}guard:\s*$/m);
      expect(text).toMatch(/if: github\.repository == 'backblaze-labs\/b2-mcp'/);
      expect(text).toContain('[[ "$GITHUB_REF" != "refs/heads/main" ]]');
      expect(text).toContain('[[ "$GITHUB_REF" != refs/tags/v* ]]');
      expect(text).toContain('protected_ref="refs/heads/ci-green"');
      expect(text).toContain('tag_sha="$(git ls-remote origin "${GITHUB_REF}^{}"');
      expect(text).toContain('"$tag_sha" != "$ci_green_sha"');
      expect(text).toContain("node-version: ${{ matrix.node-version }}");
      expect(text).not.toContain("node-version-file:");
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

  it("runs the explicit live contract layer with B2 credentials", () => {
    const text = workflowText(".github/workflows/contract.yml");
    const contractJob = text.slice(text.indexOf("  contract:"));

    expect(contractJob).toContain("npm run test:contract:live");
    expect(contractJob).not.toContain("npm run test:contract\n");
    expect(contractJob).toContain("B2_APPLICATION_KEY_ID: ${{ secrets.LIVE_B2_KEY_ID }}");
    expect(contractJob).toContain("B2_APPLICATION_KEY: ${{ secrets.LIVE_B2_KEY }}");
  });

  it.each(liveWorkflows)(
    "$path uses only required environment-scoped B2 secrets",
    ({ path, b2Secrets }) => {
      const text = workflowText(path);
      const secretRefs = [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
      expect(secretRefs.filter((name) => name.includes("B2"))).not.toEqual([]);
      expect([...new Set(secretRefs.filter((name) => name.includes("B2")))].sort()).toEqual(
        b2Secrets.slice().sort(),
      );
      expect(secretRefs.filter((name) => /^B2_/.test(name))).toEqual([]);
    },
  );
});
