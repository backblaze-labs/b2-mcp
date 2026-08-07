import { readFileSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import { root } from "./support";

const nodeRequire = createRequire(__filename);
const { workflowJobBlock, yamlValuesForKey } = nodeRequire(
  "../../scripts/lib/workflow-yaml.cjs",
) as {
  workflowJobBlock: (text: string, jobName: string) => string | null;
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
    concurrency: "live-b2-contract-${{ github.repository }}-resources",
    cancelsInProgress: false,
    b2Secrets: ["LIVE_B2_KEY_ID", "LIVE_B2_KEY"],
  },
  {
    path: ".github/workflows/smoke.yml",
    job: "smoke",
    environment: "live-b2-smoke",
    concurrency:
      "live-b2-smoke-${{ github.repository }}-${{ github.event.deployment.environment || github.ref_name || github.run_id }}",
    cancelsInProgress: true,
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
    "$path wires the protected environment, trusted triggers, and serialized Node matrix",
    ({ path, job, environment }) => {
      const text = workflowText(path);
      expect(text).toMatch(topLevelMappingEntry("permissions", "contents", "read"));
      expect(text).toMatch(jobField(job, "environment", environment));
      expectYamlList(text, "node-version", runtimePolicy.liveNodeMatrix);
      expectYamlScalar(text, "max-parallel", "1");
      expect(text).toMatch(/^\s{2}guard:\s*$/m);
      expect(text).toMatch(/if: github\.repository == 'backblaze-labs\/b2-mcp'/);
      expect(text).toMatch(/^\s{2}schedule:\s*$/m);
      if (path.endsWith("contract.yml")) {
        expect(text).toMatch(/^\s{2}push:\s*$/m);
        expect(text).toContain('[[ "$GITHUB_REF" != "refs/heads/main" ]]');
      } else {
        expect(text).toMatch(/^\s{2}deployment_status:\s*$/m);
        expect(text).not.toMatch(/^\s{2}push:\s*$/m);
        expect(text).toContain("DEPLOYMENT_ENVIRONMENT: ${{ github.event.deployment.environment");
        expect(text).toContain("DEPLOYMENT_STATE: ${{ github.event.deployment_status.state");
        expect(text).toContain("DEPLOYMENT_SHA: ${{ github.event.deployment.sha");
        expect(text).toContain(
          "EXPECTED_DEPLOYMENT_ENVIRONMENT: ${{ vars.B2_MCP_SMOKE_DEPLOYMENT_ENVIRONMENT || 'production' }}",
        );
        expect(text).toContain(
          '[[ "${DEPLOYMENT_ENVIRONMENT}" != "${EXPECTED_DEPLOYMENT_ENVIRONMENT}" ]]',
        );
        expect(text).toContain("refs/heads/main");
        expect(text).toContain("refs/heads/ci-green");
        expect(text).toContain("git merge-base --is-ancestor");
        expect(text).toContain(
          "deployment_status SHA must be reachable from protected main or ci-green",
        );
        expect(text).toContain('checkout_sha="${DEPLOYMENT_SHA}"');
      }
      expect(text).not.toMatch(/^\s{2}pull_request:\s*$/m);
      expect(text).not.toContain("PR_HEAD_SHA");
      expect(text).not.toContain("github.event.pull_request.head.sha");
      expect(text).not.toContain("Skipping fork pull request");
      expect(text).toContain("checkout-sha: ${{ steps.ref.outputs.checkout_sha }}");
      expect(text).toContain('echo "should_run=${should_run}" >> "$GITHUB_OUTPUT"');
      expect(text).toContain("node-version: ${{ matrix.node-version }}");
      expect(text).not.toContain("node-version-file:");
      expect(text).not.toContain("release:");
    },
  );

  it.each(liveWorkflows)(
    "$path uses the expected live-workflow concurrency policy",
    ({ path, concurrency, cancelsInProgress }) => {
      const text = workflowText(path);
      expect(text).toMatch(topLevelMappingEntry("concurrency", "group", concurrency));
      expect(text).toContain(`cancel-in-progress: ${cancelsInProgress}`);
    },
  );

  it.each(liveWorkflows)(
    "$path checks out the guarded commit before running package code",
    ({ path }) => {
      const text = workflowText(path);
      expect(text).toContain("ref: ${{ needs.guard.outputs.checkout-sha }}");
      expect(text).not.toContain('checkout_ref="ci-green"');
      expect(text).not.toContain("ref: ci-green");
      expect(text).not.toContain("github.event_name == 'release'");
      expect(text).not.toContain("startsWith(github.ref, 'refs/tags/v')");
    },
  );

  it("runs live contracts through workflow_call for release gating", () => {
    const text = workflowText(".github/workflows/contract.yml");
    expect(text).toMatch(/^\s{2}workflow_call:\s*$/m);
    expect(text).toContain("checkout-sha:");
    expect(text).toContain("LIVE_B2_KEY_ID:");
    expect(text).toContain("LIVE_B2_KEY:");
    expect(text).toContain("WORKFLOW_CALL_CHECKOUT_SHA");
    expect(text).toContain('event_kind="workflow_call"');
    expect(text).toContain("workflow_call requires a full checkout-sha commit");
    expect(text).toContain("refs/heads/ci-green");
    expect(text).toContain("git merge-base --is-ancestor");
    expect(text).toContain("workflow_call checkout-sha must be reachable from refs/heads/ci-green");
  });

  it("adds a scheduled janitor for abandoned test-prefixed resources", () => {
    const text = workflowText(".github/workflows/contract.yml");
    const contractJob = workflowJobBlock(text, "contract") ?? "";
    const janitorJob = workflowJobBlock(text, "abandoned-resource-janitor") ?? "";
    expect(text).toContain("abandoned-resource-janitor:");
    expect(text).toContain("github.event_name == 'schedule'");
    expect(text).toContain("node scripts/live-b2-janitor.mjs --prefix mcp-contract-");
    expect(text).toContain("Clean current live B2 run resources");
    expect(text).toContain("B2_LIVE_TEST_ACCOUNT_ID: ${{ vars.B2_LIVE_TEST_ACCOUNT_ID }}");
    expect(text).toContain("--best-effort");
    expect(text).toContain("B2_MCP_LIVE_RUN_PREFIX");
    expect(text).toContain('cron: "17 9 * * *"');
    expect(text).toMatch(
      topLevelMappingEntry(
        "concurrency",
        "group",
        "live-b2-contract-${{ github.repository }}-resources",
      ),
    );
    expect(contractJob).not.toContain("concurrency:");
    expect(janitorJob).not.toContain("concurrency:");
  });

  it("keeps package-budget off the live contract dependency chain", () => {
    const text = workflowText(".github/workflows/contract.yml");
    const contractJob = workflowJobBlock(text, "contract") ?? "";

    expect(contractJob).toContain("needs: guard");
    expect(contractJob).not.toContain("package-budget");
  });

  it("keeps live contract cleanup context visible in logs", () => {
    const text = workflowText(".github/workflows/contract.yml");
    expect(text).toContain("live-b2-janitor");
    expect(text).toContain("mcp-contract-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}");
  });

  it("verifies the live test account before creating fixture buckets", () => {
    const text = workflowText("tests/live/support/contract-buckets.ts");
    expect(text).toContain("B2_LIVE_TEST_ACCOUNT_ID");
    expect(text).toContain("Live contract account allowlist mismatch");
    expect(text.indexOf("await assertLiveTestAccount(server)")).toBeLessThan(
      text.indexOf('callTool(server, "b2_create_bucket"'),
    );
  });

  it("runs the explicit live contract layer with B2 credentials", () => {
    const text = workflowText(".github/workflows/contract.yml");
    const contractJob = text.slice(text.indexOf("  contract:"));

    expect(contractJob).toContain("pnpm run test:live:b2");
    expect(contractJob).toContain("timeout-minutes: 12");
    expect(contractJob).not.toContain("pnpm run test:contract\n");
    expect(contractJob).toContain("B2_APPLICATION_KEY_ID: ${{ secrets.LIVE_B2_KEY_ID }}");
    expect(contractJob).toContain("B2_APPLICATION_KEY: ${{ secrets.LIVE_B2_KEY }}");
    expect(contractJob).toContain('B2_INTEGRATION_REQUIRE_CREDENTIALS: "1"');
  });

  it("pins the expected tool profile and required test bucket for live smoke", () => {
    const text = workflowText(".github/workflows/smoke.yml");
    const smokeJob = text.slice(text.indexOf("  smoke:"));

    expect(smokeJob).toContain(
      "B2_MCP_EXPECTED_TOOL_PROFILE: ${{ vars.B2_MCP_EXPECTED_TOOL_PROFILE }}",
    );
    expect(smokeJob).toContain(
      "MCP_URL B2_KEY_ID B2_KEY B2_APP_KEY_ID B2_APP_KEY B2_SMOKE_BUCKET B2_MCP_EXPECTED_TOOL_PROFILE B2_MCP_REQUIRE_SMOKE_BUCKET",
    );
    expect(smokeJob).toContain("B2_SMOKE_BUCKET: ${{ vars.B2_SMOKE_BUCKET }}");
    expect(smokeJob).toContain('B2_MCP_REQUIRE_SMOKE_BUCKET: "1"');
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
