import {
  parseCsv,
  normalizeDate,
  mapRow,
  computeAccountGrowth,
  computeEgressLeaders,
  selectUsageKeys,
  ReportRow,
} from "../../src/b2/insights.js";

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
    { accountId: "a", _date: "2026-06-01", storageBytes: 100, egressBytes: 5, uploadBytes: 0, classCTxn: 0 },
    { accountId: "a", _date: "2026-06-03", storageBytes: 150, egressBytes: 5, uploadBytes: 0, classCTxn: 0 },
    { accountId: "b", _date: "2026-06-01", storageBytes: 200, egressBytes: 1, uploadBytes: 0, classCTxn: 0 },
    { accountId: "b", _date: "2026-06-03", storageBytes: 180, egressBytes: 1, uploadBytes: 0, classCTxn: 0 },
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
    { accountId: "a", _date: "d1", bucketName: "ba", storageBytes: 0, egressBytes: 30, uploadBytes: 0, classCTxn: 0 },
    { accountId: "a", _date: "d2", bucketName: "ba", storageBytes: 0, egressBytes: 10, uploadBytes: 0, classCTxn: 0 },
    { accountId: "b", _date: "d1", bucketName: "bb", storageBytes: 0, egressBytes: 20, uploadBytes: 0, classCTxn: 0 },
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
