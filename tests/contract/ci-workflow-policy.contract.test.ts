import { readFileSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import { root } from "./support";

const nodeRequire = createRequire(__filename);
const {
  workflowJobBlock,
  workflowJobBlocks,
  yamlBlockForKey,
  yamlMappingForKey,
  yamlValuesForKey,
} = nodeRequire("../../scripts/lib/workflow-yaml.cjs") as {
  workflowJobBlock: (text: string, jobName: string) => string | null;
  workflowJobBlocks: (text: string) => Array<{ name: string; block: string }>;
  yamlBlockForKey: (text: string, key: string) => string | null;
  yamlMappingForKey: (text: string, key: string) => Record<string, string | string[]> | null;
  yamlValuesForKey: (text: string, key: string) => Array<string | string[]>;
};

const pnpmSetupAction = "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86";
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  packageManager?: string;
  scripts?: Record<string, string>;
};
const prTemplate = readFileSync(join(root, ".github/PULL_REQUEST_TEMPLATE.md"), "utf8");
const branchProtection = JSON.parse(
  readFileSync(join(root, ".github/branch-protection-main.json"), "utf8"),
) as {
  required_status_checks?: { strict?: boolean; contexts?: string[] };
  required_pull_request_reviews?: {
    dismiss_stale_reviews?: boolean;
    require_code_owner_reviews?: boolean;
    required_approving_review_count?: number;
  };
  allow_force_pushes?: boolean;
};
const workflowPaths = [
  ".github/workflows/test.yml",
  ".github/workflows/contract.yml",
  ".github/workflows/smoke.yml",
  ".github/workflows/publish.yml",
];
const requiredJobNames = [
  "format/lint/typecheck",
  "docs/spelling/links",
  "unit/coverage",
  "MCP contract",
  "modern and legacy protocol/transport",
  "package install smoke",
  "runtime engine floor",
  "production dependency audit",
  "package budget",
  "Vercel build output scan",
  "container image",
  "supply-chain audit",
  "CodeQL/workflow security",
  "slow/lifecycle",
  "cross-platform minimum",
];

describe("CI workflow policy", () => {
  const ci = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");
  const publish = readFileSync(join(root, ".github/workflows/publish.yml"), "utf8");
  const qualityKeeper = readFileSync(join(root, ".github/workflows/quality-keeper.yml"), "utf8");

  function workflowJob(name: string): string {
    const job = workflowJobBlock(ci, name);
    if (!job) throw new Error(`Workflow job not found: ${name}`);
    return job;
  }

  it("defaults workflow permissions to read-only contents and cancels superseded PRs", () => {
    const permissions = yamlMappingForKey(ci, "permissions");
    expect(permissions).toMatchObject({ contents: "read" });
    expect(permissions).not.toHaveProperty("actions");
    expect(ci).toContain(
      "group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
    );
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  it("keeps package publishing on trusted release tag pushes", () => {
    const trigger = yamlBlockForKey(publish, "on") ?? "";
    const publishTagAssignments = publish.match(/^\s+PUBLISH_TAG:\s*(.+)$/gm) ?? [];

    expect(trigger).toContain("push:");
    expect(trigger).toContain("tags:");
    expect(trigger).toContain('"v*.*.*"');
    expect(trigger).toContain('"v*.*.*-*"');
    expect(trigger).not.toContain("workflow_dispatch:");
    expect(publish).not.toContain("inputs.tag");
    expect(publishTagAssignments.length).toBeGreaterThan(0);
    expect(publishTagAssignments).toEqual(
      publishTagAssignments.map((line) =>
        line.replace(/PUBLISH_TAG:\s*.+$/, "PUBLISH_TAG: ${{ github.ref_name }}"),
      ),
    );
    expect(publish).toContain("node scripts/resolve-publish-ref.mjs");
    expect(publish).toContain("node scripts/verify-release-input.mjs --tag");
  });

  it("keeps Quality Keeper pull_request execution unprivileged", () => {
    const qualityKeeperJob = workflowJobBlock(qualityKeeper, "quality-keeper");
    expect(qualityKeeper).toContain("pull_request:");
    expect(qualityKeeper).toContain(
      "A future trusted workflow_run reporter must consume inert artifacts",
    );
    expect(qualityKeeperJob).toBeTruthy();
    expect(qualityKeeperJob).toContain("runs-on: ubuntu-latest");
    expect(qualityKeeperJob).not.toContain("backblaze-labs/quality-keeper/");
    expect(qualityKeeperJob).not.toContain("actions/checkout");
    expect(qualityKeeperJob).not.toContain("github.event.pull_request.head.sha");
    expect(qualityKeeperJob).not.toContain("QK_APP_PRIVATE_KEY");
    expect(qualityKeeperJob).not.toContain("secrets:");

    const permissions = yamlMappingForKey(qualityKeeperJob ?? "", "permissions");
    expect(permissions).toMatchObject({ contents: "read" });
    expect(permissions).not.toHaveProperty("pull-requests");
    expect(permissions).not.toHaveProperty("actions");
    expect(permissions).not.toHaveProperty("statuses");
  });

  it("exposes stable required check names", () => {
    for (const name of requiredJobNames) {
      expect(ci).toContain(`name: ${name}`);
    }
  });

  it("documents branch protection with the exact required check names", () => {
    expect(branchProtection.required_status_checks?.strict).toBe(true);
    expect(branchProtection.required_status_checks?.contexts).toEqual(requiredJobNames);
    expect(
      branchProtection.required_pull_request_reviews?.required_approving_review_count,
    ).toBeGreaterThanOrEqual(1);
    expect(branchProtection.required_pull_request_reviews?.dismiss_stale_reviews).toBe(true);
    expect(branchProtection.required_pull_request_reviews?.require_code_owner_reviews).toBe(true);
    expect(branchProtection.allow_force_pushes).toBe(false);
    for (const name of requiredJobNames) {
      expect(prTemplate).toContain(`- [ ] \`${name}\``);
    }
  });

  it("gates the owned ci-green marker on all required Phase 1 evidence jobs", () => {
    const markGreen = workflowJob("mark-green");
    for (const required of [
      "format-lint-typecheck",
      "docs-spelling-links",
      "unit-coverage",
      "mcp-contract",
      "protocol-transport",
      "package-install-smoke",
      "runtime-engine-floor",
      "production-dependency-audit",
      "package-budget",
      "vercel-build-output",
      "container-image",
      "supply-chain-audit",
      "codeql-workflow-security",
      "slow-lifecycle",
      "cross-platform-minimum",
    ]) {
      expect(markGreen).toContain(required);
    }
    expect(markGreen).toContain("github.ref == 'refs/heads/main'");
    expect(markGreen).toContain("github.event_name == 'push'");
    expect(markGreen).toContain("Advanced owned ci-green marker");
  });

  it("requires every ci-green dependency in branch protection", () => {
    const contexts = branchProtection.required_status_checks?.contexts ?? [];
    const markGreen = workflowJob("mark-green");
    const needs = yamlValuesForKey(markGreen, "needs").find(Array.isArray) as string[] | undefined;
    expect(needs).toBeDefined();

    for (const jobId of needs ?? []) {
      const job = workflowJob(jobId);
      const jobName = job.match(/^\s+name:\s*(.+)$/m)?.[1]?.trim();
      expect(jobName, `${jobId} must declare a stable check name`).toBeTruthy();
      expect(contexts, `${jobId} (${jobName}) must be required by branch protection`).toContain(
        jobName,
      );
    }
  });

  it("runs the same local verify entry point in the primary quality job", () => {
    const qualityJob = workflowJob("format-lint-typecheck");
    expect(qualityJob).toContain("node-version: 22.23.1");
    expect(qualityJob).toContain("pnpm run verify");
    expect(packageJson.scripts?.verify).not.toContain("pnpm run test:coverage");
    expect(qualityJob).not.toContain("pnpm run test:coverage");
    expect(qualityJob).toContain("primary-verify-reports");
    expect(qualityJob).not.toContain("coverage/**");
  });

  it("keeps docs, coverage, contract, protocol, package, audit, and slow gates distinct", () => {
    const docsJob = workflowJob("docs-spelling-links");
    const coverageJob = workflowJob("unit-coverage-matrix");
    const coverageAggregateJob = workflowJob("unit-coverage");
    const contractJob = workflowJob("mcp-contract");
    const protocolJob = workflowJob("protocol-transport");
    const packageJob = workflowJob("package-install-smoke");
    const runtimeFloorJob = workflowJob("runtime-engine-floor");
    const auditJob = workflowJob("production-dependency-audit-matrix");
    const auditAggregateJob = workflowJob("production-dependency-audit");
    const budgetJob = workflowJob("package-budget");
    const vercelBuildJob = workflowJob("vercel-build-output");
    const containerJob = workflowJob("container-image");
    const slowJob = workflowJob("slow-lifecycle");
    const crossPlatformMatrixJob = workflowJob("cross-platform-minimum-matrix");
    const crossPlatformAggregateJob = workflowJob("cross-platform-minimum");

    expect(docsJob).toContain("pnpm run lint:docs");
    expect(docsJob).toContain("pnpm run spell");
    expect(docsJob).toContain("pnpm run lint:links");
    expect(coverageJob).toContain("node-version: [22.23.1, 24, 26]");
    expect(coverageJob).toContain("pnpm run test:coverage");
    expect(coverageJob).toContain("coverage/**");
    expect(coverageJob).toContain("retention-days: 7");
    expect(coverageAggregateJob).toContain("name: unit/coverage");
    expect(coverageAggregateJob).toContain("needs: unit-coverage-matrix");
    expect(contractJob).toContain("pnpm run test:contract");
    expect(contractJob).toContain("docs/tool-profile-contract.json");
    expect(protocolJob).toContain("pnpm run test:protocol");
    expect(protocolJob).toContain("protocol-*.json");
    expect(packageJob).toContain("pnpm run test:package");
    expect(packageJob).toContain("npm-pack-manifest.json");
    expect(packageJob).toContain("runtime-floor-pack.json");
    expect(packageJob).toContain("reports/package/floor/*.tgz");
    expect(runtimeFloorJob).toContain("name: runtime engine floor");
    expect(runtimeFloorJob).toContain("needs: package-install-smoke");
    expect(runtimeFloorJob).toContain("node-version: 22.3.0");
    expect(runtimeFloorJob).toContain(
      "actions/download-artifact@018cc2cf5baa6db3ef3c5f8a56943fffe632ef53",
    );
    expect(runtimeFloorJob).toContain("find reports/package-install-smoke -name '*.tgz'");
    expect(runtimeFloorJob).toContain(
      'node scripts/packed-consumer-smoke.mjs --tarball "$tarball"',
    );
    expect(runtimeFloorJob).not.toContain("pnpm install");
    expect(runtimeFloorJob).not.toContain("pnpm/action-setup");
    expect(auditJob).toContain("node-version: [22.23.1, 24, 26]");
    expect(auditJob).toContain("node scripts/production-security-gate.mjs");
    expect(auditAggregateJob).toContain("name: production dependency audit");
    expect(auditAggregateJob).toContain("needs: production-dependency-audit-matrix");
    expect(budgetJob).toContain("pnpm run check:package-budget");
    expect(budgetJob).toContain("reports/package-budget/");
    expect(vercelBuildJob).toContain("name: Vercel build output scan");
    expect(vercelBuildJob).toContain("pnpm run typecheck");
    expect(vercelBuildJob).toContain("pnpm run build");
    expect(vercelBuildJob).toContain("node scripts/print-vercel-build-canaries.mjs");
    expect(vercelBuildJob).toContain("pnpm run prepare:vercel-local-build");
    expect(vercelBuildJob).toContain("pnpm run build:vercel-local");
    expect(vercelBuildJob).not.toContain("pnpm dlx vercel");
    expect(vercelBuildJob).toContain("pnpm run check:vercel-build-output");
    expect(vercelBuildJob).toContain(
      "pnpm run audit:supply-chain:denylist --artifacts-dir .vercel/output",
    );
    expect(vercelBuildJob).toContain('VERCEL_TOKEN: ""');
    expect(vercelBuildJob).toContain("reports/vercel-build-output/");
    expect(vercelBuildJob).not.toContain(".vercel/output/functions/**/.vc-config.json");
    expect(containerJob).toContain("name: container image");
    expect(containerJob).toContain(
      'node scripts/smoke-container-image.mjs --build --image "b2-mcp:${GITHUB_SHA}"',
    );
    expect(slowJob).toContain("timeout-minutes: 20");
    expect(slowJob).toContain("VITEST_MAX_WORKERS: 1");
    expect(slowJob).toContain("pnpm run test:slow -- --maxWorkers=1");
    expect(crossPlatformAggregateJob).toContain("name: cross-platform minimum");
    expect(crossPlatformMatrixJob).toContain("name: cross-platform minimum / ${{ matrix.os }}");
    expect(crossPlatformAggregateJob).toContain("needs: cross-platform-minimum-matrix");
  });

  it("publishes a compact conformance summary with protocol and budget evidence", () => {
    const summaryJob = workflowJob("conformance-summary");
    expect(summaryJob).toContain("Modern MCP protocol | 2026-07-28");
    expect(summaryJob).toContain(
      "Legacy MCP fallback | 2025-era stateless initialize compatibility",
    );
    expect(summaryJob).toContain("Linux deterministic Node matrix | 22.23.1, 24, 26");
    expect(summaryJob).toContain("Runtime engine floor | Node.js 22.3.0 package install smoke");
    expect(summaryJob).toContain("Package budget metrics | Uploaded as package-budget artifact");
    expect(summaryJob).toContain("Vercel adapter budget | Uploaded as vercel-bundle artifact path");
    expect(summaryJob).toContain("Vercel build output | Real Vercel build plus leak scan");
    expect(summaryJob).toContain("Container image | Docker build plus HTTP health/readiness smoke");
  });

  it("does not persist checkout credentials in pull-request jobs that run repo code", () => {
    for (const { name, block } of workflowJobBlocks(ci)) {
      if (!block.includes("actions/checkout@")) continue;
      if (/github\.event_name\s*==\s*'push'/.test(block)) continue;
      if (!/\b(pnpm|node scripts\/|npm)\b/.test(block)) continue;

      const checkoutSteps = block
        .split(/(?=^\s+- uses: actions\/checkout@)/m)
        .filter((step) => step.includes("actions/checkout@"));
      for (const step of checkoutSteps) {
        expect(step, `${name} must not persist checkout credentials`).toMatch(
          /persist-credentials:\s*false/,
        );
      }
    }
  });

  it("sets up pinned pnpm before any workflow job uses pnpm", () => {
    expect(packageJson.packageManager).toBe(
      "pnpm@11.20.0+sha256.34e198cb1e43237517ecedfd31f9ae26a6c0a3e5366ce58a2d05f4b21fb5f19a",
    );

    for (const relativePath of workflowPaths) {
      const workflow = readFileSync(join(root, relativePath), "utf8");
      for (const { name, block } of workflowJobBlocks(workflow)) {
        const usesPnpm =
          block.includes("cache: pnpm") ||
          /\bpnpm install\b/.test(block) ||
          /\bpnpm run\b/.test(block);
        if (!usesPnpm) continue;

        const setupIndex = block.indexOf(pnpmSetupAction);
        const setupNodeIndex = block.indexOf("actions/setup-node");
        expect(setupIndex, `${relativePath}:${name} missing pinned pnpm setup`).toBeGreaterThan(-1);
        const setupStep = block.slice(setupIndex, setupNodeIndex);
        expect(setupStep, `${relativePath}:${name} must disable action install`).toContain(
          "run_install: false",
        );
        expect(
          setupStep,
          `${relativePath}:${name} must use packageManager as the pnpm version source`,
        ).not.toMatch(/^\s+version:/m);
        expect(
          setupIndex,
          `${relativePath}:${name} pnpm setup must precede setup-node`,
        ).toBeLessThan(setupNodeIndex);
      }
    }
  });

  it("runs pinned CodeQL and workflow security analysis", () => {
    const workflowSecurity = workflowJob("codeql-workflow-security");

    expect(workflowSecurity).toContain("name: CodeQL/workflow security");
    expect(workflowSecurity).toContain("actions: read");
    expect(workflowSecurity).toContain("security-events: write");
    expect(workflowSecurity).toContain(
      "github/codeql-action/init@5595ccaf912efad79be6eef63a5619ff05969be3",
    );
    expect(workflowSecurity).toContain(
      "github/codeql-action/analyze@5595ccaf912efad79be6eef63a5619ff05969be3",
    );
    expect(workflowSecurity).toContain("upload: never");
    expect(workflowSecurity).toContain("persist-credentials: false");
    expect(workflowSecurity).not.toContain("zizmor-action");
    expect(workflowSecurity).not.toContain("GH_TOKEN");
    expect(workflowSecurity).not.toContain("github.token");
    expect(workflowSecurity).toContain(
      "ghcr.io/zizmorcore/zizmor:1.29.0@sha256:863026d54f91271b10b60b67ad8054cb37120167e162482597db102b3026a284",
    );
    expect(workflowSecurity).toContain("--network=none");
    expect(workflowSecurity).toContain("--format=github");
    expect(workflowSecurity).toContain("--no-online-audits");
    expect(workflowSecurity).toContain("--min-severity=medium");
    expect(workflowSecurity).toContain("--min-confidence=medium");
  });

  it("keeps the cross-platform fast suite on the minimum Node runtime", () => {
    const crossPlatformJob = workflowJob("cross-platform-minimum-matrix");
    expect(crossPlatformJob).toContain("os: [ubuntu-latest, windows-latest, macos-latest]");
    expect(crossPlatformJob).toContain("node-version: 22.23.1");
    expect(crossPlatformJob).toContain("pnpm run test:cross-platform");
  });

  it("blocks publishing until the live contract suite passes for the publish ref", () => {
    const liveContract = workflowJobBlock(publish, "live-contract") ?? "";
    const githubReleaseJob = workflowJobBlock(publish, "github-release") ?? "";
    const containerImageJob = workflowJobBlock(publish, "container-image") ?? "";
    const publishJob = workflowJobBlock(publish, "publish") ?? "";

    expect(publishJob).toContain("needs: [prepare, live-contract]");
    expect(containerImageJob).toContain("needs: [prepare, publish]");
    expect(containerImageJob).toContain("environment: ghcr-publish");
    expect(containerImageJob).toContain("ghcr.io/${{ github.repository }}");
    expect(containerImageJob).toContain("packages: write");
    expect(containerImageJob).toContain("id-token: write");
    expect(containerImageJob).toContain("docker/setup-qemu-action");
    expect(containerImageJob).toContain("docker/setup-buildx-action");
    expect(containerImageJob).toContain("sigstore/cosign-installer");
    expect(containerImageJob).toContain("node scripts/smoke-container-image.mjs");
    expect(containerImageJob).toContain("node scripts/publish-container-image.mjs");
    expect(githubReleaseJob).toContain("needs: [prepare, publish, container-image]");
    expect(githubReleaseJob).toContain("Create GitHub release from verified artifact");
    expect(liveContract).toContain("needs: prepare");
    expect(liveContract).toContain("uses: ./.github/workflows/contract.yml");
    expect(liveContract).toContain("checkout-sha: ${{ needs.prepare.outputs.checkout-sha }}");
    expect(liveContract).not.toContain("secrets:");
    expect(liveContract).not.toContain("${{ secrets.");
    expect(liveContract).not.toContain("for attempt in 1 2 3");
    expect(liveContract).not.toContain("retrying");
    expect(publish).toContain("github-release:");
  });
});
