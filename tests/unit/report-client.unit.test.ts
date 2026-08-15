import { B2ReportClient } from "../../src/b2/report-client";
import { runWithMcpRequestSignal } from "../../src/request-context";
import { createReportS3Client } from "../../src/s3/client";
import { DeterministicS3ClientFake, testConfig } from "../support/deterministic-fakes";

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

function createReportClient(s3 = new DeterministicS3ClientFake()) {
  const getAuth = vi.fn(async () => reportAuth());
  const getConfig = vi.fn(() => testConfig);
  vi.mocked(createReportS3Client).mockReturnValue(
    s3.asPeerClient() as ReturnType<typeof createReportS3Client>,
  );
  return {
    client: new B2ReportClient({ getAuth, getConfig } as never),
    getAuth,
    s3,
  };
}

describe("B2ReportClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists report object keys with paging options and reuses the S3 client", async () => {
    const s3 = new DeterministicS3ClientFake().respond(
      "listReportObjectKeys",
      {
        keys: ["2026-01-09/usage.account-a.csv"],
        isTruncated: true,
        nextContinuationToken: "next-page",
      },
      { keys: [], isTruncated: false },
    );
    const { client, getAuth } = createReportClient(s3);

    const page = await client.listReportObjectKeys("b2-reports-test", {
      prefix: "2026-01-09/",
      startAfter: "2026-01-01",
      continuationToken: "page-1",
      maxKeys: 5,
      timeoutMs: 100,
    });
    const secondPage = await client.listReportObjectKeys("b2-reports-test");

    expect(page).toEqual({
      keys: ["2026-01-09/usage.account-a.csv"],
      isTruncated: true,
      nextContinuationToken: "next-page",
    });
    expect(secondPage).toEqual({ keys: [], isTruncated: false, nextContinuationToken: undefined });
    expect(s3.requestsFor("listReportObjectKeys")).toEqual([
      {
        operation: "listReportObjectKeys",
        input: {
          bucketName: "b2-reports-test",
          prefix: "2026-01-09/",
          startAfter: "2026-01-01",
          continuationToken: "page-1",
          maxKeys: 5,
        },
        aborted: false,
      },
      {
        operation: "listReportObjectKeys",
        input: { bucketName: "b2-reports-test" },
        aborted: false,
      },
    ]);
    expect(createReportS3Client).toHaveBeenCalledWith(
      testConfig,
      expect.objectContaining({ accountId: "test-account-123" }),
    );
    expect(getAuth).toHaveBeenCalledTimes(1);
  });

  it("reads async iterable bodies containing strings, ArrayBuffers, and byte chunks", async () => {
    const body = {
      async *[Symbol.asyncIterator]() {
        yield "h";
        yield Uint8Array.of(101, 108).buffer;
        yield Buffer.from([108, 111]);
      },
    };
    const s3 = new DeterministicS3ClientFake().respond("downloadReportObject", {
      body,
    });
    const { client } = createReportClient(s3);

    const result = await client.downloadReportObjectText("b2-reports-test", "usage.csv");

    expect(result).toEqual({ text: "hello", bytes: 5, truncated: false });
    expect(s3.requestsFor("downloadReportObject")).toEqual([
      {
        operation: "downloadReportObject",
        input: { bucketName: "b2-reports-test", key: "usage.csv" },
        aborted: false,
      },
    ]);
  });

  it("reads transformToByteArray bodies", async () => {
    const transformToByteArray = vi.fn(async () => Uint8Array.of(97, 98, 99));
    const s3 = new DeterministicS3ClientFake().respond("downloadReportObject", {
      body: { transformToByteArray },
    });
    const { client } = createReportClient(s3);

    const result = await client.downloadReportObjectText("b2-reports-test", "usage.csv");

    expect(result).toEqual({ text: "abc", bytes: 3, truncated: false });
    expect(transformToByteArray).toHaveBeenCalledTimes(1);
  });

  it("reads web streams to completion and releases the reader lock", async () => {
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: Uint8Array.of(111, 107) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    const s3 = new DeterministicS3ClientFake().respond("downloadReportObject", {
      body: { getReader: vi.fn(() => reader) },
    });
    const { client } = createReportClient(s3);

    const result = await client.downloadReportObjectText("b2-reports-test", "usage.csv");

    expect(result).toEqual({ text: "ok", bytes: 2, truncated: false });
    expect(reader.cancel).not.toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("cancels web streams when the byte cap truncates a chunk", async () => {
    const reader = {
      read: vi.fn().mockResolvedValueOnce({ done: false, value: Buffer.from("abcdef") }),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    const s3 = new DeterministicS3ClientFake().respond("downloadReportObject", {
      body: { getReader: vi.fn(() => reader) },
    });
    const { client } = createReportClient(s3);

    const result = await client.downloadReportObjectText("b2-reports-test", "usage.csv", {
      maxBytes: 3,
    });

    expect(result).toEqual({ text: "abc", bytes: 3, truncated: true });
    expect(reader.cancel).toHaveBeenCalledWith(expect.any(Error));
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("returns an empty result without reading when maxBytes is zero", async () => {
    const transformToByteArray = vi.fn(async () => Uint8Array.of(97));
    const s3 = new DeterministicS3ClientFake().respond("downloadReportObject", {
      body: { transformToByteArray },
    });
    const { client } = createReportClient(s3);

    const result = await client.downloadReportObjectText("b2-reports-test", "usage.csv", {
      maxBytes: 0,
    });

    expect(result).toEqual({ text: "", bytes: 0, truncated: false });
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it("rejects missing, unsupported, and malformed report bodies", async () => {
    const unsupportedChunkBody = {
      async *[Symbol.asyncIterator]() {
        yield 42;
      },
    };
    const s3 = new DeterministicS3ClientFake().respond(
      "downloadReportObject",
      { body: undefined },
      { body: unsupportedChunkBody },
      { body: {} },
    );
    const { client } = createReportClient(s3);

    await expect(client.downloadReportObjectText("b2-reports-test", "missing.csv")).rejects.toThrow(
      "did not include a body",
    );
    await expect(
      client.downloadReportObjectText("b2-reports-test", "bad-chunk.csv"),
    ).rejects.toThrow("Unsupported B2 report object body chunk.");
    await expect(
      client.downloadReportObjectText("b2-reports-test", "unsupported.csv"),
    ).rejects.toThrow("Unsupported B2 report object body.");
  });

  it("cleans up a report body when the parent request aborts during a read", async () => {
    const controller = new AbortController();
    const iterator = {
      next: vi.fn(async () => {
        controller.abort();
        return { done: false, value: Buffer.from("ignored") };
      }),
      return: vi.fn(async () => ({ done: true, value: undefined as never })),
    };
    const body = {
      destroy: vi.fn(),
      [Symbol.asyncIterator]: () => iterator,
    };
    const s3 = new DeterministicS3ClientFake().respond("downloadReportObject", {
      body,
    });
    const { client } = createReportClient(s3);

    await expect(
      runWithMcpRequestSignal(controller.signal, () =>
        client.downloadReportObjectText("b2-reports-test", "aborted.csv"),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(body.destroy).toHaveBeenCalledWith(expect.objectContaining({ name: "AbortError" }));
    expect(iterator.return).toHaveBeenCalledTimes(1);
  });
});
