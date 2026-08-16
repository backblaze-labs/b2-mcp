import { join } from "path";
import { pathToFileURL } from "url";
import { readFileSync } from "fs";

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
  };
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
    expect(janitor.parseArgs(["--prefix", "mcp-contract-123"])).toMatchObject({
      bestEffort: false,
    });
  });
});
