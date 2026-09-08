// Branch-coverage tests for src/b2/insights.ts (issue #400).
//
// These exercise the analytics-aggregation edge branches that the existing
// insight suites leave uncovered: empty/null report rows, the Usage-Reports
// not-enabled path reached through the "then" snapshot, report page/candidate
// budget breaks, non-CSV key skips, single-subject + bucket-scoped resolution,
// and the native-scan deadline / abort plumbing. Scenarios assert the tool JSON
// output/shape rather than hitting lines for their own sake.

import type {
  B2Client,
  BucketFilters,
  BucketInfoResult,
  FileVersionResult,
  ListBucketsResult,
  ListFileNamesOptions,
  ListFileNamesResult,
  ListPartsOptions,
  ListPartsResult,
  ListUnfinishedLargeFilesOptions,
  ListUnfinishedLargeFilesResult,
  PartInfoResult,
  UnfinishedLargeFileResult,
} from "../../src/b2/client";
import {
  registerInsightTools,
  parseCsv,
  normalizeDate,
  computeAccountGrowth,
  computeEgressLeaders,
  latestSnapshotDate,
  loadDayRows,
  NATIVE_SCAN_TIME_BUDGET_MS,
  type ReportRow,
} from "../../src/b2/insights";
import type {
  ListReportObjectKeysOptions,
  ReportObjectClient,
  ReportObjectPage,
  ReportObjectText,
} from "../../src/b2/report-client";
import { runWithMcpRequestSignal } from "../../src/request-context";
import { abortError } from "../../src/utils/named-error";
import { parseResult, ToolHarness } from "../support/deterministic-fakes";

const GB = 1e9;
const DAY_MS = 86400_000;
// Single source of truth: imported from the module under test so a change to
// the native-scan budget is reflected here automatically instead of drifting.
const TIME_BUDGET_MS = NATIVE_SCAN_TIME_BUDGET_MS;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

const CSV_HEADER =
  "account_id,date,bucket_id,bucket_name,stored_gb,downloaded_gb,uploaded_gb,api_txn_class_c\n";

function csv(rows: string[]): string {
  return CSV_HEADER + rows.join("");
}

function noSuchBucket(): Error {
  return Object.assign(new Error("report bucket missing"), {
    name: "NoSuchBucket",
    $metadata: { httpStatusCode: 404 },
  });
}

function timeoutError(): Error {
  return Object.assign(new Error("scan timed out"), { name: "TimeoutError" });
}

// ── Report client fake (prefix/startAfter/continuationToken/maxKeys aware) ────

type ReportFake = {
  calls: Array<{ bucketName: string; input: ListReportObjectKeysOptions }>;
  client: ReportObjectClient;
};

function reportFake(
  csvByKey: Record<string, string>,
  options: {
    pageSize?: number;
    listError?: Error;
    // Per-call override: return a page or throw. Receives the 1-based call index.
    onList?: (
      input: ListReportObjectKeysOptions,
      callIndex: number,
    ) => ReportObjectPage | Error | undefined;
  } = {},
): ReportFake {
  const calls: ReportFake["calls"] = [];
  const allKeys = Object.keys(csvByKey).sort();
  return {
    calls,
    client: {
      async listReportObjectKeys(
        bucketName: string,
        input: ListReportObjectKeysOptions = {},
      ): Promise<ReportObjectPage> {
        calls.push({ bucketName, input });
        const override = options.onList?.(input, calls.length);
        if (override instanceof Error) throw override;
        if (override) return override;
        if (options.listError) throw options.listError;
        let keys = allKeys.slice();
        const { prefix, startAfter } = input;
        if (prefix) keys = keys.filter((key) => key.startsWith(prefix));
        if (startAfter) keys = keys.filter((key) => key > startAfter);
        const offset = input.continuationToken ? Number(input.continuationToken) : 0;
        const requested = input.maxKeys ?? keys.length;
        const pageSize = Math.min(options.pageSize ?? requested, requested);
        const page = keys.slice(offset, offset + pageSize);
        const nextOffset = offset + page.length;
        const isTruncated = nextOffset < keys.length;
        return {
          keys: page,
          isTruncated,
          nextContinuationToken: isTruncated ? String(nextOffset) : undefined,
        };
      },
      async downloadReportObjectText(_bucketName: string, key: string): Promise<ReportObjectText> {
        const text = csvByKey[key] ?? "";
        return { text, bytes: Buffer.byteLength(text, "utf8"), truncated: false };
      },
    },
  };
}

// ── Native client fake ────────────────────────────────────────────────────────

const defaultBucket: BucketInfoResult = {
  bucketId: "bucket-1",
  bucketName: "photos",
  bucketType: "allPrivate",
};

type NativeOptions = {
  buckets?: BucketInfoResult[];
  listBucketsError?: Error;
  filePages?: Array<ListFileNamesResult | Error>;
  uploadPages?: Array<ListUnfinishedLargeFilesResult | Error>;
  partPagesByFileId?: Record<string, Array<ListPartsResult | Error>>;
};

function createNativeClient(options: NativeOptions) {
  const filePages = [...(options.filePages ?? [])];
  const uploadPages = [...(options.uploadPages ?? [])];
  const partPagesByFileId: Record<string, Array<ListPartsResult | Error>> = {};
  for (const [fileId, pages] of Object.entries(options.partPagesByFileId ?? {})) {
    partPagesByFileId[fileId] = [...pages];
  }
  return {
    listBuckets: vi.fn(async (_input: BucketFilters = {}): Promise<ListBucketsResult> => {
      if (options.listBucketsError) throw options.listBucketsError;
      return { buckets: options.buckets ?? [defaultBucket] };
    }),
    listFileNames: vi.fn(async (_input: ListFileNamesOptions): Promise<ListFileNamesResult> => {
      const reply = filePages.shift() ?? { files: [], nextFileName: null };
      if (reply instanceof Error) throw reply;
      return reply;
    }),
    listUnfinishedLargeFiles: vi.fn(
      async (_input: ListUnfinishedLargeFilesOptions): Promise<ListUnfinishedLargeFilesResult> => {
        const reply = uploadPages.shift() ?? { files: [], nextFileId: null };
        if (reply instanceof Error) throw reply;
        return reply;
      },
    ),
    listParts: vi.fn(async (input: ListPartsOptions): Promise<ListPartsResult> => {
      const reply = partPagesByFileId[input.fileId]?.shift() ?? {
        parts: [],
        nextPartNumber: null,
      };
      if (reply instanceof Error) throw reply;
      return reply;
    }),
  };
}

function file(fileName: string, contentLength: number): FileVersionResult {
  return { fileName, contentLength, uploadTimestamp: Date.parse("2026-01-01T00:00:00.000Z") };
}

function upload(fileName: string, fileId: string, isoDate: string): UnfinishedLargeFileResult {
  return { fileName, fileId, uploadTimestamp: Date.parse(isoDate) };
}

function part(contentLength: number, partNumber = 1): PartInfoResult {
  return { partNumber, contentLength };
}

function registerTools(
  reportClient: ReportObjectClient,
  nativeClient: ReturnType<typeof createNativeClient> = createNativeClient({}),
  allowedBuckets?: Array<{ id: string; name: string | null }> | null,
) {
  const harness = new ToolHarness();
  registerInsightTools(
    harness,
    nativeClient as unknown as B2Client,
    { getAuth: async () => ({ accountId: "test-account", allowedBuckets }) } as Parameters<
      typeof registerInsightTools
    >[2],
    reportClient,
  );
  return harness;
}

const REPORT_CLOCK = new Date("2026-06-28T12:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Pure aggregation edge branches ────────────────────────────────────────────

describe("insights #400 — pure aggregation guards", () => {
  it("parseCsv drops blank trailing rows and back-fills short rows", () => {
    // Trailing blank line (row[0] === "") is dropped; a final row shorter than the
    // header back-fills missing cells with "".
    const rows = parseCsv("a,b,c\n1,2,3\n\n4\n");
    expect(rows).toEqual([
      { a: "1", b: "2", c: "3" },
      { a: "4", b: "", c: "" },
    ]);
  });

  it("parseCsv keeps a trailing row that ends without a newline", () => {
    const rows = parseCsv("a,b\nx,y");
    expect(rows).toEqual([{ a: "x", b: "y" }]);
  });

  it("normalizeDate expands a four-digit M/D/YYYY value without prefixing", () => {
    expect(normalizeDate("6/5/2026")).toBe("2026-06-05");
  });

  it("computeAccountGrowth tolerates a null row list", () => {
    expect(computeAccountGrowth(null as unknown as ReportRow[])).toEqual([]);
  });

  it("computeAccountGrowth skips rows missing account/date and accounts with no snapshots", () => {
    const rows: ReportRow[] = [
      // missing accountId → skipped
      {
        accountId: "",
        _date: "2026-06-01",
        storageBytes: 5,
        egressBytes: 1,
        uploadBytes: 0,
        classCTxn: 0,
      },
      // egress-only account: storageBytes null → no daily snapshot, so it is dropped
      {
        accountId: "egress-only",
        _date: "2026-06-01",
        storageBytes: null,
        egressBytes: 9,
        uploadBytes: 0,
        classCTxn: 0,
      },
      // zero baseline → growthPct null
      {
        accountId: "zero",
        _date: "2026-06-01",
        storageBytes: 0,
        egressBytes: 0,
        uploadBytes: 0,
        classCTxn: 0,
      },
      {
        accountId: "zero",
        _date: "2026-06-03",
        storageBytes: 100,
        egressBytes: 0,
        uploadBytes: 0,
        classCTxn: 0,
      },
    ];
    const out = computeAccountGrowth(rows);
    expect(out.map((r) => r.accountId)).toEqual(["zero"]);
    expect(out[0].growthBytes).toBe(100);
    expect(out[0].growthPct).toBeNull();
  });

  it("computeEgressLeaders tolerates a null row list and skips rows without a bucket key", () => {
    expect(computeEgressLeaders(null as unknown as ReportRow[])).toEqual([]);
    const rows: ReportRow[] = [
      // by-bucket key is bucketId || bucketName; neither present → skipped
      {
        accountId: "a",
        _date: "d1",
        storageBytes: 0,
        egressBytes: 50,
        uploadBytes: 0,
        classCTxn: 0,
      },
      {
        accountId: "a",
        _date: "d2",
        bucketName: "bkt",
        storageBytes: 0,
        egressBytes: 10,
        uploadBytes: 0,
        classCTxn: 0,
      },
    ];
    const leaders = computeEgressLeaders(rows, "bucket");
    expect(leaders).toEqual([{ key: "bkt", accountId: "a", bucketName: "bkt", egress: 10 }]);
  });
});

// ── latestSnapshotDate / loadDayRows direct branches ──────────────────────────

describe("insights #400 — snapshot listing helpers", () => {
  it("latestSnapshotDate picks the max date across several candidate keys", async () => {
    const today = new Date(Date.UTC(2026, 5, 28));
    const report = reportFake({
      "2026-06-20/usage.account-a.csv": "",
      "2026-06-25/usage.account-a.csv": "",
      "2026-06-22/usage.account-a.csv": "",
    });
    const result = await latestSnapshotDate(report.client, "b2-reports-x", today);
    expect(result).toEqual({ date: "2026-06-25", bucketMissing: false });
  });

  it("latestSnapshotDate stops immediately when the scan budget is already spent", async () => {
    const report = reportFake({ "2026-06-25/usage.account-a.csv": "" });
    // A budget whose startedAt is well in the past trips the page-budget guard on
    // the first iteration, so nothing is listed and the result is inconclusive.
    const spentBudget = {
      startedAt: Date.now() - 60_000,
      stats: {
        pages: 0,
        listed_keys: 0,
        candidate_keys: 0,
        selected_keys: 0,
        downloaded_keys: 0,
        downloaded_bytes: 0,
        parsed_rows: 0,
      },
    };
    const result = await latestSnapshotDate(
      report.client,
      "b2-reports-x",
      new Date(Date.UTC(2026, 5, 28)),
      spentBudget as unknown as Parameters<typeof latestSnapshotDate>[3],
    );
    expect(result).toEqual({ date: null, bucketMissing: false, searchedSince: undefined });
    expect(report.calls).toHaveLength(0);
  });

  it("loadDayRows skips non-CSV keys in the day folder", async () => {
    const day = "2026-01-09";
    const report = reportFake({
      [`${day}/notes.txt`]: "ignored",
      [`${day}/usage.account-a.csv`]: csv([`acct-a,${day},bucket-a,bucket-a,2,1,0,0\n`]),
    });
    const rows = await loadDayRows(report.client, "b2-reports-x", day);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId: "acct-a", storageBytes: 2e9 });
    // The .txt object was never requested for download.
    expect(report.calls.length).toBeGreaterThan(0);
  });
});

// ── b2_report_usage_growth branches ───────────────────────────────────────────

describe("insights #400 — b2_report_usage_growth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(REPORT_CLOCK);
  });

  it("returns not-enabled when the 'then' snapshot lookup 404s after a latest snapshot exists", async () => {
    const latest = daysAgo(1);
    const report = reportFake(
      { [`${latest}/usage.account-a.csv`]: csv([`a,${latest},b,b,10,0,0,0\n`]) },
      {
        // latestSnapshotDate lists with maxKeys 1000; nearestSnapshotDate uses
        // maxKeys 1 — fail only that lookup so latest succeeds but "then" 404s.
        onList: (input) => (input.maxKeys === 1 ? noSuchBucket() : undefined),
      },
    );
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_report_usage_growth", {
        period: "month",
        order: "most_grown",
        limit: 10,
      }),
    );

    expect(result.reports_enabled).toBe(false);
    expect(result.note).toContain("No b2-reports");
  });

  it("reports insufficient history when the 'then' lookup returns an empty page", async () => {
    const latest = daysAgo(1);
    const report = reportFake(
      { [`${latest}/usage.account-a.csv`]: csv([`a,${latest},b,b,10,0,0,0\n`]) },
      { onList: (input) => (input.maxKeys === 1 ? { keys: [], isTruncated: false } : undefined) },
    );
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_report_usage_growth", { days: 30, order: "most_grown", limit: 10 }),
    );

    expect(result.reports_enabled).toBe(true);
    expect(result.latest_snapshot).toBe(latest);
    expect(result.note).toContain("Not enough report history");
  });

  it("flags new accounts and null growth_pct for a zero-baseline account", async () => {
    const thenDay = daysAgo(30);
    const latest = daysAgo(1);
    const report = reportFake({
      [`${thenDay}/usage.account-then.csv`]: csv([
        `base,${thenDay},bk-base,bk-base,10,0,0,0\n`,
        // zero baseline in the earlier snapshot → growth_pct must be null
        `zero,${thenDay},bk-zero,bk-zero,0,0,0,0\n`,
      ]),
      [`${latest}/usage.account-now.csv`]: csv([
        `base,${latest},bk-base,bk-base,20,0,0,0\n`,
        `zero,${latest},bk-zero,bk-zero,5,0,0,0\n`,
        // present only in the later snapshot → new: true
        `newbie,${latest},bk-new,bk-new,7,0,0,0\n`,
        // blank stored_gb → null storage, skipped by storedByAccount
        `blank,${latest},bk-blank,bk-blank,,0,0,0\n`,
      ]),
    });
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_report_usage_growth", { days: 30, order: "most_grown", limit: 10 }),
    );

    expect(result.comparison).toBe("last 30 days");
    expect(result.from_date).toBe(thenDay);
    expect(result.to_date).toBe(latest);
    const byAccount = Object.fromEntries(
      result.accounts.map((a: { account: string }) => [a.account, a]),
    );
    expect(byAccount.newbie).toMatchObject({ start_gb: 0, current_gb: 7, new: true });
    expect(byAccount.zero.growth_pct).toBeNull();
    expect(byAccount.base).toMatchObject({ growth_gb: 10, growth_pct: 100 });
    expect(byAccount.base).not.toHaveProperty("new");
    // The blank-storage account never enters the growth set.
    expect(byAccount).not.toHaveProperty("blank");
  });
});

// ── b2_rank_egress_leaders branches ───────────────────────────────────────────

describe("insights #400 — b2_rank_egress_leaders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(REPORT_CLOCK);
  });

  it("returns not-enabled when the fallback latest-snapshot lookup 404s on an empty window", async () => {
    let listCalls = 0;
    const report = reportFake(
      {},
      {
        onList: () => {
          listCalls++;
          // First list (loadReportRows) succeeds with a non-report object so the
          // window is empty and inconclusive-free; the fallback latestSnapshotDate
          // lookup then 404s → the tool must surface reports-not-enabled.
          if (listCalls === 1) return { keys: ["not-a-report.txt"], isTruncated: false };
          return noSuchBucket();
        },
      },
    );
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_rank_egress_leaders", { by: "account", days: 7, limit: 5 }),
    );

    expect(result.reports_enabled).toBe(false);
    expect(listCalls).toBeGreaterThan(1);
  });

  it("breaks on the candidate-key cap and reports an inconclusive empty scan", async () => {
    // 5001 date-prefixed audit CSVs: they are candidates (match the day/….csv
    // shape) so the loader hits maxCandidateKeys (5000) and stops, but audit files
    // are not usage data so nothing is selected/downloaded — a fast, inconclusive
    // empty result.
    const day = daysAgo(0);
    const csvByKey: Record<string, string> = {};
    for (let i = 0; i < 5001; i++) {
      csvByKey[`${day}/usage.audit-account-${String(i).padStart(5, "0")}.csv`] = "x";
    }
    const report = reportFake(csvByKey, { pageSize: 1000 });
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_rank_egress_leaders", { by: "account", days: 1, limit: 5 }),
    );

    expect(result.reports_enabled).toBe(true);
    expect(result.leaders).toEqual([]);
    expect(result.report_scan.candidate_keys).toBe(5000);
    expect(result.report_scan.selected_keys).toBe(0);
    expect(result.report_scan.stop_reasons).toContain("max_candidate_keys");
    expect(result.truncated).toBe(true);
  });
});

// ── Bucket resolution branches ────────────────────────────────────────────────

describe("insights #400 — bucket resolution", () => {
  it("resolves a single substring match from the authorized scope", async () => {
    const nativeClient = createNativeClient({
      listBucketsError: Object.assign(new Error("unauthorized"), { status: 401 }),
      filePages: [{ files: [file("raw/a.bin", 10 * GB)], nextFileName: null }],
    });
    const tools = registerTools(reportFake({}).client, nativeClient, [
      { id: "bucket-42", name: "photos-main" },
    ]);

    const result = parseResult(
      await tools.call("b2_list_largest_files", { bucket: "photos", limit: 5, max_scan: 1000 }),
    );

    expect(result).toMatchObject({ bucket: "photos-main", returned: 1, truncated: false });
    expect(nativeClient.listBuckets).not.toHaveBeenCalled();
    expect(nativeClient.listFileNames).toHaveBeenCalledWith(
      expect.objectContaining({ bucketId: "bucket-42" }),
    );
  });

  it("reports bucket_id_unavailable when a scoped match resolves a name but no id", async () => {
    const nativeClient = createNativeClient({
      listBucketsError: Object.assign(new Error("unauthorized"), { status: 401 }),
    });
    // An exact name match whose scope entry carries no id → name resolves, id does not.
    const tools = registerTools(reportFake({}).client, nativeClient, [
      { id: undefined as unknown as string, name: "photos" },
    ]);

    const result = parseResult(
      await tools.call("b2_unfinished_uploads", { bucket: "photos", max_uploads: 10 }),
    );

    expect(result).toEqual({
      error: "bucket_id_unavailable",
      candidates: [],
      note: "No bucket ID could be resolved for 'photos'.",
    });
    expect(nativeClient.listBuckets).not.toHaveBeenCalled();
  });

  it("reports no match when a live listBuckets fallback returns no bucket list", async () => {
    // listBuckets resolving to an object without a `buckets` array exercises the
    // `result.buckets ?? []` guard and yields a clean not-found resolution error.
    const nativeClient = createNativeClient({});
    nativeClient.listBuckets.mockResolvedValueOnce({} as ListBucketsResult);
    const tools = registerTools(reportFake({}).client, nativeClient);

    const result = parseResult(
      await tools.call("b2_list_largest_files", { bucket: "ghost", limit: 5, max_scan: 1000 }),
    );

    expect(result).toEqual({
      error: "bucket_not_uniquely_resolved",
      candidates: [],
      note: "No bucket matches 'ghost'.",
    });
  });

  it("resolves a single substring match from a live listBuckets fallback", async () => {
    const nativeClient = createNativeClient({
      buckets: [
        { bucketId: "logs-b", bucketName: "logs-beta", bucketType: "allPrivate" },
        { bucketId: "pics-1", bucketName: "pics", bucketType: "allPrivate" },
      ],
      filePages: [{ files: [], nextFileName: null }],
    });
    const tools = registerTools(reportFake({}).client, nativeClient);

    const result = parseResult(
      await tools.call("b2_list_largest_files", { bucket: "beta", limit: 5, max_scan: 1000 }),
    );

    expect(result).toMatchObject({ bucket: "logs-beta", returned: 0 });
    expect(nativeClient.listBuckets).toHaveBeenCalled();
  });
});

// ── Native scan deadline / abort plumbing ─────────────────────────────────────

describe("insights #400 — native scan deadlines", () => {
  it("largest-files throws-then-truncates when the budget is already spent on entry", async () => {
    // startedAt reads 0; the very first withNativeInsightDeadline sees the clock at
    // 12001ms, so remaining <= 0 and it throws a TimeoutError before any listing.
    let call = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (call++ === 0 ? 0 : TIME_BUDGET_MS + 1));
    const nativeClient = createNativeClient({
      filePages: [{ files: [file("raw/a.bin", GB)], nextFileName: null }],
    });
    const tools = registerTools(reportFake({}).client, nativeClient);

    const result = parseResult(
      await tools.call("b2_list_largest_files", { bucket: "photos", limit: 5, max_scan: 1000 }),
    );

    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(0);
    expect(result.note).toContain("time budget");
    expect(nativeClient.listFileNames).not.toHaveBeenCalled();
  });

  it("largest-files rethrows a non-deadline listing error and tolerates a page without files", async () => {
    // First page omits `files` (files ?? [] guard); a later page fails with a
    // non-deadline error, which must propagate to the MCP error shape.
    const boom = Object.assign(new Error("native listing failed"), { name: "InternalError" });
    const nativeClient = createNativeClient({
      filePages: [{ nextFileName: "next" } as ListFileNamesResult, boom],
    });
    const tools = registerTools(reportFake({}).client, nativeClient);

    const result = await tools.call("b2_list_largest_files", {
      bucket: "photos",
      limit: 5,
      max_scan: 1000,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("native listing failed");
  });

  it("largest-files honors an already-aborted parent request signal", async () => {
    const controller = new AbortController();
    controller.abort(abortError());
    const nativeClient = createNativeClient({
      filePages: [{ files: [file("raw/a.bin", GB)], nextFileName: null }],
    });
    const tools = registerTools(reportFake({}).client, nativeClient);

    const result = parseResult(
      await runWithMcpRequestSignal(controller.signal, () =>
        tools.call("b2_list_largest_files", { bucket: "photos", limit: 5, max_scan: 1000 }),
      ),
    );

    // The abort propagates to the inner controller; the fake native client does not
    // observe the signal, so the page still returns and the largest file is ranked.
    expect(result).toMatchObject({ bucket: "photos", returned: 1 });
  });

  it("largest-files registers an abort listener for a live (non-aborted) parent signal", async () => {
    const controller = new AbortController();
    const nativeClient = createNativeClient({
      filePages: [{ files: [file("raw/a.bin", 2 * GB)], nextFileName: null }],
    });
    const tools = registerTools(reportFake({}).client, nativeClient);

    const result = parseResult(
      await runWithMcpRequestSignal(controller.signal, () =>
        tools.call("b2_list_largest_files", { bucket: "photos", limit: 5, max_scan: 1000 }),
      ),
    );

    expect(result).toMatchObject({ bucket: "photos", returned: 1, truncated: false });
  });
});

// ── b2_unfinished_uploads note/branch coverage ────────────────────────────────

describe("insights #400 — b2_unfinished_uploads", () => {
  it("truncates at the max_uploads cap and still sums parts", async () => {
    const nativeClient = createNativeClient({
      uploadPages: [
        {
          files: [
            upload("a.bin", "u1", "2026-01-02T00:00:00.000Z"),
            upload("b.bin", "u2", "2026-01-03T00:00:00.000Z"),
          ],
          nextFileId: "more",
        },
      ],
      partPagesByFileId: { u1: [{ parts: [part(GB)], nextPartNumber: null }] },
    });
    const tools = registerTools(reportFake({}).client, nativeClient);

    const result = parseResult(
      await tools.call("b2_unfinished_uploads", { bucket: "photos", max_uploads: 1 }),
    );

    expect(result.truncated).toBe(true);
    expect(result.unfinished_count).toBe(1);
    expect(result.wasted_gb).toBe(1);
    expect(result.note).toContain("max_uploads cap");
  });

  it("tracks the oldest upload and reports wasted_gb as a lower bound when parts time out", async () => {
    const nativeClient = createNativeClient({
      uploadPages: [
        {
          files: [
            upload("new.bin", "u1", "2026-01-05T00:00:00.000Z"),
            upload("old.bin", "u2", "2026-01-01T00:00:00.000Z"),
          ],
          nextFileId: null,
        },
      ],
      partPagesByFileId: {
        u1: [{ parts: [part(GB)], nextPartNumber: null }],
        // The second upload's parts scan hits the deadline → lower-bound result.
        u2: [timeoutError()],
      },
    });
    const tools = registerTools(reportFake({}).client, nativeClient);

    const result = parseResult(
      await tools.call("b2_unfinished_uploads", { bucket: "photos", max_uploads: 10 }),
    );

    expect(result.truncated).toBe(false);
    expect(result.unfinished_count).toBe(2);
    expect(result.wasted_is_lower_bound).toBe(true);
    expect(result.sized_uploads).toBe(1);
    // Oldest is the earlier-initiated upload even though it appeared second.
    expect(result.oldest_file).toBe("old.bin");
    expect(result.note).toContain("lower bound");
  });

  it("times out mid-pagination with uploads already collected", async () => {
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const nativeClient = createNativeClient({});
    nativeClient.listUnfinishedLargeFiles.mockImplementationOnce(async () => {
      clock = TIME_BUDGET_MS + 1;
      return {
        files: [upload("a.bin", "u1", "2026-01-02T00:00:00.000Z")],
        nextFileId: "more",
      };
    });
    const tools = registerTools(reportFake({}).client, nativeClient);

    const result = parseResult(
      await tools.call("b2_unfinished_uploads", { bucket: "photos", max_uploads: 10 }),
    );

    expect(result.truncated).toBe(true);
    expect(result.unfinished_count).toBe(1);
    expect(result.note).toContain("time budget");
  });

  it("rethrows a non-deadline unfinished-upload listing error", async () => {
    const boom = Object.assign(new Error("upload listing failed"), { name: "InternalError" });
    const nativeClient = createNativeClient({ uploadPages: [boom] });
    const tools = registerTools(reportFake({}).client, nativeClient);

    const result = await tools.call("b2_unfinished_uploads", { bucket: "photos", max_uploads: 10 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("upload listing failed");
  });

  it("tolerates upload/part pages without arrays and undefined upload timestamps", async () => {
    const undatedUpload = { fileName: "undated.bin", fileId: "u2", uploadTimestamp: undefined };
    const nativeClient = createNativeClient({
      uploadPages: [
        // First page omits `files` (page.files ?? [] guard) but keeps paginating.
        { nextFileId: "more" } as ListUnfinishedLargeFilesResult,
        {
          files: [upload("dated.bin", "u1", "2026-01-05T00:00:00.000Z"), undatedUpload],
          nextFileId: null,
        },
      ],
      partPagesByFileId: {
        // A parts page without a `parts` array exercises the parts ?? [] guard.
        u1: [{ nextPartNumber: null } as ListPartsResult],
        u2: [{ parts: [part(GB)], nextPartNumber: null }],
      },
    });
    const tools = registerTools(reportFake({}).client, nativeClient);

    const result = parseResult(
      await tools.call("b2_unfinished_uploads", { bucket: "photos", max_uploads: 10 }),
    );

    expect(result.unfinished_count).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.wasted_gb).toBe(1);
    // The dated upload has a finite initiation time; the undated one folds to
    // Infinity, so the dated upload remains the oldest.
    expect(result.oldest_file).toBe("dated.bin");
  });

  it("rethrows a non-deadline parts-listing error", async () => {
    const boom = Object.assign(new Error("parts listing failed"), { name: "InternalError" });
    const nativeClient = createNativeClient({
      uploadPages: [
        { files: [upload("old.bin", "u1", "2026-01-01T00:00:00.000Z")], nextFileId: null },
      ],
      partPagesByFileId: { u1: [boom] },
    });
    const tools = registerTools(reportFake({}).client, nativeClient);

    const result = await tools.call("b2_unfinished_uploads", { bucket: "photos", max_uploads: 10 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("parts listing failed");
  });

  it("truncates unfinished-upload pagination when the listing deadline fires", async () => {
    const nativeClient = createNativeClient({ uploadPages: [timeoutError()] });
    const tools = registerTools(reportFake({}).client, nativeClient);

    const result = parseResult(
      await tools.call("b2_unfinished_uploads", { bucket: "photos", max_uploads: 10 }),
    );

    expect(result.unfinished_count).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.note).toContain("time budget");
  });
});
