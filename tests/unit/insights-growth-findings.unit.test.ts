/**
 * Cases C19, C23 and C25 (b2_report_usage_growth). Each test asserts the correct behavior;
 * the defects are still present, so they use `knownDefect` (see tests/support/known-defect.ts).
 */
import type { B2Client } from "../../src/b2/client";
import { registerInsightTools } from "../../src/b2/insights";
import type {
  ListReportObjectKeysOptions,
  ReportObjectClient,
  ReportObjectPage,
  ReportObjectText,
} from "../../src/b2/report-client";
import { parseResult, ToolHarness } from "../support/deterministic-fakes";
import { knownDefect } from "../support/known-defect";

const REPORT_CLOCK = new Date("2026-01-31T12:00:00.000Z");

function csv(rows: string[]): string {
  return (
    "account_id,date,bucket_id,bucket_name,stored_gb,downloaded_gb,uploaded_gb,api_txn_class_c\n" +
    rows.join("")
  );
}

function reportClient(csvByKey: Record<string, string>): ReportObjectClient {
  const allKeys = Object.keys(csvByKey).sort();
  return {
    async listReportObjectKeys(
      _bucketName: string,
      input: ListReportObjectKeysOptions = {},
    ): Promise<ReportObjectPage> {
      let keys = allKeys;
      if (input.prefix) keys = keys.filter((key) => key.startsWith(input.prefix as string));
      if (input.startAfter) keys = keys.filter((key) => key > (input.startAfter as string));
      const page = keys.slice(0, input.maxKeys ?? keys.length);
      return { keys: page, isTruncated: page.length < keys.length };
    },
    async downloadReportObjectText(_bucketName: string, key: string): Promise<ReportObjectText> {
      const text = csvByKey[key] ?? "";
      return { text, bytes: Buffer.byteLength(text, "utf8"), truncated: false };
    },
  };
}

function register(report: ReportObjectClient): ToolHarness {
  const harness = new ToolHarness();
  registerInsightTools(
    harness,
    {} as B2Client,
    { getAuth: async () => ({ accountId: "test-account", allowedBuckets: null }) } as Parameters<
      typeof registerInsightTools
    >[2],
    report,
  );
  return harness;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(REPORT_CLOCK);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("b2_report_usage_growth findings", () => {
  knownDefect(
    "Finding C19: order=shrinking with limit below the shrinker count returns the biggest shrinkers",
    async () => {
      const then = "2026-01-01";
      const now = "2026-01-30";
      const tools = register(
        reportClient({
          [`${then}/usage.account-a.csv`]: csv([
            `small,${then},b1,b1,100,0,0,0\n`,
            `medium,${then},b2,b2,100,0,0,0\n`,
            `huge,${then},b3,b3,100,0,0,0\n`,
          ]),
          [`${now}/usage.account-a.csv`]: csv([
            `small,${now},b1,b1,99,0,0,0\n`,
            `medium,${now},b2,b2,80,0,0,0\n`,
            `huge,${now},b3,b3,10,0,0,0\n`,
          ]),
        }),
      );

      const result = parseResult(
        await tools.call("b2_report_usage_growth", {
          days: 30,
          period: "month",
          order: "shrinking",
          limit: 1,
        }),
      );

      // The single most-shrunk account ("huge", -90 GB) must be the one kept.
      expect(
        result.accounts.map((a: { account: string }) => a.account),
        "accounts kept under limit=1",
      ).toEqual(["huge"]);
    },
  );

  knownDefect(
    "Finding C23: the comparison snapshot ignores non-CSV keys that sort first",
    async () => {
      const tools = register(
        reportClient({
          // Not a usage CSV, but its date prefix is the earliest key after the target date.
          "2026-01-02/notes.txt": "not a report",
          "2026-01-05/usage.account-a.csv": csv(["acct,2026-01-05,b1,b1,10,0,0,0\n"]),
          "2026-01-30/usage.account-a.csv": csv(["acct,2026-01-30,b1,b1,30,0,0,0\n"]),
        }),
      );

      const result = parseResult(
        await tools.call("b2_report_usage_growth", {
          days: 30,
          period: "month",
          order: "most_grown",
          limit: 10,
        }),
      );

      expect(result.from_date, "comparison snapshot date").toBe("2026-01-05");
    },
  );

  knownDefect(
    "Finding C25: days=1 compares the previous snapshot with the latest when the latest is yesterday",
    async () => {
      const tools = register(
        reportClient({
          "2026-01-29/usage.account-a.csv": csv(["acct,2026-01-29,b1,b1,10,0,0,0\n"]),
          "2026-01-30/usage.account-a.csv": csv(["acct,2026-01-30,b1,b1,30,0,0,0\n"]),
        }),
      );

      const result = parseResult(
        await tools.call("b2_report_usage_growth", {
          days: 1,
          period: "month",
          order: "most_grown",
          limit: 10,
        }),
      );

      expect(result.note, "no insufficient-history note").toBeUndefined();
      expect(result.to_date, "latest snapshot date").toBe("2026-01-30");
      expect(result.from_date, "previous snapshot date").toBe("2026-01-29");
    },
  );
});
