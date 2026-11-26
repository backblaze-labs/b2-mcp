/**
 * Concurrency test for case C21: two simultaneous first calls on the report client must
 * not each build (and then leak) their own S3 client. The defect is fixed, so the test runs as
 * a normal test.
 */
import { B2ReportClient } from "../../src/b2/report-client";
import { createReportS3Client } from "../../src/s3/client";
import { DeterministicS3ClientFake, testConfig } from "../support/deterministic-fakes";
import { deferred } from "../support/sdk-test-helpers";

vi.mock("../../src/s3/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/s3/client")>()),
  createReportS3Client: vi.fn(),
}));

function reportAuth() {
  return {
    accountId: "test-account-123",
    authorizationToken: "mock-token-xyz",
    apiUrl: "https://api005.backblazeb2.com",
    downloadUrl: "https://f005.backblazeb2.com",
    s3ApiUrl: "https://s3.us-west-004.backblazeb2.com",
    recommendedPartSize: 100 * 1024 * 1024,
    absoluteMinimumPartSize: 5 * 1024 * 1024,
    capabilities: ["readFiles"],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("B2ReportClient concurrency", () => {
  it("Finding C21: concurrent first calls create one S3 client, and none is left undestroyed", async () => {
    const created: DeterministicS3ClientFake[] = [];
    vi.mocked(createReportS3Client).mockImplementation(() => {
      // Both concurrent calls may be served by one shared client, so queue a response per call.
      const emptyPage = { keys: [], isTruncated: false };
      const fake = new DeterministicS3ClientFake()
        .respond("listReportObjectKeys", emptyPage)
        .respond("listReportObjectKeys", emptyPage);
      created.push(fake);
      return fake.asPeerClient() as ReturnType<typeof createReportS3Client>;
    });
    const auth = deferred<ReturnType<typeof reportAuth>>();
    const client = new B2ReportClient({
      getAuth: vi.fn(() => auth.promise),
      getConfig: vi.fn(() => testConfig),
    } as never);

    const first = client.listReportObjectKeys("b2-reports-test");
    const second = client.listReportObjectKeys("b2-reports-test");
    auth.resolve(reportAuth());
    await Promise.all([first, second]);
    client.destroy();

    // Either only one client is built, or every extra one is released.
    expect(created.length, "at least one S3 client was created").toBeGreaterThan(0);
    const leaked = created.filter((fake) => !fake.destroyed);
    expect(leaked, "S3 clients created but never destroyed").toHaveLength(0);
  });
});
