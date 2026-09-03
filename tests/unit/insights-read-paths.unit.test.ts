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
import { registerInsightTools } from "../../src/b2/insights";
import type {
  ListReportObjectKeysOptions,
  ReportObjectClient,
  ReportObjectPage,
  ReportObjectText,
} from "../../src/b2/report-client";
import { parseResult, ToolHarness } from "../support/deterministic-fakes";

const GB = 1e9;
const DAY_MS = 86400_000;
const REPORT_CLOCK = new Date("2026-01-31T12:00:00.000Z");
// Mirrors the private 12s scan budget in src/b2/insights.ts; +1 trips the deadline branch.
const AFTER_SCAN_TIME_BUDGET_MS = 12_001;
const bucket: BucketInfoResult = {
  bucketId: "bucket-1",
  bucketName: "photos",
  bucketType: "allPrivate",
};

type ReportFixture = {
  calls: Array<{ bucketName: string; options: ListReportObjectKeysOptions }>;
  downloaded: string[];
  client: ReportObjectClient;
};

type NativeInsightClient = Pick<
  B2Client,
  "listBuckets" | "listFileNames" | "listUnfinishedLargeFiles" | "listParts"
>;

type NativeClientOptions = {
  buckets?: BucketInfoResult[];
  listBucketsError?: Error;
  filePages?: Array<ListFileNamesResult | Error>;
  uploadPages?: Array<ListUnfinishedLargeFilesResult | Error>;
  partPagesByFileId?: Record<string, Array<ListPartsResult | Error>>;
};

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

function csv(rows: string[]): string {
  return (
    "account_id,date,bucket_id,bucket_name,stored_gb,downloaded_gb,uploaded_gb,api_txn_class_c\n" +
    rows.join("")
  );
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

function createPagedReportClient(
  csvByKey: Record<string, string>,
  options: { pageSize?: number; listError?: Error } = {},
): ReportFixture {
  const calls: ReportFixture["calls"] = [];
  const downloaded: string[] = [];
  const allKeys = Object.keys(csvByKey).sort();
  return {
    calls,
    downloaded,
    client: {
      async listReportObjectKeys(
        bucketName: string,
        input: ListReportObjectKeysOptions = {},
      ): Promise<ReportObjectPage> {
        calls.push({ bucketName, options: input });
        if (options.listError) throw options.listError;
        let keys = allKeys;
        const { prefix, startAfter } = input;
        if (prefix) keys = keys.filter((key) => key.startsWith(prefix));
        if (startAfter) keys = keys.filter((key) => key > startAfter);
        const offset = input.continuationToken ? Number(input.continuationToken) : 0;
        const requested = input.maxKeys ?? keys.length;
        const pageSize = Math.min(options.pageSize ?? requested, requested);
        const page = keys.slice(offset, offset + pageSize);
        const nextOffset = offset + page.length;
        return {
          keys: page,
          isTruncated: nextOffset < keys.length,
          nextContinuationToken: nextOffset < keys.length ? String(nextOffset) : undefined,
        };
      },
      async downloadReportObjectText(_bucketName: string, key: string): Promise<ReportObjectText> {
        downloaded.push(key);
        const text = csvByKey[key] ?? "";
        return { text, bytes: Buffer.byteLength(text, "utf8"), truncated: false };
      },
    },
  };
}

function createNativeClient(options: NativeClientOptions) {
  const filePages = [...(options.filePages ?? [])];
  const uploadPages = [...(options.uploadPages ?? [])];
  const partPagesByFileId: Record<string, Array<ListPartsResult | Error>> = {};
  for (const [fileId, pages] of Object.entries(options.partPagesByFileId ?? {})) {
    partPagesByFileId[fileId] = [...pages];
  }
  return {
    listBuckets: vi.fn(async (_input: BucketFilters = {}): Promise<ListBucketsResult> => {
      if (options.listBucketsError) throw options.listBucketsError;
      return { buckets: options.buckets ?? [bucket] };
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

function registerTools(
  reportClient: ReportObjectClient,
  nativeClient: NativeInsightClient = createNativeClient({}),
  allowedBuckets?: Array<{ id: string; name: string | null }> | null,
) {
  const harness = new ToolHarness();
  registerInsightTools(
    harness,
    nativeClient as B2Client,
    { getAuth: async () => ({ accountId: "test-account", allowedBuckets }) } as Parameters<
      typeof registerInsightTools
    >[2],
    reportClient,
  );
  return harness;
}

function file(fileName: string, contentLength: number): FileVersionResult {
  return {
    fileName,
    contentLength,
    uploadTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
  };
}

function upload(fileName: string, fileId: string, isoDate: string): UnfinishedLargeFileResult {
  return {
    fileName,
    fileId,
    uploadTimestamp: Date.parse(isoDate),
  };
}

function part(contentLength: number, partNumber = 1): PartInfoResult {
  return { partNumber, contentLength };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("insight usage-report read paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(REPORT_CLOCK);
  });

  it("returns not-enabled metadata when b2_report_usage_growth cannot list the report bucket", async () => {
    const report = createPagedReportClient({}, { listError: noSuchBucket() });
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_report_usage_growth", { period: "month", order: "most_grown", limit: 10 }),
    );

    expect(result.reports_enabled).toBe(false);
    expect(result.note).toContain("No b2-reports");
  });

  it("returns a clean empty-snapshot result for b2_report_usage_growth", async () => {
    const report = createPagedReportClient({});
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_report_usage_growth", { period: "month", order: "most_grown", limit: 10 }),
    );

    expect(result.reports_enabled).toBe(true);
    expect(result.note).toContain("No usage-report snapshots found in the last 180 days");
    expect(result.searched_since).toBe(daysAgo(180));
    expect(result.report_scan.pages).toEqual(expect.any(Number));
    expect(result.report_scan.pages).toBeGreaterThan(0);
  });

  it("reports insufficient history when only the latest snapshot exists", async () => {
    const latest = daysAgo(1);
    const report = createPagedReportClient({
      [`${latest}/usage.account-a.csv`]: csv([`account-a,${latest},bucket-a,bucket-a,10,0,0,0\n`]),
    });
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_report_usage_growth", {
        days: 30,
        period: "month",
        order: "most_grown",
        limit: 10,
      }),
    );

    expect(result.reports_enabled).toBe(true);
    expect(result.latest_snapshot).toBe(latest);
    expect(result.note).toContain("Not enough report history");
  });

  it("applies b2_report_usage_growth ranking modes and limits across two snapshots", async () => {
    const thenDay = daysAgo(30);
    const latest = daysAgo(1);
    const report = createPagedReportClient({
      [`${thenDay}/usage.account-then.csv`]: csv([
        `grow,${thenDay},bucket-grow,bucket-grow,10,0,0,0\n`,
        `flat,${thenDay},bucket-flat,bucket-flat,10,0,0,0\n`,
        `shrink,${thenDay},bucket-shrink,bucket-shrink,20,0,0,0\n`,
      ]),
      [`${latest}/usage.account-now.csv`]: csv([
        `grow,${latest},bucket-grow,bucket-grow,20,0,0,0\n`,
        `flat,${latest},bucket-flat,bucket-flat,10,0,0,0\n`,
        `shrink,${latest},bucket-shrink,bucket-shrink,5,0,0,0\n`,
        `new-account,${latest},bucket-new,bucket-new,7,0,0,0\n`,
      ]),
    });
    const tools = registerTools(report.client);

    const shrinking = parseResult(
      await tools.call("b2_report_usage_growth", {
        days: 30,
        period: "month",
        order: "shrinking",
        limit: 10,
      }),
    );
    const leastGrown = parseResult(
      await tools.call("b2_report_usage_growth", {
        days: 30,
        period: "month",
        order: "least_grown",
        limit: 2,
      }),
    );

    expect(shrinking.comparison).toBe("last 30 days");
    expect(shrinking.accounts).toEqual([
      expect.objectContaining({ account: "shrink", growth_gb: -15, growth_pct: -75 }),
    ]);
    expect(leastGrown.account_count).toBe(2);
    expect(leastGrown.accounts.map((account: { account: string }) => account.account)).toEqual([
      "shrink",
      "flat",
    ]);
  });

  it.each([
    [{ by: "account" as const, days: 30, limit: 5 }, "last 30 days"],
    [{ by: "bucket" as const, limit: 5 }, "current month to date"],
  ])("returns a clean empty-snapshot result for b2_rank_egress_leaders", async (args, period) => {
    const report = createPagedReportClient({});
    const tools = registerTools(report.client);

    const result = parseResult(await tools.call("b2_rank_egress_leaders", args));

    expect(result.period).toBe(period);
    expect(result.rank_by).toBe(args.by);
    expect(result.reports_enabled).toBe(true);
    expect(result.note).toContain("No usage-report snapshots found in the last 180 days");
    expect(result.searched_since).toBe(daysAgo(180));
    expect(result).not.toHaveProperty("total_egress_gb");
    expect(result.leaders).toEqual([]);
    expect(result.report_scan.pages).toEqual(expect.any(Number));
    expect(result.report_scan.pages).toBeGreaterThan(0);
    expect(result.report_scan.listed_keys).toBe(0);
    expect(result.report_scan.parsed_rows).toBe(0);
  });

  it("keeps empty b2_rank_egress_leaders scans inconclusive when truncated", async () => {
    const day = daysAgo(1);
    const report = createPagedReportClient(
      Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => [
          `${day}/notes-${String(index).padStart(3, "0")}.txt`,
          "ignored",
        ]),
      ),
      { pageSize: 1 },
    );
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_rank_egress_leaders", { by: "account", days: 7, limit: 5 }),
    );

    expect(result.reports_enabled).toBe(true);
    expect(result.note).toContain("inconclusive");
    expect(result.note).toContain("scan budget");
    expect(result).not.toHaveProperty("total_egress_gb");
    expect(result.leaders).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.report_scan.selected_keys).toBe(0);
    expect(result.report_scan.stop_reasons).toEqual(["max_pages"]);
  });

  it("distinguishes an empty b2_rank_egress_leaders window from no snapshots yet", async () => {
    const staleDay = daysAgo(31);
    const report = createPagedReportClient({
      [`${staleDay}/usage.account-stale.csv`]: csv([
        `stale,${staleDay},bucket-stale,bucket-stale,1,4,0,0\n`,
      ]),
    });
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_rank_egress_leaders", { by: "account", days: 30, limit: 5 }),
    );

    expect(result.reports_enabled).toBe(true);
    expect(result.note).toContain("requested period");
    expect(result.note).toContain(staleDay);
    expect(result.latest_snapshot).toBe(staleDay);
    expect(result).not.toHaveProperty("total_egress_gb");
    expect(result.leaders).toEqual([]);
  });

  it("does not treat non-usage date-prefixed objects as b2_rank_egress_leaders snapshots", async () => {
    const day = daysAgo(2);
    const report = createPagedReportClient({
      [`${day}/notes.txt`]: "not a usage report",
      [`${day}/usage.audit-account-a.csv`]: csv([`a,${day},bucket-a,bucket-a,1,4,0,0\n`]),
    });
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_rank_egress_leaders", { by: "account", days: 7, limit: 5 }),
    );

    expect(result.reports_enabled).toBe(true);
    expect(result.note).toContain("No usage-report snapshots found in the last 180 days");
    expect(result.note).not.toContain("Report snapshots exist");
    expect(result.searched_since).toBe(daysAgo(180));
    expect(result).not.toHaveProperty("latest_snapshot");
    expect(result).not.toHaveProperty("total_egress_gb");
    expect(result.leaders).toEqual([]);
  });

  it("qualifies b2_rank_egress_leaders with the horizon when snapshots predate 180 days", async () => {
    const ancientDay = daysAgo(200);
    const report = createPagedReportClient({
      [`${ancientDay}/usage.account-old.csv`]: csv([
        `old,${ancientDay},bucket-old,bucket-old,1,4,0,0\n`,
      ]),
    });
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_rank_egress_leaders", { by: "account", days: 30, limit: 5 }),
    );

    expect(result.reports_enabled).toBe(true);
    expect(result.note).toContain("No usage-report snapshots found in the last 180 days");
    expect(result.note).not.toContain("found yet");
    expect(result.searched_since).toBe(daysAgo(180));
    expect(result).not.toHaveProperty("latest_snapshot");
    expect(result).not.toHaveProperty("total_egress_gb");
    expect(result.leaders).toEqual([]);
  });

  it("qualifies b2_report_usage_growth with the horizon when snapshots predate 180 days", async () => {
    const ancientDay = daysAgo(200);
    const report = createPagedReportClient({
      [`${ancientDay}/usage.account-old.csv`]: csv([
        `old,${ancientDay},bucket-old,bucket-old,1,4,0,0\n`,
      ]),
    });
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_report_usage_growth", { period: "month", order: "most_grown", limit: 10 }),
    );

    expect(result.reports_enabled).toBe(true);
    expect(result.note).toContain("No usage-report snapshots found in the last 180 days");
    expect(result.note).not.toContain("found yet");
    expect(result.searched_since).toBe(daysAgo(180));
  });

  it("keeps b2_report_usage_growth inconclusive when latest-snapshot discovery is truncated", async () => {
    const report = createPagedReportClient(
      Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => {
          const day = daysAgo(1 + (index % 9));
          return [
            `${day}/usage.account-${String(index).padStart(3, "0")}.csv`,
            csv([`acct-${index},${day},bucket-a,bucket-a,1,4,0,0\n`]),
          ];
        }),
      ),
      { pageSize: 1 },
    );
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_report_usage_growth", { period: "month", order: "most_grown", limit: 10 }),
    );

    expect(result.reports_enabled).toBe(true);
    expect(result.note).toContain("inconclusive");
    expect(result).not.toHaveProperty("latest_snapshot");
    expect(result).not.toHaveProperty("comparison");
    expect(result.truncated).toBe(true);
    expect(result.report_scan.stop_reasons).toEqual(["max_pages"]);
  });

  it("omits latest_snapshot when empty b2_rank_egress_leaders discovery is truncated", async () => {
    const staleDay = daysAgo(2);
    const report = createPagedReportClient(
      Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => [
          `${staleDay}/usage.account-${String(index).padStart(3, "0")}.csv`,
          csv([`stale-${index},${staleDay},bucket-stale,bucket-stale,1,4,0,0\n`]),
        ]),
      ),
      { pageSize: 1 },
    );
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_rank_egress_leaders", { by: "account", days: 1, limit: 5 }),
    );

    expect(result.reports_enabled).toBe(true);
    expect(result.note).toContain("inconclusive");
    expect(result).not.toHaveProperty("latest_snapshot");
    expect(result).not.toHaveProperty("total_egress_gb");
    expect(result.leaders).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.report_scan.stop_reasons).toEqual(["max_pages"]);
  });

  it("does not report measured zero when b2_rank_egress_leaders parses no usage rows", async () => {
    const day = daysAgo(1);
    const report = createPagedReportClient({
      [`${day}/usage.account-empty.csv`]: "",
    });
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_rank_egress_leaders", { by: "account", days: 7, limit: 5 }),
    );

    expect(result.reports_enabled).toBe(true);
    expect(result.note).toContain("no parseable usage rows");
    expect(result).not.toHaveProperty("total_egress_gb");
    expect(result.leaders).toEqual([]);
    expect(result.report_scan.selected_keys).toBe(1);
    expect(result.report_scan.parsed_rows).toBe(0);
  });

  it("paginates b2_rank_egress_leaders report keys and skips empty or malformed CSV rows", async () => {
    const oldDay = daysAgo(120);
    const dayOne = daysAgo(3);
    const dayTwo = daysAgo(2);
    const report = createPagedReportClient(
      {
        [`${oldDay}/usage.account-old.csv`]: csv([
          `old,${oldDay},bucket-old,bucket-old,1,99,0,0\n`,
        ]),
        [`${dayOne}/notes.txt`]: "ignored",
        [`${dayOne}/usage.audit-account-a.csv`]: csv([
          `audit,${dayOne},bucket-a,bucket-a,1,99,0,0\n`,
        ]),
        [`${dayOne}/usage.account-a.csv`]: csv([
          `account-a,${dayOne},bucket-a,bucket-a,1,2,0,0\n`,
          `,${dayOne},bucket-bad,bucket-bad,1,50,0,0\n`,
        ]),
        [`${dayTwo}/usage.account-empty.csv`]: "",
        [`${dayTwo}/usage.group-1.reportingLocations.csv`]: csv([
          `index,${dayTwo},bucket-index,bucket-index,1,99,0,0\n`,
        ]),
        [`${dayTwo}/usage.account-c.csv`]: csv([`account-c,${dayTwo},bucket-c,bucket-c,1,8,0,0\n`]),
      },
      { pageSize: 2 },
    );
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_rank_egress_leaders", { by: "account", days: 90, limit: 2 }),
    );

    expect(result.period).toBe("last 90 days");
    expect(result.leaders).toEqual([
      { account: "account-c", egress_gb: 8, share_pct: 80 },
      { account: "account-a", egress_gb: 2, share_pct: 20 },
    ]);
    expect(result.report_scan.pages).toBeGreaterThan(1);
    expect(report.calls.some((call) => call.options.continuationToken)).toBe(true);
    expect(report.downloaded).toEqual([
      `${dayOne}/usage.account-a.csv`,
      `${dayTwo}/usage.account-c.csv`,
      `${dayTwo}/usage.account-empty.csv`,
    ]);
  });

  it("returns zero share for b2_rank_egress_leaders when total egress is zero", async () => {
    const day = daysAgo(1);
    const report = createPagedReportClient({
      [`${day}/usage.account-zero.csv`]: csv([`zero,${day},bucket-zero,,1,0,0,0\n`]),
    });
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_rank_egress_leaders", { by: "bucket", days: 7, limit: 1 }),
    );

    expect(result.total_egress_gb).toBe(0);
    expect(result.leaders).toEqual([{ bucket: "bucket-zero", egress_gb: 0, share_pct: 0 }]);
  });

  it("returns not-enabled metadata when b2_rank_egress_leaders cannot list the report bucket", async () => {
    const report = createPagedReportClient({}, { listError: noSuchBucket() });
    const tools = registerTools(report.client);

    const result = parseResult(
      await tools.call("b2_rank_egress_leaders", { by: "account", days: 7, limit: 5 }),
    );

    expect(result.reports_enabled).toBe(false);
  });

  it("maps report read failures to the MCP error shape", async () => {
    const report = createPagedReportClient(
      {},
      {
        listError: Object.assign(new Error("report service failed"), {
          name: "InternalError",
          $metadata: { httpStatusCode: 500 },
        }),
      },
    );
    const tools = registerTools(report.client);

    const result = await tools.call("b2_rank_egress_leaders", { by: "account", days: 7, limit: 5 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("report service failed");
  });
});

describe("insight native bucket read paths", () => {
  it.each([
    ["b2_list_largest_files", { bucket: "missing", limit: 5, max_scan: 1000 }],
    ["b2_unfinished_uploads", { bucket: "missing", max_uploads: 10 }],
  ])("%s returns a bucket-resolution failure for an unknown bucket", async (toolName, args) => {
    const tools = registerTools(
      createPagedReportClient({}).client,
      createNativeClient({ buckets: [] }),
    );

    const result = parseResult(await tools.call(toolName, args));

    expect(result).toEqual({
      error: "bucket_not_uniquely_resolved",
      candidates: [],
      note: "No bucket matches 'missing'.",
    });
  });

  it("returns candidate buckets when b2_list_largest_files receives an ambiguous bucket name", async () => {
    const nativeClient = createNativeClient({
      buckets: [
        { bucketId: "logs-a", bucketName: "logs-alpha", bucketType: "allPrivate" },
        { bucketId: "logs-b", bucketName: "logs-beta", bucketType: "allPrivate" },
      ],
    });
    const tools = registerTools(createPagedReportClient({}).client, nativeClient);

    const result = parseResult(
      await tools.call("b2_list_largest_files", { bucket: "logs", limit: 5, max_scan: 1000 }),
    );

    expect(result.error).toBe("bucket_not_uniquely_resolved");
    expect(result.candidates).toEqual(["logs-alpha", "logs-beta"]);
  });

  it("resolves a bucket-scoped key from its authorized scope without listBuckets", async () => {
    // A bucket-scoped key cannot call the unfiltered listBuckets() — B2 answers
    // 401 — so the tool must resolve from the authorize response's allowedBuckets.
    const nativeClient = createNativeClient({
      listBucketsError: Object.assign(new Error("unauthorized"), { status: 401 }),
      filePages: [{ files: [file("raw/a.bin", 10 * GB)], nextFileName: null }],
    });
    const tools = registerTools(createPagedReportClient({}).client, nativeClient, [
      { id: "bucket-1", name: "photos" },
    ]);

    const result = parseResult(
      await tools.call("b2_list_largest_files", { bucket: "photos", limit: 5, max_scan: 1000 }),
    );

    expect(result).toMatchObject({ bucket: "photos", returned: 1, truncated: false });
    expect(nativeClient.listBuckets).not.toHaveBeenCalled();
    expect(nativeClient.listFileNames).toHaveBeenCalledWith(
      expect.objectContaining({ bucketId: "bucket-1" }),
    );
  });

  it("resolves a scoped bucket by bucketId even when its name is unknown", async () => {
    const nativeClient = createNativeClient({
      listBucketsError: Object.assign(new Error("unauthorized"), { status: 401 }),
      uploadPages: [{ files: [], nextFileId: null }],
    });
    const tools = registerTools(createPagedReportClient({}).client, nativeClient, [
      { id: "bucket-1", name: null },
    ]);

    const result = parseResult(
      await tools.call("b2_unfinished_uploads", { bucket: "bucket-1", max_uploads: 10 }),
    );

    expect(result).toMatchObject({ bucket: "bucket-1", unfinished_count: 0 });
    expect(nativeClient.listBuckets).not.toHaveBeenCalled();
    expect(nativeClient.listUnfinishedLargeFiles).toHaveBeenCalledWith(
      expect.objectContaining({ bucketId: "bucket-1" }),
    );
  });

  it("reports out-of-scope without enumerating the key's scope for an unrelated bucket", async () => {
    // A bogus, fully-unrelated name must NOT echo the credential's whole bucket
    // scope back — that would let a server/principal HTTP caller enumerate every
    // in-scope bucket with one request. Expect an out-of-scope note, no candidates.
    const nativeClient = createNativeClient({
      listBucketsError: Object.assign(new Error("unauthorized"), { status: 401 }),
    });
    const tools = registerTools(createPagedReportClient({}).client, nativeClient, [
      { id: "bucket-1", name: "photos" },
      { id: "bucket-2", name: "invoices" },
    ]);

    const result = parseResult(
      await tools.call("b2_list_largest_files", {
        bucket: "zzz-does-not-exist",
        limit: 5,
        max_scan: 1000,
      }),
    );

    expect(result.error).toBe("bucket_not_uniquely_resolved");
    expect(result.candidates).toEqual([]);
    expect(result.note).toBe(
      "Bucket 'zzz-does-not-exist' is not in the key's authorized scope (or does not exist).",
    );
    expect(result.note).not.toContain("photos");
    expect(result.note).not.toContain("invoices");
    expect(nativeClient.listBuckets).not.toHaveBeenCalled();
  });

  it("treats an empty scoped bucket input as a miss, not a full-scope enumeration", async () => {
    // Every non-null name satisfies name.includes(""), so a blank input must be a
    // miss rather than dump the whole authorized namespace back to the caller.
    const nativeClient = createNativeClient({
      listBucketsError: Object.assign(new Error("unauthorized"), { status: 401 }),
    });
    const tools = registerTools(createPagedReportClient({}).client, nativeClient, [
      { id: "bucket-1", name: "photos" },
      { id: "bucket-2", name: "invoices" },
    ]);

    const result = parseResult(
      await tools.call("b2_unfinished_uploads", { bucket: "", max_uploads: 10 }),
    );

    expect(result.error).toBe("bucket_not_uniquely_resolved");
    expect(result.candidates).toEqual([]);
    expect(result.note).not.toContain("photos");
    expect(result.note).not.toContain("invoices");
    expect(nativeClient.listBuckets).not.toHaveBeenCalled();
  });

  it("surfaces only partially-matching in-scope names for an ambiguous scoped input", async () => {
    const nativeClient = createNativeClient({
      listBucketsError: Object.assign(new Error("unauthorized"), { status: 401 }),
    });
    const tools = registerTools(createPagedReportClient({}).client, nativeClient, [
      { id: "logs-a", name: "logs-alpha" },
      { id: "logs-b", name: "logs-beta" },
      { id: "photos-1", name: "photos" },
    ]);

    const result = parseResult(
      await tools.call("b2_list_largest_files", { bucket: "logs", limit: 5, max_scan: 1000 }),
    );

    expect(result.error).toBe("bucket_not_uniquely_resolved");
    expect(result.candidates).toEqual(["logs-alpha", "logs-beta"]);
    expect(result.note).toBe("Multiple buckets match; pass an exact name or bucketId.");
    expect(nativeClient.listBuckets).not.toHaveBeenCalled();
  });

  it("returns an empty b2_list_largest_files result and passes the prefix filter", async () => {
    const nativeClient = createNativeClient({
      filePages: [{ files: [], nextFileName: null }],
    });
    const tools = registerTools(createPagedReportClient({}).client, nativeClient);

    const result = parseResult(
      await tools.call("b2_list_largest_files", {
        bucket: "photos",
        prefix: "raw/",
        limit: 5,
        max_scan: 1000,
      }),
    );

    expect(result).toMatchObject({ bucket: "photos", scanned: 0, returned: 0, truncated: false });
    expect(nativeClient.listFileNames).toHaveBeenCalledWith(
      expect.objectContaining({ bucketId: "bucket-1", prefix: "raw/" }),
    );
  });

  it("marks b2_list_largest_files as truncated when the listing deadline fires", async () => {
    const nativeClient = createNativeClient({ filePages: [timeoutError()] });
    const tools = registerTools(createPagedReportClient({}).client, nativeClient);

    const result = parseResult(
      await tools.call("b2_list_largest_files", { bucket: "photos", limit: 5, max_scan: 1000 }),
    );

    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(0);
    expect(result.note).toContain("time budget");
  });

  it("stops b2_list_largest_files after a page when the time budget is spent", async () => {
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const nativeClient = createNativeClient({
      filePages: [
        {
          files: [file("raw/a.bin", 10 * GB)],
          nextFileName: "raw/b.bin",
        },
      ],
    });
    nativeClient.listFileNames.mockImplementationOnce(async () => {
      clock = AFTER_SCAN_TIME_BUDGET_MS;
      return { files: [file("raw/a.bin", 10 * GB)], nextFileName: "raw/b.bin" };
    });
    const tools = registerTools(createPagedReportClient({}).client, nativeClient);

    const result = parseResult(
      await tools.call("b2_list_largest_files", { bucket: "photos", limit: 5, max_scan: 1000 }),
    );

    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(1);
    expect(result.note).toContain("time budget");
  });

  it("returns an empty b2_unfinished_uploads result after the age filter removes uploads", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-10T00:00:00.000Z"));
    const nativeClient = createNativeClient({
      uploadPages: [
        {
          files: [upload("recent.bin", "upload-1", "2026-01-09T00:00:00.000Z")],
          nextFileId: null,
        },
      ],
    });
    const tools = registerTools(createPagedReportClient({}).client, nativeClient);

    const result = parseResult(
      await tools.call("b2_unfinished_uploads", {
        bucket: "photos",
        older_than_days: 30,
        max_uploads: 10,
      }),
    );

    expect(result).toMatchObject({
      bucket: "photos",
      unfinished_count: 0,
      truncated: false,
      note: "No abandoned multipart uploads found.",
    });
    expect(nativeClient.listParts).not.toHaveBeenCalled();
  });

  it("returns truncated empty b2_unfinished_uploads output when upload pagination times out", async () => {
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const nativeClient = createNativeClient({
      uploadPages: [{ files: [], nextFileId: "next-upload" }],
    });
    nativeClient.listUnfinishedLargeFiles.mockImplementationOnce(async () => {
      clock = AFTER_SCAN_TIME_BUDGET_MS;
      return { files: [], nextFileId: "next-upload" };
    });
    const tools = registerTools(createPagedReportClient({}).client, nativeClient);

    const result = parseResult(
      await tools.call("b2_unfinished_uploads", { bucket: "photos", max_uploads: 10 }),
    );

    expect(result.unfinished_count).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.note).toContain("time budget");
  });

  it("sums paginated b2_unfinished_uploads parts", async () => {
    const nativeClient = createNativeClient({
      uploadPages: [
        {
          files: [upload("old.bin", "upload-1", "2026-01-01T00:00:00.000Z")],
          nextFileId: null,
        },
      ],
      partPagesByFileId: {
        "upload-1": [
          { parts: [part(GB)], nextPartNumber: 2 },
          { parts: [part(0.5 * GB, 2)], nextPartNumber: null },
        ],
      },
    });
    const tools = registerTools(createPagedReportClient({}).client, nativeClient);

    const result = parseResult(
      await tools.call("b2_unfinished_uploads", { bucket: "photos", max_uploads: 10 }),
    );

    expect(result.truncated).toBe(false);
    expect(result.unfinished_count).toBe(1);
    expect(result.wasted_gb).toBe(1.5);
    expect(result.oldest_file).toBe("old.bin");
    expect(nativeClient.listParts).toHaveBeenCalledTimes(2);
    expect(nativeClient.listParts).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ fileId: "upload-1", startPartNumber: 2 }),
    );
  });
});
