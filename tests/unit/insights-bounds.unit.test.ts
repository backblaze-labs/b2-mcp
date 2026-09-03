/**
 * Unit tests for the large-bucket safety bounds on the live insight tools.
 *
 * b2_list_largest_files and b2_unfinished_uploads walk a bucket through native SDK
 * list endpoints; those walks must stop at scan caps or wall-clock budgets.
 *
 * NOTE: callTool invokes handlers directly, so the MCP SDK's zod .default() is
 * not applied here — we pass limit / max_scan / max_uploads explicitly.
 */

import { createServer, invalidateAuthManagerCache } from "../../src/server";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { runWithMcpRequestSignal } from "../../src/request-context";
import { _resetRetryBudget } from "../../src/utils/retry";
import type { McpServer } from "../../src/mcp";
import { callTool, parseResult, testConfig } from "../support/deterministic-fakes";
import {
  authorizeResponse,
  b2EndpointName,
  installSdkTransport,
  RecordingTransport,
  requestJson,
  StaticHttpResponse,
} from "../support/sdk-test-helpers";

const bucketInfo = {
  accountId: "test-account-123",
  bucketId: "bucket-1",
  bucketName: "test-bucket",
  bucketType: "allPrivate",
  bucketInfo: {},
  corsRules: [],
  lifecycleRules: [],
  revision: 1,
  options: [],
};

let server: McpServer;

beforeEach(() => {
  _resetRetryBudget();
  invalidateAuthManagerCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  setB2SdkClientFactoryForTests(null);
  invalidateAuthManagerCache();
});

function queueB2(opts: {
  fileNamePages?: any[];
  uploadPages?: any[];
  partsByFileId?: Record<string, any[]>;
}) {
  const fileNamePages = [...(opts.fileNamePages ?? [])];
  const uploadPages = [...(opts.uploadPages ?? [])];
  const partsByFileId = opts.partsByFileId ?? {};

  installSdkTransport(
    new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["listBuckets", "listFiles"]));
      }
      if (endpoint === "b2_list_buckets") {
        return new StaticHttpResponse(200, { buckets: [bucketInfo] });
      }
      if (endpoint === "b2_list_file_names") {
        return new StaticHttpResponse(
          200,
          fileNamePages.shift() ?? { files: [], nextFileName: null },
        );
      }
      if (endpoint === "b2_list_unfinished_large_files") {
        return new StaticHttpResponse(200, uploadPages.shift() ?? { files: [], nextFileId: null });
      }
      if (endpoint === "b2_list_parts") {
        const fileId = String(requestJson(request).fileId);
        return new StaticHttpResponse(200, {
          parts: partsByFileId[fileId] ?? [],
          nextPartNumber: null,
        });
      }
      return new StaticHttpResponse(200, {});
    }),
  );
  server = createServer(testConfig);
}

const file = (fileName: string, contentLength: number) => ({
  accountId: "test-account-123",
  bucketId: "bucket-1",
  fileId: `id-${fileName}`,
  fileName,
  action: "upload",
  contentLength,
  contentSha1: "none",
  contentType: "b2/x-auto",
  fileInfo: {},
  uploadTimestamp: Date.parse("2021-01-01T00:00:00.000Z"),
});

// ── b2_list_largest_files ──────────────────────────────────────────────────────────

describe("b2_list_largest_files — scan bound", () => {
  it("stops at max_scan, reports truncated, and ranks the largest seen", async () => {
    queueB2({
      fileNamePages: [
        {
          files: [file("a", 10), file("b", 20), file("c", 30)],
          nextFileName: "d",
        },
        {
          files: [file("d", 5), file("e", 40), file("f", 15)],
          nextFileName: "g",
        },
      ],
    });

    const result = parseResult(
      await callTool(server, "b2_list_largest_files", { bucket: "test-bucket", limit: 3, max_scan: 5 }),
    );

    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(5);
    expect(result.returned).toBe(3);
    expect(result.files.map((f: any) => f.size_bytes)).toEqual([40, 30, 20]);
    expect(result.note).toContain("max_scan");
  });

  it("stops inside the final returned page and reports truncation", async () => {
    queueB2({
      fileNamePages: [
        {
          files: [file("a", 10), file("b", 20), file("c", 30)],
          nextFileName: null,
        },
      ],
    });

    const result = parseResult(
      await callTool(server, "b2_list_largest_files", { bucket: "test-bucket", limit: 3, max_scan: 2 }),
    );

    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(2);
    expect(result.files.map((f: any) => f.name)).toEqual(["b", "a"]);
  });

  it("returns a complete (non-truncated) result when the listing ends within the cap", async () => {
    queueB2({
      fileNamePages: [{ files: [file("a", 10), file("b", 20)], nextFileName: null }],
    });

    const result = parseResult(
      await callTool(server, "b2_list_largest_files", {
        bucket: "test-bucket",
        limit: 10,
        max_scan: 50000,
      }),
    );

    expect(result.truncated).toBe(false);
    expect(result.scanned).toBe(2);
    expect(result.returned).toBe(2);
    expect(result.files[0].size_bytes).toBe(20);
  });

  it("does not spend retry budget on successful paginated file listings", async () => {
    queueB2({
      fileNamePages: Array.from({ length: 125 }, (_, i) => ({
        files: [file(`file-${String(i).padStart(3, "0")}`, i + 1)],
        nextFileName: i === 124 ? null : `file-${String(i + 1).padStart(3, "0")}`,
      })),
    });
    const request = new AbortController();

    const result = parseResult(
      await runWithMcpRequestSignal(request.signal, () =>
        callTool(server, "b2_list_largest_files", {
          bucket: "test-bucket",
          limit: 5,
          max_scan: 1000,
        }),
      ),
    );

    expect(result.truncated).toBe(false);
    expect(result.scanned).toBe(125);
    expect(result.returned).toBe(5);
    expect(result.files.map((f: any) => f.size_bytes)).toEqual([125, 124, 123, 122, 121]);
  });
});

// ── b2_unfinished_uploads ───────────────────────────────────────────────────--

describe("b2_unfinished_uploads — upload bound", () => {
  const upload = (fileName: string, fileId: string, isoDate: string) => ({
    accountId: "test-account-123",
    bucketId: "bucket-1",
    contentType: "b2/x-auto",
    fileId,
    fileInfo: {},
    fileName,
    uploadTimestamp: Date.parse(isoDate),
  });

  const part = (fileId: string, contentLength: number, partNumber = 1) => ({
    fileId,
    partNumber,
    contentLength,
    contentSha1: "none",
    uploadTimestamp: Date.parse("2021-01-01T00:00:00.000Z"),
  });

  it("stops at max_uploads, reports truncated, and still finds the oldest + wasted bytes", async () => {
    queueB2({
      uploadPages: [
        {
          files: [
            upload("u1", "1", "2020-02-01T00:00:00.000Z"),
            upload("u2", "2", "2020-01-01T00:00:00.000Z"),
          ],
          nextFileId: "next",
        },
      ],
      partsByFileId: { "1": [part("1", 1e9)], "2": [part("2", 2e9)] },
    });

    const result = parseResult(
      await callTool(server, "b2_unfinished_uploads", { bucket: "test-bucket", max_uploads: 2 }),
    );

    expect(result.truncated).toBe(true);
    expect(result.unfinished_count).toBe(2);
    expect(result.oldest_file).toBe("u2");
    expect(result.wasted_gb).toBe(3);
    expect(result.note).toContain("max_uploads");
  });

  it("stops inside the final upload page and reports matching items left", async () => {
    queueB2({
      uploadPages: [
        {
          files: [
            upload("u1", "1", "2020-02-01T00:00:00.000Z"),
            upload("u2", "2", "2020-01-01T00:00:00.000Z"),
            upload("u3", "3", "2020-03-01T00:00:00.000Z"),
          ],
          nextFileId: null,
        },
      ],
      partsByFileId: { "1": [part("1", 1e9)] },
    });

    const result = parseResult(
      await callTool(server, "b2_unfinished_uploads", { bucket: "test-bucket", max_uploads: 1 }),
    );

    expect(result.truncated).toBe(true);
    expect(result.unfinished_count).toBe(1);
    expect(result.oldest_file).toBe("u1");
    expect(result.wasted_gb).toBe(1);
    expect(result.note).toContain("max_uploads");
  });

  it("reports wasted_gb as a lower bound when the parts-summing budget is hit", async () => {
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["listBuckets", "listFiles"]));
      }
      if (endpoint === "b2_list_buckets") {
        return new StaticHttpResponse(200, { buckets: [bucketInfo] });
      }
      if (endpoint === "b2_list_unfinished_large_files") {
        return new StaticHttpResponse(200, {
          files: [
            upload("u1", "1", "2020-02-01T00:00:00.000Z"),
            upload("u2", "2", "2020-01-01T00:00:00.000Z"),
          ],
          nextFileId: null,
        });
      }
      if (endpoint === "b2_list_parts") {
        const fileId = String(requestJson(request).fileId);
        if (fileId === "1") clock = 999_999;
        return new StaticHttpResponse(200, {
          parts: fileId === "1" ? [part("1", 1e9)] : [part("2", 2e9)],
          nextPartNumber: null,
        });
      }
      return new StaticHttpResponse(200, {});
    });
    installSdkTransport(transport);
    server = createServer(testConfig);

    const result = parseResult(
      await callTool(server, "b2_unfinished_uploads", { bucket: "test-bucket", max_uploads: 1000 }),
    );

    expect(result.truncated).toBe(false);
    expect(result.wasted_is_lower_bound).toBe(true);
    expect(result.sized_uploads).toBe(1);
    expect(result.wasted_gb).toBe(1);
    expect(result.oldest_file).toBe("u2");
  });

  it("aborts an in-flight listParts call when the scan deadline expires", async () => {
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    let listPartsSignal: AbortSignal | undefined;
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["listBuckets", "listFiles"]));
      }
      if (endpoint === "b2_list_buckets") {
        return new StaticHttpResponse(200, { buckets: [bucketInfo] });
      }
      if (endpoint === "b2_list_unfinished_large_files") {
        clock = 11_999;
        return new StaticHttpResponse(200, {
          files: [upload("u1", "1", "2020-02-01T00:00:00.000Z")],
          nextFileId: null,
        });
      }
      if (endpoint === "b2_list_parts") {
        listPartsSignal = request.signal;
        return new Promise((_, reject) => {
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
            once: true,
          });
        });
      }
      return new StaticHttpResponse(200, {});
    });
    installSdkTransport(transport);
    server = createServer(testConfig);

    const result = parseResult(
      await callTool(server, "b2_unfinished_uploads", { bucket: "test-bucket", max_uploads: 1000 }),
    );

    expect(listPartsSignal?.aborted).toBe(true);
    expect(result.wasted_is_lower_bound).toBe(true);
    expect(result.sized_uploads).toBe(0);
    expect(result.wasted_gb).toBe(0);
  });
});
