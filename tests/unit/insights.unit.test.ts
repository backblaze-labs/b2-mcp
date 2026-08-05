import {
  parseCsv,
  normalizeDate,
  mapRow,
  computeAccountGrowth,
  computeEgressLeaders,
  computeSnapshotGrowth,
  periodStartDate,
  selectUsageKeys,
  registerInsightTools,
  ReportRow,
} from "../../src/b2/insights.js";

const GB = 1e9;
function row(accountId: string, storedGb: number): ReportRow {
  return {
    accountId,
    _date: "2026-06-28",
    storageBytes: storedGb * GB,
    egressBytes: 0,
    uploadBytes: 0,
    classCTxn: 0,
  };
}

describe("insights — periodStartDate", () => {
  const jun28 = new Date(Date.UTC(2026, 5, 28));
  it("month/quarter/year back from a date", () => {
    expect(periodStartDate("month", jun28)).toBe("2026-05-28");
    expect(periodStartDate("quarter", jun28)).toBe("2026-03-28");
    expect(periodStartDate("year", jun28)).toBe("2025-06-28");
  });
  it("clamps the day for short target months (no overflow)", () => {
    // Mar 31 minus a month is Feb, which has fewer days → clamp, not roll into March
    expect(periodStartDate("month", new Date(Date.UTC(2026, 2, 31)))).toBe("2026-02-28");
    expect(periodStartDate("month", new Date(Date.UTC(2024, 2, 31)))).toBe("2024-02-29"); // leap
  });
  it("crosses the year boundary for quarter", () => {
    expect(periodStartDate("quarter", new Date(Date.UTC(2026, 0, 15)))).toBe("2025-10-15");
  });
});

describe("insights — computeSnapshotGrowth", () => {
  it("computes growth, shrink, new accounts, and sums regions per account", () => {
    // 'a' appears twice in the THEN snapshot (two region files) → summed to 100 GB
    const then = [row("a", 60), row("a", 40), row("b", 50), row("d", 20)];
    const now = [row("a", 150), row("b", 50), row("c", 10)]; // c new, d gone
    const out = computeSnapshotGrowth(then, now);

    const a = out.find((x) => x.accountId === "a")!;
    expect(a.firstBytes).toBe(100 * GB);
    expect(a.lastBytes).toBe(150 * GB);
    expect(a.growthBytes).toBe(50 * GB);
    expect(a.growthPct).toBe(50);

    const c = out.find((x) => x.accountId === "c")!;
    expect(c.isNew).toBe(true);
    expect(c.firstBytes).toBe(0);
    expect(c.growthPct).toBeNull(); // no baseline

    const d = out.find((x) => x.accountId === "d")!;
    expect(d.lastBytes).toBe(0);
    expect(d.growthBytes).toBe(-20 * GB);
    expect(d.growthPct).toBe(-100);

    // sorted by growthBytes desc: a (+50), c (+10), b (0), d (-20)
    expect(out.map((x) => x.accountId)).toEqual(["a", "c", "b", "d"]);
  });
});

describe("insights — selectUsageKeys", () => {
  it("keeps the usage.account file and drops the usage.audit mirror (no double-count)", () => {
    const keys = [
      "2026-04-29/usage.account-357e9d54ce31.csv",
      "2026-04-29/usage.audit-account-357e9d54ce31.csv",
      "2026-04-30/usage.account-357e9d54ce31.csv",
      "2026-04-30/usage.audit-account-357e9d54ce31.csv",
    ];
    expect(selectUsageKeys(keys)).toEqual([
      "2026-04-29/usage.account-357e9d54ce31.csv",
      "2026-04-30/usage.account-357e9d54ce31.csv",
    ]);
  });

  it("drops the reportingLocations index file (no usage rows, wasted fetch)", () => {
    const keys = [
      "2026-05-28/usage.account-357e9d54ce31.csv",
      "2026-05-28/usage.group-165914.reportingLocations.csv",
      "2026-05-28/usage.group-165914.us-west-004.csv",
      "2026-05-28/usage.audit-group-165914.us-west-004.csv",
    ];
    expect(selectUsageKeys(keys)).toEqual([
      "2026-05-28/usage.account-357e9d54ce31.csv",
      "2026-05-28/usage.group-165914.us-west-004.csv",
    ]);
  });

  it("falls back to non-audit CSVs when no file matches 'usage'", () => {
    const keys = ["2026-04-29/report.csv", "2026-04-29/audit.csv"];
    expect(selectUsageKeys(keys)).toEqual(["2026-04-29/report.csv"]);
  });
});

describe("insights — CSV parsing", () => {
  it("parses headers and rows into objects", () => {
    const rows = parseCsv("account_id,date,stored_gb\nacc1,2026-06-01,10\nacc2,2026-06-01,20\n");
    expect(rows).toEqual([
      { account_id: "acc1", date: "2026-06-01", stored_gb: "10" },
      { account_id: "acc2", date: "2026-06-01", stored_gb: "20" },
    ]);
  });

  it("handles quoted fields with embedded commas and escaped quotes", () => {
    const rows = parseCsv('a,b\n"x,y","he said ""hi"""\n');
    expect(rows[0]).toEqual({ a: "x,y", b: 'he said "hi"' });
  });

  it("tolerates CRLF line endings and a trailing newline-less row", () => {
    const rows = parseCsv("a,b\r\n1,2\r\n3,4");
    expect(rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("insights — normalizeDate", () => {
  it("passes through ISO dates", () => {
    expect(normalizeDate("2026-06-25")).toBe("2026-06-25");
  });
  it("normalizes M/D/YY partner format with zero-padding", () => {
    expect(normalizeDate("6/5/26")).toBe("2026-06-05");
  });
  it("returns null for unparseable input", () => {
    expect(normalizeDate("not-a-date")).toBeNull();
  });
});

describe("insights — mapRow", () => {
  it("maps columns and converts GB→bytes", () => {
    const r = mapRow({
      account_id: "acc1",
      date: "2026-06-01",
      bucket_name: "b",
      stored_gb: "2",
      downloaded_gb: "3",
    });
    expect(r).toMatchObject({
      accountId: "acc1",
      _date: "2026-06-01",
      storageBytes: 2e9,
      egressBytes: 3e9,
    });
  });

  it("treats a blank stored_gb as null (not zero) so it does not skew growth", () => {
    const r = mapRow({ account_id: "acc1", date: "2026-06-01", stored_gb: "" });
    expect(r?.storageBytes).toBeNull();
  });

  it("drops rows missing account_id or date", () => {
    expect(mapRow({ date: "2026-06-01" })).toBeNull();
    expect(mapRow({ account_id: "acc1" })).toBeNull();
  });
});

describe("insights — computeAccountGrowth", () => {
  const rows: ReportRow[] = [
    {
      accountId: "a",
      _date: "2026-06-01",
      storageBytes: 100,
      egressBytes: 5,
      uploadBytes: 0,
      classCTxn: 0,
    },
    {
      accountId: "a",
      _date: "2026-06-03",
      storageBytes: 150,
      egressBytes: 5,
      uploadBytes: 0,
      classCTxn: 0,
    },
    {
      accountId: "b",
      _date: "2026-06-01",
      storageBytes: 200,
      egressBytes: 1,
      uploadBytes: 0,
      classCTxn: 0,
    },
    {
      accountId: "b",
      _date: "2026-06-03",
      storageBytes: 180,
      egressBytes: 1,
      uploadBytes: 0,
      classCTxn: 0,
    },
  ];

  it("computes first→last growth and sorts most-grown first", () => {
    const out = computeAccountGrowth(rows);
    expect(out[0].accountId).toBe("a");
    expect(out[0].growthBytes).toBe(50);
    expect(out[0].growthPct).toBe(50);
    expect(out[0].egressBytes).toBe(10);
  });

  it("represents shrink as negative growth", () => {
    const b = computeAccountGrowth(rows).find((x) => x.accountId === "b")!;
    expect(b.growthBytes).toBe(-20);
  });
});

describe("insights — computeEgressLeaders", () => {
  const rows: ReportRow[] = [
    {
      accountId: "a",
      _date: "d1",
      bucketName: "ba",
      storageBytes: 0,
      egressBytes: 30,
      uploadBytes: 0,
      classCTxn: 0,
    },
    {
      accountId: "a",
      _date: "d2",
      bucketName: "ba",
      storageBytes: 0,
      egressBytes: 10,
      uploadBytes: 0,
      classCTxn: 0,
    },
    {
      accountId: "b",
      _date: "d1",
      bucketName: "bb",
      storageBytes: 0,
      egressBytes: 20,
      uploadBytes: 0,
      classCTxn: 0,
    },
  ];

  it("ranks accounts by total egress", () => {
    const out = computeEgressLeaders(rows, "account");
    expect(out.map((x) => x.key)).toEqual(["a", "b"]);
    expect(out[0].egress).toBe(40);
  });

  it("can rank by bucket", () => {
    const out = computeEgressLeaders(rows, "bucket");
    expect(out[0].egress).toBe(40);
    expect(out[0].bucketName).toBe("ba");
  });
});

// ── Snapshot listing/selection (fake report client — proves the perf-critical path) ──────
import { latestSnapshotDate, loadDayRows } from "../../src/b2/insights.js";

function fakeReportClient(
  objectsByDay: Record<string, string[]>,
  csvByKey: Record<string, string> = {},
) {
  const allKeys = Object.entries(objectsByDay).flatMap(([d, names]) =>
    names.map((n) => `${d}/${n}`),
  );
  return {
    listReportObjectKeys: async (
      _bucketName: string,
      input: { prefix?: string; startAfter?: string; maxKeys?: number },
    ) => {
      let keys = allKeys.slice().sort();
      const prefix = input.prefix;
      const startAfter = input.startAfter;
      if (prefix) keys = keys.filter((k) => k.startsWith(prefix));
      if (startAfter) keys = keys.filter((k) => k > startAfter);
      if (input.maxKeys) keys = keys.slice(0, input.maxKeys);
      return { keys, isTruncated: false };
    },
    downloadReportObjectText: async (_bucketName: string, key: string) => {
      const text = csvByKey[key] ?? "";
      return { text, bytes: Buffer.byteLength(text, "utf8"), truncated: false };
    },
  } as any;
}

describe("insights — snapshot selection (fake report client)", () => {
  it("latestSnapshotDate returns the most recent day present", async () => {
    const b2Client = fakeReportClient({
      "2026-06-20": ["usage.account-a.us-west.csv"],
      "2026-06-27": ["usage.account-a.us-west.csv"],
    });
    const today = new Date(Date.UTC(2026, 5, 28));
    expect((await latestSnapshotDate(b2Client, "b2-reports-x", today)).date).toBe("2026-06-27");
  });

  it("loadDayRows loads only the requested day and sums its region files", async () => {
    const csv = "account_id,date,stored_gb\n" + "a,2026-05-28,60\n";
    const csv2 = "account_id,date,stored_gb\n" + "a,2026-05-28,40\n";
    const b2Client = fakeReportClient(
      {
        "2026-05-28": ["usage.account-a.us-west.csv", "usage.account-a.eu-central.csv"],
        "2026-06-27": ["usage.account-a.us-west.csv"], // must NOT be loaded
      },
      {
        "2026-05-28/usage.account-a.us-west.csv": csv,
        "2026-05-28/usage.account-a.eu-central.csv": csv2,
      },
    );
    const rows = await loadDayRows(b2Client, "b2-reports-x", "2026-05-28");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r._date === "2026-05-28")).toBe(true);
    // two region rows for account a → 60 + 40 GB stored
    expect(rows.reduce((s, r) => s + (r.storageBytes ?? 0), 0)).toBe(100 * GB);
  });

  it("latestSnapshotDate stops at the report listing page budget", async () => {
    let calls = 0;
    const b2Client = {
      listReportObjectKeys: async () => {
        calls++;
        return {
          keys: [`2026-06-${String(Math.min(calls, 28)).padStart(2, "0")}/usage.account.csv`],
          isTruncated: true,
          nextContinuationToken: String(calls),
        };
      },
      downloadReportObjectText: async () => ({ text: "", bytes: 0, truncated: false }),
    };

    const result = await latestSnapshotDate(
      b2Client as any,
      "b2-reports-x",
      new Date(Date.UTC(2026, 5, 28)),
    );

    expect(calls).toBe(100);
    expect(result.date).toBe("2026-06-28");
  });
});

describe("insights — report scan bounds", () => {
  it("returns partial metadata when report CSV selection is capped", async () => {
    const tools: Record<string, { execute: (args: any) => Promise<any> }> = {};
    const server = {
      registerTool(name: string, _definition: unknown, execute: (args: any) => Promise<any>) {
        tools[name] = { execute };
      },
    };
    const today = new Date().toISOString().slice(0, 10);
    const keys = Array.from(
      { length: 1005 },
      (_, i) => `${today}/usage.account-${String(i).padStart(4, "0")}.csv`,
    );
    const csv = `account_id,date,downloaded_gb,stored_gb\nacct,${today},1,1\n`;
    const b2Client = {
      listReportObjectKeys: async () => ({
        keys,
        isTruncated: false,
      }),
      downloadReportObjectText: async () => ({
        text: csv,
        bytes: Buffer.byteLength(csv, "utf8"),
        truncated: false,
      }),
    };
    const auth = {
      getAuth: async () => ({ accountId: "acct" }),
    };
    registerInsightTools(server as any, b2Client as any, auth as any, b2Client as any);

    const result = await tools.b2_egress_leaders.execute({
      by: "account",
      days: 90,
      limit: 1,
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.partial).toBe(true);
    expect(body.truncated).toBe(true);
    expect(body.report_scan.selected_keys).toBe(1000);
    expect(body.report_scan.downloaded_keys).toBe(1000);
    expect(body.report_scan.stop_reasons).toContain("max_selected_keys");
  });

  it("stops before starting another report download at the byte cap", async () => {
    const tools: Record<string, { execute: (args: any) => Promise<any> }> = {};
    const server = {
      registerTool(name: string, _definition: unknown, execute: (args: any) => Promise<any>) {
        tools[name] = { execute };
      },
    };
    const today = new Date().toISOString().slice(0, 10);
    const keys = [`${today}/usage.account-0001.csv`, `${today}/usage.account-0002.csv`];
    const downloadReportObjectText = vi.fn(async () => ({
      text: "",
      bytes: 25 * 1024 * 1024,
      truncated: false,
    }));
    const b2Client = {
      listReportObjectKeys: async () => ({
        keys,
        isTruncated: false,
      }),
      downloadReportObjectText,
    };
    const auth = {
      getAuth: async () => ({ accountId: "acct" }),
    };
    registerInsightTools(server as any, b2Client as any, auth as any, b2Client as any);

    const result = await tools.b2_egress_leaders.execute({
      by: "account",
      days: 90,
      limit: 1,
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.partial).toBe(true);
    expect(body.report_scan.downloaded_keys).toBe(1);
    expect(body.report_scan.downloaded_mb).toBe(25);
    expect(body.report_scan.stop_reasons).toContain("max_downloaded_bytes");
    expect(downloadReportObjectText).toHaveBeenCalledTimes(1);
  });

  it("shares one byte budget across b2_usage_growth discovery and both snapshots", async () => {
    const tools: Record<string, { execute: (args: any) => Promise<any> }> = {};
    const server = {
      registerTool(name: string, _definition: unknown, execute: (args: any) => Promise<any>) {
        tools[name] = { execute };
      },
    };
    const csv = "account_id,date,stored_gb\nacct,2026-06-20,1\n";
    const downloadReportObjectText = vi
      .fn()
      .mockResolvedValueOnce({
        text: csv,
        bytes: 20 * 1024 * 1024,
        truncated: false,
      })
      .mockResolvedValueOnce({
        text: "",
        bytes: 5 * 1024 * 1024,
        truncated: true,
      });
    const b2Client = {
      listReportObjectKeys: async (
        _bucket: string,
        input: { prefix?: string; maxKeys?: number },
      ) => {
        if (input.prefix === "2026-06-20/") {
          return { keys: ["2026-06-20/usage.account.csv"], isTruncated: false };
        }
        if (input.prefix === "2026-06-28/") {
          return { keys: ["2026-06-28/usage.account.csv"], isTruncated: false };
        }
        if (input.maxKeys === 1) {
          return { keys: ["2026-06-20/usage.account.csv"], isTruncated: false };
        }
        return {
          keys: ["2026-06-20/usage.account.csv", "2026-06-28/usage.account.csv"],
          isTruncated: false,
        };
      },
      downloadReportObjectText,
    };
    const auth = {
      getAuth: async () => ({ accountId: "acct" }),
    };
    registerInsightTools(server as any, {} as any, auth as any, b2Client as any);

    const result = await tools.b2_usage_growth.execute({
      period: "month",
      order: "most_grown",
      limit: 1,
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.partial).toBe(true);
    expect(body.report_scan.downloaded_mb).toBe(25);
    expect(body.report_scan.stop_reasons).toContain("max_downloaded_bytes");
    expect(downloadReportObjectText).toHaveBeenCalledTimes(2);
    expect(downloadReportObjectText.mock.calls[1][2].maxBytes).toBe(5 * 1024 * 1024);
  });
});
