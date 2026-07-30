import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "../..");

const liveWorkflows = [
  {
    path: ".github/workflows/contract.yml",
    environment: "live-b2-contract",
    concurrency: "live-b2-contract-${{ github.repository }}",
  },
  {
    path: ".github/workflows/smoke.yml",
    environment: "live-b2-smoke",
    concurrency: "live-b2-smoke-${{ github.repository }}",
  },
];

const workflowText = (path: string) => readFileSync(join(root, path), "utf8");

describe("live secret workflow policy", () => {
  it.each(liveWorkflows)(
    "$path uses a protected environment, protected refs, and shared Node version",
    ({ path, environment }) => {
      const text = workflowText(path);
      expect(text).toContain(`environment: ${environment}`);
      expect(text).toContain("github.repository == 'backblaze-labs/b2-mcp'");
      expect(text).toContain(
        "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
      );
      expect(text).toContain("startsWith(github.ref, 'refs/tags/v')");
      expect(text).toContain("node-version-file: .nvmrc");
      expect(text).toContain("permissions:\n  contents: read");
    },
  );

  it.each(liveWorkflows)(
    "$path serializes runs and never cancels in-progress cleanup",
    ({ path, concurrency }) => {
      const text = workflowText(path);
      expect(text).toContain(`group: ${concurrency}`);
      expect(text).toContain("cancel-in-progress: false");
    },
  );

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
    expect(text).toMatch(/environment: live-b2-(contract|smoke)/);
  });
});
