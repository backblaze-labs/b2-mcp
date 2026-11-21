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
        "2026-01-02a-unrelated.csv": "not a dated snapshot",
        "2026-01-03/metadata.json": "not a usage report",
        "2026-01-03/usage.account.csv": "account_id,date,stored_gb\nacct,2026-01-03,10\n",
        "2026-01-30/usage.account.csv": "account_id,date,stored_gb\nacct,2026-01-30,20\n",
      };
      const pages: Array<{
        startAfter?: string;
        continuationToken?: string;
        maxKeys?: number;
        keys: string[];
      }> = [];
      const client: ReportObjectClient = {
        async listReportObjectKeys(_bucket, options = {}) {
          const keys = Object.keys(objects)
            .sort()
            .filter((key) => !options.prefix || key.startsWith(options.prefix))
            .filter((key) => !options.startAfter || key > options.startAfter);
          const offset = Number(options.continuationToken ?? 0);
          const page = keys.slice(offset, offset + (options.maxKeys ?? 1000));
          pages.push({ ...options, keys: page });
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
      expect(pages.filter((page) => page.startAfter === "2025-12-31")).toEqual([
        expect.objectContaining({
          maxKeys: 1,
          continuationToken: undefined,
          keys: ["2026-01-02/notes.txt"],
        }),
        expect.objectContaining({
          maxKeys: 1000,
          continuationToken: "1",
          keys: [
            "2026-01-02a-unrelated.csv",
            "2026-01-03/metadata.json",
            "2026-01-03/usage.account.csv",
            "2026-01-30/usage.account.csv",
          ],
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops comparison snapshot discovery when the shared page budget is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-31T12:00:00Z"));
    try {
      let comparisonPages = 0;
      const download = vi.fn(async () => {
        throw new Error("No report body should be downloaded without a comparison snapshot");
      });
      const client: ReportObjectClient = {
        async listReportObjectKeys(_bucket, options = {}) {
          if (options.startAfter === "2026-01-21") {
            return {
              keys: ["2026-01-30/usage.account.csv"],
              isTruncated: false,
              nextContinuationToken: undefined,
            };
          }
          if (options.startAfter !== "2025-12-31") throw new Error("Unexpected listing window");
          comparisonPages++;
          // Short pages exercise the page limit; bound a broken guard instead of hanging.
          if (comparisonPages > 99) throw new Error("Comparison exceeded the page budget");
          return {
            keys: [`2026-01-02/notes-${String(comparisonPages).padStart(3, "0")}.txt`],
            isTruncated: true,
            nextContinuationToken: String(comparisonPages),
          };
        },
        downloadReportObjectText: download,
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
      expect(comparisonPages).toBe(99);
      expect(result).toMatchObject({
        reports_enabled: true,
        truncated: true,
        partial: true,
        report_scan: { pages: 100, stop_reasons: ["max_pages"] },
      });
      expect(download).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
