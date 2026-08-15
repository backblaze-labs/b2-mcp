import { S3Client } from "@aws-sdk/client-s3";
import type { MockInstance } from "vitest";
import { B2ReportClient } from "../../src/b2/report-client";
import { runWithMcpRequestSignal } from "../../src/request-context";
import { testConfig } from "../support/deterministic-fakes";

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

function createReportClient() {
  const getAuth = vi.fn(async () => reportAuth());
  const getConfig = vi.fn(() => testConfig);
  return {
    client: new B2ReportClient({ getAuth, getConfig } as never),
    getAuth,
    getConfig,
  };
}

describe("B2ReportClient", () => {
  let sendSpy: MockInstance;

  beforeEach(() => {
    sendSpy = vi.spyOn(S3Client.prototype as any, "send");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists report object keys with paging options and reuses the S3 client", async () => {
    sendSpy
      .mockResolvedValueOnce({
        Contents: [{ Key: "2026-01-09/usage.account-a.csv" }, {}, { Key: 123 }],
        IsTruncated: true,
        NextContinuationToken: "next-page",
      })
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    const { client, getAuth } = createReportClient();

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
    expect(sendSpy.mock.calls[0][0].input).toMatchObject({
      Bucket: "b2-reports-test",
      Prefix: "2026-01-09/",
      StartAfter: "2026-01-01",
      ContinuationToken: "page-1",
      MaxKeys: 5,
    });
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
    sendSpy.mockResolvedValueOnce({ Body: body });
    const { client } = createReportClient();

    const result = await client.downloadReportObjectText("b2-reports-test", "usage.csv");

    expect(result).toEqual({ text: "hello", bytes: 5, truncated: false });
  });

  it("reads transformToByteArray bodies", async () => {
    const transformToByteArray = vi.fn(async () => Uint8Array.of(97, 98, 99));
    sendSpy.mockResolvedValueOnce({ Body: { transformToByteArray } });
    const { client } = createReportClient();

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
    sendSpy.mockResolvedValueOnce({ Body: { getReader: vi.fn(() => reader) } });
    const { client } = createReportClient();

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
    sendSpy.mockResolvedValueOnce({ Body: { getReader: vi.fn(() => reader) } });
    const { client } = createReportClient();

    const result = await client.downloadReportObjectText("b2-reports-test", "usage.csv", {
      maxBytes: 3,
    });

    expect(result).toEqual({ text: "abc", bytes: 3, truncated: true });
    expect(reader.cancel).toHaveBeenCalledWith(expect.any(Error));
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("returns an empty result without reading when maxBytes is zero", async () => {
    const transformToByteArray = vi.fn(async () => Uint8Array.of(97));
    sendSpy.mockResolvedValueOnce({ Body: { transformToByteArray } });
    const { client } = createReportClient();

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
    sendSpy
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Body: unsupportedChunkBody })
      .mockResolvedValueOnce({ Body: {} });
    const { client } = createReportClient();

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

  it("cleans up a report body when the parent request is already aborted", async () => {
    const iterator = {
      next: vi.fn(async () => ({ done: false, value: Buffer.from("ignored") })),
      return: vi.fn(async () => ({ done: true, value: undefined as never })),
    };
    const body = {
      destroy: vi.fn(),
      [Symbol.asyncIterator]: () => iterator,
    };
    sendSpy.mockResolvedValueOnce({ Body: body });
    const { client } = createReportClient();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runWithMcpRequestSignal(controller.signal, () =>
        client.downloadReportObjectText("b2-reports-test", "aborted.csv"),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(body.destroy).toHaveBeenCalledWith(expect.objectContaining({ name: "AbortError" }));
    expect(iterator.return).toHaveBeenCalledTimes(1);
  });
});
