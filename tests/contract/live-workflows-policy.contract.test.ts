import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
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
    b2Secrets: ["LIVE_B2_KEY_ID", "LIVE_B2_KEY", "LIVE_B2_MASTER_KEY_ID", "LIVE_B2_MASTER_KEY"],
  },
  {
    path: ".github/workflows/smoke.yml",
    job: "smoke",
    environment: "live-b2-smoke",
    concurrency:
      "live-b2-smoke-${{ github.repository }}-${{ github.event.deployment.environment || github.ref_name || github.run_id }}",
    cancelsInProgress: false,
    b2Secrets: ["LIVE_B2_KEY_ID", "LIVE_B2_KEY"],
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
  "scripts/live-b2-janitor.mjs",
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
  b2_get_bucket_notification_rules: ["writeBucketNotifications"],
  b2_list_largest_files: ["listFiles"],
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
  s3_get_presigned_upload_part_url: ["writeFiles"],
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
    "$path wires the trusted triggers and serialized Node matrix",
    ({ path, job, environment }) => {
      const text = workflowText(path);
      expect(text).toMatch(topLevelMappingEntry("permissions", "contents", "read"));
      if (environment) {
        expect(text).toMatch(jobField(job, "environment", environment));
      } else {
        expect(workflowJobBlock(text, job) ?? "").not.toContain("environment:");
      }
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
      if (path.endsWith("contract.yml")) {
        expect(text).toContain(
          "ref: ${{ github.event_name == 'workflow_call' && 'ci-green' || 'main' }}",
        );
        expect(text).toContain("fetch-depth: 0");
        expect(text).toContain("Check out trusted live-test commit");
        expect(text).toContain("EXPECTED_CHECKOUT_SHA: ${{ needs.guard.outputs.checkout-sha }}");
        expect(text).toContain('git checkout --detach "${EXPECTED_CHECKOUT_SHA}"');
        expect(text).toContain('actual_sha="$(git rev-parse HEAD)"');
        expect(text).toContain(
          "live B2 checkout resolved ${actual_sha}, expected ${EXPECTED_CHECKOUT_SHA}",
        );
        expect(text).not.toContain("ref: ${{ needs.guard.outputs.checkout-sha }}");
      } else {
        expect(text).toContain("ref: ${{ needs.guard.outputs.checkout-sha }}");
      }
      expect(text).not.toContain('checkout_ref="ci-green"');
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
    expect(workflowCall).toContain("secrets:");
    expect(workflowCall).toContain("LIVE_B2_KEY_ID:");
    expect(workflowCall).toContain("LIVE_B2_KEY:");
    expect(workflowCall).not.toContain("secrets: inherit");
    expect(text).toContain("WORKFLOW_CALL_CHECKOUT_SHA");
    expect(text).toContain('event_kind="workflow_call"');
    expect(text).toContain("workflow_call requires a full checkout-sha commit");
    expect(text).toContain("refs/heads/ci-green");
    expect(text).toContain("git merge-base --is-ancestor");
    expect(text).toContain("workflow_call checkout-sha must be reachable from refs/heads/ci-green");
    expect(text).toContain('checkout_sha="${WORKFLOW_CALL_CHECKOUT_SHA}"');
  });

  it("fails the live run when per-run cleanup leaks resources", () => {
    const text = workflowText(".github/workflows/contract.yml");
    const contractJob = workflowJobBlock(text, "contract") ?? "";
    const janitor = workflowText("scripts/live-b2-janitor.mjs");
    expect(text).not.toContain("abandoned-resource-janitor:");
    expect(text).not.toContain("node scripts/live-b2-janitor.mjs --prefix mcp-contract-");
    expect(text).toContain("Clean current live B2 run resources");
    expect(text).toContain("B2_LIVE_TEST_ACCOUNT_ID: ${{ vars.B2_LIVE_TEST_ACCOUNT_ID }}");
    expect(contractJob).toContain("node scripts/live-b2-janitor.mjs");
    expect(contractJob).toContain('--prefix "${B2_MCP_LIVE_RUN_PREFIX}"');
    expect(contractJob).toContain("--summary-json");
    expect(contractJob).not.toContain("--best-effort");
    expect(contractJob).toContain("Require live B2 run success");
    expect(contractJob).toContain("live B2 cleanup outcome was");
    expect(janitor).not.toMatch(/\.(?:listKeys|deleteKey)\s*\(/);
    expect(janitor).not.toContain("keys=");
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

    expect(contractJob).toContain("needs: [guard, preflight]");
    expect(contractJob).not.toContain("package-budget");
  });

  it("keeps live contract cleanup context visible in logs", () => {
    const text = workflowText(".github/workflows/contract.yml");
    expect(text).toContain("live-b2-janitor");
    expect(text).toContain("mcp-contract-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}");
    expect(text).toContain("live-b2-isolation-cleanup-node-${{ matrix.node-version }}");
  });

  it("verifies the live test account before creating fixture buckets", () => {
    const text = workflowText("tests/live/support/contract-buckets.ts");
    expect(text).toContain("B2_LIVE_TEST_ACCOUNT_ID");
    expect(text).toContain("Live contract account allowlist mismatch");
    expect(text.indexOf("await assertLiveTestAccount(server)")).toBeLessThan(
      text.indexOf('callTool(server, "b2_create_bucket"'),
    );
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
    expect(contractJob).toContain("B2_MCP_LIVE_RESOURCE_LEDGER");
    expect(contractJob).toContain("Publish live B2 isolation and cleanup evidence");
    expect(contractJob).not.toContain(
      "B2_APPLICATION_KEY B2_LIVE_TEST_ACCOUNT_ID B2_REQUIRE_LIVE_TESTS B2_INTEGRATION_REQUIRE_CREDENTIALS B2_MCP_LIVE_RUN_PREFIX",
    );
  });

  it("validates live B2 configuration and expected profile before the Node matrix starts", () => {
    const workflow = workflowText(".github/workflows/contract.yml");
    const preflightJob = workflowJobBlock(workflow, "preflight") ?? "";
    const contractJob = workflowJobBlock(workflow, "contract") ?? "";
    const matrixValidation = workflowStepBlock(workflow, "Validate live B2 matrix leg");
    const liveTests = workflowStepBlock(workflow, "Run live B2 contract and integration suites");
    const finalizer = workflowStepBlock(workflow, "Publish live B2 isolation and cleanup evidence");
    const preflightFallback = workflowStepBlock(
      workflow,
      "Ensure live B2 preflight evidence exists",
    );
    const finalFallback = workflowStepBlock(workflow, "Ensure live B2 final evidence exists");

    expect(preflightJob).toContain("name: live B2 preflight");
    expect(preflightJob).toContain("needs: guard");
    expect(preflightJob).toContain("environment: live-b2-contract");
    expect(preflightJob).toContain("Validate live B2 configuration before Node matrix");
    expect(preflightJob).toContain(
      "B2_MCP_EXPECTED_TOOL_PROFILE: ${{ vars.B2_MCP_EXPECTED_TOOL_PROFILE }}",
    );
    expect(preflightJob).toContain("node scripts/live-b2-evidence.mjs preflight");
    expect(preflightJob).toContain("B2_REGION: ${{ vars.B2_REGION }}");
    expect(preflightJob).toContain("live-b2-preflight-isolation-cleanup");
    expect(preflightFallback).toContain("preflight did not reach live B2 validation");
    expect(preflightFallback).toContain('status": "configuration blocked');
    expect(preflightJob).toContain("if-no-files-found: error");
    expect(preflightJob).toContain("if: always()");
    expect(contractJob).toContain("needs: [guard, preflight]");
    expect(contractJob).toContain("needs.preflight.result == 'success'");
    expect(matrixValidation).toContain("id: matrix_validation");
    expect(matrixValidation).toContain("continue-on-error: true");
    expect(matrixValidation).toContain(
      "B2_MCP_EXPECTED_TOOL_PROFILE: ${{ vars.B2_MCP_EXPECTED_TOOL_PROFILE }}",
    );
    expect(matrixValidation).toContain("B2_LIVE_NOTIFICATION_BUCKET");
    expect(matrixValidation).toContain("node scripts/live-b2-evidence.mjs preflight");
    expect(matrixValidation).toContain(
      "reports/live-b2/validation-node-${{ matrix.node-version }}.json",
    );
    expect(liveTests).toContain("if: steps.matrix_validation.outcome == 'success'");
    expect(liveTests).toContain(
      "B2_MCP_EXPECTED_TOOL_PROFILE: ${{ vars.B2_MCP_EXPECTED_TOOL_PROFILE }}",
    );
    expect(finalizer).toContain("--validation-summary");
    expect(finalizer).toContain("B2_APPLICATION_KEY_ID: ${{ secrets.LIVE_B2_KEY_ID }}");
    expect(finalizer).toContain("B2_APPLICATION_KEY: ${{ secrets.LIVE_B2_KEY }}");
    expect(finalizer).toContain("B2_LIVE_TEST_ACCOUNT_ID: ${{ vars.B2_LIVE_TEST_ACCOUNT_ID }}");
    expect(finalizer).toContain("B2_MASTER_KEY_ID: ${{ secrets.LIVE_B2_MASTER_KEY_ID }}");
    expect(finalizer).toContain("B2_MASTER_KEY: ${{ secrets.LIVE_B2_MASTER_KEY }}");
    expect(finalizer).toContain(
      "B2_LIVE_NOTIFICATION_BUCKET: ${{ vars.B2_LIVE_NOTIFICATION_BUCKET }}",
    );
    expect(finalizer).toContain("reports/live-b2/validation-node-${{ matrix.node-version }}.json");
    expect(finalizer).toContain('--preflight-outcome "${{ steps.matrix_validation.outcome }}"');
    expect(finalFallback).toContain("live B2 final evidence fallback");
    expect(finalFallback).toContain("configuration blocked");
    expect(finalFallback).toContain("cleanup failure");
    expect(finalFallback).toContain("product failure");
    expect(contractJob).toContain("live B2 matrix validation outcome was");
    expect(contractJob).toContain("evidence_status=");
    expect(contractJob).toContain("JSON.parse(fs.readFileSync");
    expect(contractJob).toContain("live B2 evidence status was");
  });

  it("uploads only finalized secret-safe live B2 evidence artifacts", () => {
    const workflow = workflowText(".github/workflows/contract.yml");
    const upload = workflowStepBlock(workflow, "Upload live B2 isolation and cleanup evidence");

    expect(upload).toContain(
      "path: reports/live-b2/isolation-cleanup-node-${{ matrix.node-version }}.json",
    );
    expect(upload).toContain("if-no-files-found: error");
    expect(upload).not.toContain("reports/live-b2/**");
    expect(upload).not.toContain("path: reports/live-b2/resources-node-");
    expect(upload).not.toContain("path: reports/live-b2/cleanup-node-");
  });

  it("pins the expected tool profile and required test bucket for live smoke", () => {
    const text = workflowText(".github/workflows/smoke.yml");
    const smokeJob = text.slice(text.indexOf("  smoke:"));

    expect(smokeJob).toContain(
      "B2_MCP_EXPECTED_TOOL_PROFILE: ${{ vars.B2_MCP_EXPECTED_TOOL_PROFILE }}",
    );
    expect(smokeJob).not.toContain("B2_REQUIRE_LIVE_TESTS");
    expect(smokeJob).toContain(
      "MCP_URL B2_KEY_ID B2_KEY B2_SMOKE_BUCKET B2_MCP_EXPECTED_TOOL_PROFILE B2_MCP_REQUIRE_SMOKE_BUCKET",
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
