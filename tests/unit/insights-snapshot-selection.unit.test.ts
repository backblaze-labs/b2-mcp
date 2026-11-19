import { registerInsightTools } from "../../src/b2/insights";
import type { ReportObjectClient } from "../../src/b2/report-client";
import { parseResult, ToolHarness } from "../support/deterministic-fakes";

describe("usage growth snapshot selection", () => {
  it("skips earlier non-CSV keys when selecting the comparison snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-31T12:00:00Z"));
    try {
      const objects: Record<string, string> = {
        "2026-01-02/notes.txt": "not a usage report",
        "2026-01-03/usage.account.csv": "account_id,date,stored_gb\nacct,2026-01-03,10\n",
        "2026-01-30/usage.account.csv": "account_id,date,stored_gb\nacct,2026-01-30,20\n",
      };
      const client: ReportObjectClient = {
        async listReportObjectKeys(_bucket, options = {}) {
          const keys = Object.keys(objects)
            .sort()
            .filter((key) => !options.prefix || key.startsWith(options.prefix))
            .filter((key) => !options.startAfter || key > options.startAfter);
          const offset = Number(options.continuationToken ?? 0);
          const page = keys.slice(offset, offset + Math.min(options.maxKeys ?? 1, 1));
          const next = offset + page.length;
          return {
            keys: page,
            isTruncated: next < keys.length,
            nextContinuationToken: next < keys.length ? String(next) : undefined,
          };
        },
        async downloadReportObjectText(_bucket, key) {
          const text = objects[key];
          return { text, bytes: Buffer.byteLength(text), truncated: false };
        },
      };
      const tools = new ToolHarness();
      registerInsightTools(
        tools,
        {} as Parameters<typeof registerInsightTools>[1],
        { getAuth: async () => ({ accountId: "acct" }) } as Parameters<
          typeof registerInsightTools
        >[2],
        client,
      );
      const result = parseResult(
        await tools.call("b2_report_usage_growth", {
          days: 30,
          period: "month",
          order: "most_grown",
          limit: 50,
        }),
      );
      expect(result.from_date).toBe("2026-01-03");
      expect(result.to_date).toBe("2026-01-30");
      expect(result.accounts).toEqual([
        expect.objectContaining({ account: "acct", start_gb: 10, current_gb: 20, growth_gb: 10 }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
