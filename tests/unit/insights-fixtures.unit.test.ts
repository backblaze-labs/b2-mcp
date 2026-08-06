import { latestSnapshotDate, loadDayRows } from "../../src/b2/insights";

describe("insight report pagination fixtures", () => {
  it("finds the latest available snapshot across paginated report keys", async () => {
    const calls: any[] = [];
    const pages = [
      {
        keys: ["2026-01-07/usage.account-a.csv"],
        isTruncated: true,
        nextContinuationToken: "page-2",
      },
      { keys: ["2026-01-09/usage.account-a.csv"], isTruncated: false },
    ];
    const reportClient = {
      async listReportObjectKeys(bucketName: string, options: any) {
        calls.push({ bucketName, options });
        return pages.shift();
      },
    };

    const result = await latestSnapshotDate(
      reportClient as any,
      "b2-reports-test-account",
      new Date("2026-01-10T00:00:00.000Z"),
    );

    expect(result).toEqual({ date: "2026-01-09", bucketMissing: false });
    expect(calls).toHaveLength(2);
    expect(calls[0].options).toMatchObject({ startAfter: "2025-12-31" });
    expect(calls[1].options).toMatchObject({ continuationToken: "page-2" });
  });

  it("loads one day of usage CSVs while skipping audit and index files", async () => {
    const listed: any[] = [];
    const downloaded: string[] = [];
    const pages = [
      {
        keys: [
          "2026-01-09/usage.account-a.csv",
          "2026-01-09/usage.audit-account-a.csv",
          "2026-01-09/usage.group-1.reportingLocations.csv",
        ],
        isTruncated: true,
        nextContinuationToken: "page-2",
      },
      {
        keys: ["2026-01-09/usage.group-1.us-west-004.csv"],
        isTruncated: false,
      },
    ];
    const csvByKey = new Map([
      [
        "2026-01-09/usage.account-a.csv",
        "account_id,date,bucket_name,stored_gb,downloaded_gb,uploaded_gb,api_txn_class_c\nacct-a,2026-01-09,bucket-a,2,1,0.5,3\n",
      ],
      [
        "2026-01-09/usage.group-1.us-west-004.csv",
        "account_id,date,bucket_name,stored_gb,downloaded_gb,uploaded_gb,api_txn_class_c\nacct-b,1/9/26,bucket-b,,4,1,6\n",
      ],
    ]);
    const reportClient = {
      async listReportObjectKeys(bucketName: string, options: any) {
        listed.push({ bucketName, options });
        return pages.shift();
      },
      async downloadReportObjectText(_bucketName: string, key: string) {
        downloaded.push(key);
        const text = csvByKey.get(key) ?? "";
        return { text, bytes: Buffer.byteLength(text), truncated: false };
      },
    };

    const rows = await loadDayRows(reportClient as any, "b2-reports-test-account", "2026-01-09");

    expect(downloaded).toEqual([
      "2026-01-09/usage.account-a.csv",
      "2026-01-09/usage.group-1.us-west-004.csv",
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        accountId: "acct-a",
        bucketName: "bucket-a",
        storageBytes: 2e9,
        egressBytes: 1e9,
        uploadBytes: 0.5e9,
        classCTxn: 3,
      }),
      expect.objectContaining({
        accountId: "acct-b",
        bucketName: "bucket-b",
        storageBytes: null,
        egressBytes: 4e9,
      }),
    ]);
    expect(listed[0].options).toMatchObject({ prefix: "2026-01-09/" });
    expect(listed[1].options).toMatchObject({ continuationToken: "page-2" });
  });
});
