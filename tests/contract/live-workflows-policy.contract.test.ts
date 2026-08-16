import { readFileSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import { root } from "./support";

const nodeRequire = createRequire(__filename);
const { workflowJobBlock, yamlBlockForKey, yamlValuesForKey } = nodeRequire(
  "../../scripts/lib/workflow-yaml.cjs",
) as {
  yamlBlockForKey: (text: string, key: string) => string | null;
  workflowJobBlock: (text: string, jobName: string) => string | null;
  yamlValuesForKey: (text: string, key: string) => Array<string | string[]>;
};
const { LIVE_B2_CONTRACT_FORBIDDEN_CAPABILITIES, LIVE_B2_CONTRACT_REQUIRED_CAPABILITIES } =
  nodeRequire("../../scripts/lib/live-b2-capabilities.cjs") as {
    LIVE_B2_CONTRACT_FORBIDDEN_CAPABILITIES: readonly string[];
    LIVE_B2_CONTRACT_REQUIRED_CAPABILITIES: readonly string[];
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
    cancelsInProgress: false,
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

function workflowStepBlock(text: string, stepName: string): string {
  const marker = `- name: ${stepName}`;
  const start = text.indexOf(marker);
  if (start === -1) return "";
  const next = text.indexOf("\n      - name:", start + marker.length);
  return text.slice(start, next === -1 ? undefined : next);
}

const liveSuiteSources = [
  "tests/live/b2.integration.live.test.ts",
  "tests/live/request-shape.contract.live.test.ts",
  "tests/live/support/contract-buckets.ts",
  "scripts/lib/live-b2-contract.cjs",
];

const liveToolCapabilities: Record<string, readonly string[]> = {
  b2_authorize_account: [],
  b2_create_bucket: [
    "readBucketEncryption",
    "readBucketRetentions",
    "writeBucketEncryption",
    "writeBucketRetentions",
    "writeBuckets",
  ],
  b2_delete_bucket: ["deleteBuckets", "readBucketEncryption", "readBucketRetentions"],
  b2_largest_files: ["listFiles"],
  b2_list_buckets: ["listBuckets", "readBucketEncryption", "readBucketRetentions"],
  b2_list_group_members: [],
  b2_list_groups: [],
  b2_list_keys: ["listKeys"],
  b2_set_bucket_notification_rules: ["writeBucketNotifications"],
  b2_unfinished_uploads: ["listFiles"],
  b2_update_bucket: [
    "readBucketEncryption",
    "readBucketRetentions",
    "writeBucketEncryption",
    "writeBucketRetentions",
    "writeBuckets",
  ],
  b2_update_file_legal_hold: ["writeFileLegalHolds"],
  b2_update_file_retention: ["bypassGovernance", "writeFileRetentions"],
  s3_abort_multipart_upload: ["writeFiles"],
  s3_copy_object: ["readFiles", "writeFiles"],
  s3_create_multipart_upload: ["readFileLegalHolds", "readFileRetentions", "writeFiles"],
  s3_delete_object: ["deleteFiles"],
  s3_delete_objects: ["bypassGovernance", "deleteFiles"],
  s3_get_bucket_location: ["readBuckets"],
  s3_get_object: ["readFiles"],
  s3_get_presigned_url: ["readFiles", "writeFiles"],
  s3_head_bucket: ["listBuckets"],
  s3_head_object: ["readFileLegalHolds", "readFileRetentions", "readFiles"],
  s3_list_multipart_uploads: ["listFiles"],
  s3_list_object_versions: ["listFiles", "readFileLegalHolds", "readFileRetentions"],
  s3_list_objects_v2: ["listFiles"],
  s3_presign_upload_part: ["writeFiles"],
  s3_put_object: ["readFileLegalHolds", "readFileRetentions", "writeFiles"],
};

function liveSuiteToolNames(): string[] {
  const names = new Set<string>();
  for (const sourcePath of liveSuiteSources) {
    const text = workflowText(sourcePath);
    for (const match of text.matchAll(/["']((?:b2|s3)_[a-z0-9_]+)["']/g)) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function documentedContractCapabilities(): string[] {
  const testingDoc = workflowText("docs/TESTING.md");
  const match =
    /use the\s+`live-b2-contract` GitHub Environment:[\s\S]*?Capabilities:\s*([\s\S]*?)\. Do not grant/.exec(
      testingDoc,
    );
  if (!match)
    throw new Error("Could not locate live-b2-contract capability list in docs/TESTING.md");
  return sortedUnique([...match[1].matchAll(/`([^`]+)`/g)].map((capability) => capability[1]));
}

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
        expect(text).not.toMatch(/^\s{2}push:\s*$/m);
        expect(text).toMatch(/^\s{2}workflow_call:\s*$/m);
        expect(text).toContain('[[ "$GITHUB_REF" != "refs/heads/main" ]]');
      } else {
        expect(text).toMatch(/^\s{2}deployment_status:\s*$/m);
        expect(text).not.toMatch(/^\s{2}push:\s*$/m);
        expect(text).toContain("DEPLOYMENT_ENVIRONMENT: ${{ github.event.deployment.environment");
        expect(text).toContain("DEPLOYMENT_STATE: ${{ github.event.deployment_status.state");
        expect(text).toContain("DEPLOYMENT_SHA: ${{ github.event.deployment.sha");
        expect(text).toContain(
          "# Repository or organization variable; this guard intentionally does",
        );
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
    const workflowCall = yamlBlockForKey(text, "workflow_call") ?? "";
    expect(text).toMatch(/^\s{2}workflow_call:\s*$/m);
    expect(workflowCall).not.toBe("");
    expect(text).toContain("checkout-sha:");
    expect(workflowCall).toContain("checkout-sha:");
    expect(workflowCall).not.toContain("secrets:");
    expect(workflowCall).not.toContain("LIVE_B2_KEY_ID");
    expect(workflowCall).not.toContain("LIVE_B2_KEY");
    expect(text).toContain("WORKFLOW_CALL_CHECKOUT_SHA");
    expect(text).toContain('event_kind="workflow_call"');
    expect(text).toContain("workflow_call requires a full checkout-sha commit");
    expect(text).toContain("refs/heads/ci-green");
    expect(text).toContain("git merge-base --is-ancestor");
    expect(text).toContain("workflow_call checkout-sha must be reachable from refs/heads/ci-green");
  });

  it("fails the live run when per-run cleanup leaks resources", () => {
    const text = workflowText(".github/workflows/contract.yml");
    const contractJob = workflowJobBlock(text, "contract") ?? "";
    expect(text).not.toContain("abandoned-resource-janitor:");
    expect(text).not.toContain("node scripts/live-b2-janitor.mjs --prefix mcp-contract-");
    expect(text).toContain("Clean current live B2 run resources");
    expect(text).toContain("B2_LIVE_TEST_ACCOUNT_ID: ${{ vars.B2_LIVE_TEST_ACCOUNT_ID }}");
    expect(contractJob).toContain(
      'node scripts/live-b2-janitor.mjs --prefix "${B2_MCP_LIVE_RUN_PREFIX}"',
    );
    expect(contractJob).not.toContain("--best-effort");
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
    const workflow = workflowText(".github/workflows/contract.yml");
    expect(workflow).toContain("authorized account does not match B2_LIVE_TEST_ACCOUNT_ID");
    expect(workflow).toContain("scripts/lib/live-b2-capabilities.cjs");
    expect(workflow).toContain("LIVE_B2_CONTRACT_FORBIDDEN_CAPABILITIES");
    expect(workflow).toContain("LIVE_B2_CONTRACT_REQUIRED_CAPABILITIES");
    expect(workflow).toContain("live B2 contract key grants forbidden capability");
    const liveTests = [
      workflowText("tests/live/b2.integration.live.test.ts"),
      workflowText("tests/live/request-shape.contract.live.test.ts"),
    ].join("\n");
    expect(liveTests).toContain('mode: "governance"');
    expect(liveTests).not.toContain('mode: "compliance"');
  });

  it("keeps the live contract capability policy aligned with exercised live tools", () => {
    const missingMappings = liveSuiteToolNames().filter((name) => !(name in liveToolCapabilities));
    expect(missingMappings).toEqual([]);

    const exercisedCapabilities = sortedUnique(
      liveSuiteToolNames().flatMap((name) => liveToolCapabilities[name]),
    );
    expect(sortedUnique(LIVE_B2_CONTRACT_REQUIRED_CAPABILITIES)).toEqual(exercisedCapabilities);
    for (const forbidden of LIVE_B2_CONTRACT_FORBIDDEN_CAPABILITIES) {
      expect(LIVE_B2_CONTRACT_REQUIRED_CAPABILITIES).not.toContain(forbidden);
    }
  });

  it("documents the same live contract capability list used by workflow preflight", () => {
    expect(documentedContractCapabilities()).toEqual(
      sortedUnique(LIVE_B2_CONTRACT_REQUIRED_CAPABILITIES),
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
    expect(contractJob).toContain('B2_REQUIRE_LIVE_TESTS: "1"');
    expect(contractJob).toContain('B2_INTEGRATION_REQUIRE_CREDENTIALS: "1"');
  });

  it("pins the expected tool profile and required test bucket for live smoke", () => {
    const text = workflowText(".github/workflows/smoke.yml");
    const smokeJob = text.slice(text.indexOf("  smoke:"));

    expect(smokeJob).toContain(
      "B2_MCP_EXPECTED_TOOL_PROFILE: ${{ vars.B2_MCP_EXPECTED_TOOL_PROFILE }}",
    );
    expect(smokeJob).not.toContain("B2_REQUIRE_LIVE_TESTS");
    expect(smokeJob).toContain(
      "MCP_URL B2_KEY_ID B2_KEY B2_APP_KEY_ID B2_APP_KEY B2_SMOKE_BUCKET B2_MCP_EXPECTED_TOOL_PROFILE B2_MCP_REQUIRE_SMOKE_BUCKET",
    );
    expect(smokeJob).toContain(
      "MCP_URL MCP_AUTHORIZATION B2_SMOKE_BUCKET B2_MCP_EXPECTED_TOOL_PROFILE B2_MCP_REQUIRE_SMOKE_BUCKET",
    );
    expect(smokeJob).toContain("B2_MCP_SMOKE_CREDENTIAL_MODE");
    expect(smokeJob).toContain("VERCEL_PROTECTION_BYPASS");
    expect(smokeJob).toContain("x-vercel-protection-bypass");
    expect(smokeJob).toContain("Run live B2 smoke (headers)");
    expect(smokeJob).toContain("Run live B2 smoke (server/principal)");
    expect(smokeJob).toContain("B2_SMOKE_BUCKET: ${{ vars.B2_SMOKE_BUCKET }}");
    expect(smokeJob).toContain('B2_MCP_REQUIRE_SMOKE_BUCKET: "1"');
  });

  it("does not inject raw live B2 secrets into server/principal smoke steps", () => {
    const text = workflowText(".github/workflows/smoke.yml");
    const serverValidate = workflowStepBlock(
      text,
      "Validate live B2 smoke environment (server/principal)",
    );
    const serverRun = workflowStepBlock(text, "Run live B2 smoke (server/principal)");

    for (const block of [serverValidate, serverRun]) {
      expect(block).not.toContain("LIVE_B2_");
      expect(block).not.toContain("B2_KEY_ID");
      expect(block).not.toContain("B2_KEY:");
      expect(block).not.toContain("B2_APP_KEY");
      expect(block).toContain("MCP_AUTHORIZATION");
    }
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
