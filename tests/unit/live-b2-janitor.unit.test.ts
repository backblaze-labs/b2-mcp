import { join } from "path";
import { pathToFileURL } from "url";
import type { CleanupStats } from "../support/live-b2-contract-types";

interface JanitorModule {
  assertExpectedLiveTestAccount(
    authManager: { getAuth(): Promise<{ accountId: string }> },
    expectedAccountId: string,
    options?: { log?: (message: string) => void },
  ): Promise<void>;
  cleanupKeys(
    b2Client: {
      listKeys(args: { maxKeyCount: number; startApplicationKeyId?: string }): Promise<{
        keys?: Array<{ applicationKeyId: string; keyName: string }>;
        nextApplicationKeyId?: string | null;
      }>;
      deleteKey(applicationKeyId: string): Promise<void>;
    },
    stats: CleanupStats,
    options: { prefix: string; excludePrefixes?: string[]; dryRun?: boolean },
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

function stats(): CleanupStats {
  return {
    buckets: 0,
    objectVersions: 0,
    multipartUploads: 0,
    keys: 0,
    errors: 0,
    leakedBuckets: 0,
  };
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

  it("deletes run-prefixed keys discovered after the first key page", async () => {
    const janitor = await loadJanitor();
    const deleted: string[] = [];
    const cursors: Array<string | undefined> = [];
    const b2Client = {
      async listKeys(args: { maxKeyCount: number; startApplicationKeyId?: string }) {
        cursors.push(args.startApplicationKeyId);
        if (!args.startApplicationKeyId) {
          return {
            keys: [{ applicationKeyId: "other-key", keyName: "customer-key" }],
            nextApplicationKeyId: "cursor-1",
          };
        }
        return {
          keys: [{ applicationKeyId: "run-key", keyName: "mcp-contract-123-key" }],
          nextApplicationKeyId: null,
        };
      },
      async deleteKey(applicationKeyId: string) {
        deleted.push(applicationKeyId);
      },
    };
    const cleanupStats = stats();

    await janitor.cleanupKeys(b2Client, cleanupStats, {
      prefix: "mcp-contract-123",
      excludePrefixes: [],
      dryRun: false,
    });

    expect(cursors).toEqual([undefined, "cursor-1"]);
    expect(deleted).toEqual(["run-key"]);
    expect(cleanupStats.keys).toBe(1);
    expect(cleanupStats.errors).toBe(0);
  });

  it("applies prefix boundaries and exclusions to key cleanup", async () => {
    const janitor = await loadJanitor();
    const deleted: string[] = [];
    const b2Client = {
      async listKeys() {
        return {
          keys: [
            { applicationKeyId: "run-key", keyName: "mcp-contract-run1-restricted" },
            { applicationKeyId: "nearby-key", keyName: "mcp-contract-run10-restricted" },
            { applicationKeyId: "excluded-key", keyName: "mcp-contract-run2-restricted" },
          ],
          nextApplicationKeyId: null,
        };
      },
      async deleteKey(applicationKeyId: string) {
        deleted.push(applicationKeyId);
      },
    };
    const cleanupStats = stats();

    await janitor.cleanupKeys(b2Client, cleanupStats, {
      prefix: "mcp-contract-",
      excludePrefixes: ["mcp-contract-run2"],
      dryRun: false,
    });

    expect(deleted).toEqual(["run-key", "nearby-key"]);
    expect(cleanupStats.keys).toBe(2);
    expect(cleanupStats.errors).toBe(0);

    deleted.length = 0;
    const scopedStats = stats();
    await janitor.cleanupKeys(b2Client, scopedStats, {
      prefix: "mcp-contract-run1",
      excludePrefixes: [],
      dryRun: false,
    });
    expect(deleted).toEqual(["run-key"]);
    expect(scopedStats.keys).toBe(1);
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
