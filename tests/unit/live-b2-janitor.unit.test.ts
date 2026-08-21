import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

interface JanitorModule {
  assertExpectedLiveTestAccount(
    authManager: { getAuth(): Promise<{ accountId: string }> },
    expectedAccountId: string,
    options?: { log?: (message: string) => void },
  ): Promise<void>;
  parseArgs(argv: string[]): {
    prefix: string;
    excludePrefixes: string[];
    dryRun: boolean;
    bestEffort: boolean;
    summaryJson: string;
  };
  writeJanitorSummary(
    options: { prefix: string; dryRun?: boolean; bestEffort?: boolean; summaryJson: string },
    stats: {
      buckets: number;
      objectVersions: number;
      multipartUploads: number;
      leakedBuckets: number;
      errors: number;
    },
    outcome: string,
    extra?: { error?: string; missing?: string[] },
  ): void;
}

async function loadJanitor(): Promise<JanitorModule> {
  return import(
    pathToFileURL(join(__dirname, "../../scripts/live-b2-janitor.mjs")).href
  ) as Promise<JanitorModule>;
}

describe("live B2 janitor", () => {
  it("requires the authorized account to match the configured live test account", async () => {
    const janitor = await loadJanitor();

    await expect(
      janitor.assertExpectedLiveTestAccount(
        { getAuth: async () => ({ accountId: "actual-account" }) },
        "expected-account",
      ),
    ).rejects.toThrow(/does not match B2_LIVE_TEST_ACCOUNT_ID/);
    await expect(
      janitor.assertExpectedLiveTestAccount(
        { getAuth: async () => ({ accountId: "expected-account" }) },
        "expected-account",
      ),
    ).resolves.toBeUndefined();
  });

  it("does not require key-management capabilities for cleanup", async () => {
    const janitor = await loadJanitor();
    const source = readFileSync(join(__dirname, "../../scripts/live-b2-janitor.mjs"), "utf8");

    expect("cleanupKeys" in janitor).toBe(false);
    expect(source).not.toMatch(/\.(?:listKeys|deleteKey)\s*\(/);
    expect(source).not.toContain("keys=");
  });

  it("parses best-effort cleanup mode separately from scheduled cleanup", async () => {
    const janitor = await loadJanitor();

    expect(janitor.parseArgs(["--prefix", "mcp-contract-123", "--best-effort"])).toMatchObject({
      prefix: "mcp-contract-123",
      bestEffort: true,
      dryRun: false,
    });
    expect(
      janitor.parseArgs([
        "--prefix",
        "mcp-contract-123",
        "--summary-json",
        "reports/live-b2/cleanup.json",
      ]),
    ).toMatchObject({
      summaryJson: "reports/live-b2/cleanup.json",
    });
    expect(janitor.parseArgs(["--prefix", "mcp-contract-123"])).toMatchObject({
      bestEffort: false,
    });
  });

  it("writes cleanup summaries through the secret-safe evidence contract", async () => {
    const janitor = await loadJanitor();
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-janitor-summary-"));
    const previousKey = process.env.B2_APPLICATION_KEY;
    process.env.B2_APPLICATION_KEY = "janitor-secret-value";
    try {
      const summaryJson = join(dir, "cleanup.json");
      janitor.writeJanitorSummary(
        { prefix: "mcp-contract-123", summaryJson },
        {
          buckets: 1,
          objectVersions: 0,
          multipartUploads: 0,
          leakedBuckets: 0,
          errors: 1,
        },
        "cleanup failure",
        { error: "janitor-secret-value" },
      );

      const written = readFileSync(summaryJson, "utf8");
      expect(written).toContain('"outcome": "cleanup failure"');
      expect(written).toContain("[omitted unsafe detail]");
      expect(written).not.toContain("janitor-secret-value");
    } finally {
      if (previousKey === undefined) delete process.env.B2_APPLICATION_KEY;
      else process.env.B2_APPLICATION_KEY = previousKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
