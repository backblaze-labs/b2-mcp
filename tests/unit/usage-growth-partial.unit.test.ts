import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInsightTools } from "../../src/b2/insights";
import { parseResult, ToolHarness } from "../support/deterministic-fakes";

const DAY_MS = 86400_000;
const day = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
const HDR =
  "account_id,date,bucket_id,bucket_name,stored_gb,downloaded_gb,uploaded_gb,api_txn_class_c\n";

describe("b2_report_usage_growth with partially loaded day", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-31T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("does not report accounts as shrinking to 0 when the 'now' day was cut off", async () => {
    const then = day(30);
    const now = day(1);
    const files: Record<string, string> = {
      [`${then}/usage.a.csv`]: HDR + `acct-1,${then},b,b,10,0,0,0\nacct-2,${then},b,b,20,0,0,0\n`,
      [`${now}/usage.a.csv`]: HDR + `acct-1,${now},b,b,11,0,0,0\nacct-2,${now},b,b,22,0,0,0\n`,
    };
    const client = {
      async listReportObjectKeys(_b: string, o: { prefix?: string } = {}) {
        const keys = Object.keys(files)
          .filter((k) => !o.prefix || k.startsWith(o.prefix))
          .sort();
        return { keys, isTruncated: false };
      },
      async downloadReportObjectText(_b: string, key: string) {
        const text = files[key] as string;
        // reading the 'then' day eats the whole 12s budget
        if (key.startsWith(`${then}/`)) vi.setSystemTime(Date.now() + 13_000);
        return { text, bytes: text.length, truncated: false };
      },
    };
    const tools = new ToolHarness();
    registerInsightTools(
      tools,
      {} as never,
      { getAuth: async () => ({ accountId: "t", allowedBuckets: null }) } as never,
      client as never,
    );
    const r = parseResult(
      await tools.call("b2_report_usage_growth", { days: 30, order: "shrinking", limit: 10 }),
    );
    expect(r.truncated).toBe(true);
    expect(r.accounts ?? []).toEqual([]);
  });
});
