/**
 * Unit tests for the large-bucket safety bounds on the live insight tools.
 *
 * b2_largest_files and b2_unfinished_uploads walk a bucket via the S3 client; on
 * very large / bloated buckets that walk must stop at a scan cap or a wall-clock
 * budget rather than hang. These tests drive a mocked S3 client through those
 * bound conditions.
 *
 * Mocks:
 *   - axios (module)            → auth (axios.get) + resolveBucketName's
 *                                 b2Client.call("b2_list_buckets")
 *   - S3Client.prototype.send   → the ListObjectsV2 / ListMultipartUploads /
 *                                 ListParts pages the handlers paginate
 *
 * NOTE: callTool invokes handlers directly, so the MCP SDK's zod .default() is
 * not applied here — we pass limit / max_scan / max_uploads explicitly.
 */

import axios from "axios";
import {
  S3Client,
  ListObjectsV2Command,
  ListMultipartUploadsCommand,
  ListPartsCommand,
} from "@aws-sdk/client-s3";
import { createServer, getRegisteredTools } from "../../src/server";
import type { McpServer } from "../../src/mcp";

jest.mock("axios");

const mockedAxios = axios as jest.MockedFunction<typeof axios> & {
  get: jest.MockedFunction<typeof axios.get>;
};

const mockAuthData = {
  accountId: "test-account-123",
  authorizationToken: "mock-token-xyz",
  apiInfo: {
    storageApi: {
      apiUrl: "https://api005.backblazeb2.com",
      downloadUrl: "https://f005.backblazeb2.com",
      s3ApiUrl: "https://s3.us-west-004.backblazeb2.com",
      recommendedPartSize: 100 * 1024 * 1024,
      absoluteMinimumPartSize: 5 * 1024 * 1024,
    },
  },
};

const testConfig = {
  applicationKeyId: "test-key-id",
  applicationKey: "test-key-secret",
  appKeyId: "test-app-key-id",
  appKey: "test-app-key-secret",
  masterKeyId: "test-app-key-secret",
  masterKey: "test-app-key-secret",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
};

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const tool = getRegisteredTools(server)?.[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  const handler = tool.handler ?? tool.callback ?? tool.execute;
  return handler(args, {} as any);
}

function parseResult(result: any) {
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let server: McpServer;
let sendSpy: jest.SpyInstance;

beforeEach(() => {
  server = createServer(testConfig);
  // Auth + bucket resolution: resolveBucketName resolves "test-bucket" by name.
  mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
  mockedAxios.mockResolvedValue({
    data: { buckets: [{ bucketName: "test-bucket", bucketId: "bucket-1" }] },
  } as any);
  sendSpy = jest.spyOn(S3Client.prototype as any, "send").mockResolvedValue({} as any);
});

afterEach(() => jest.restoreAllMocks());

/** Route the mocked S3 send to queued pages by command type. */
function queueS3(opts: {
  objectPages?: any[];
  uploadPages?: any[];
  partsByKey?: Record<string, any[]>;
}) {
  const objQ = [...(opts.objectPages ?? [])];
  const upQ = [...(opts.uploadPages ?? [])];
  const parts = opts.partsByKey ?? {};
  sendSpy.mockImplementation(async (command: any) => {
    if (command instanceof ListObjectsV2Command)
      return objQ.shift() ?? { Contents: [], IsTruncated: false };
    if (command instanceof ListMultipartUploadsCommand)
      return upQ.shift() ?? { Uploads: [], IsTruncated: false };
    if (command instanceof ListPartsCommand)
      return { Parts: parts[command.input?.Key as string] ?? [], IsTruncated: false };
    return {};
  });
}

const obj = (Key: string, Size: number) => ({ Key, Size, LastModified: new Date("2021-01-01") });

// ── b2_largest_files ──────────────────────────────────────────────────────────

describe("b2_largest_files — scan bound", () => {
  it("stops at max_scan, reports truncated, and ranks the largest seen", async () => {
    queueS3({
      objectPages: [
        {
          Contents: [obj("a", 10), obj("b", 20), obj("c", 30)],
          IsTruncated: true,
          NextContinuationToken: "t1",
        },
        {
          Contents: [obj("d", 5), obj("e", 40), obj("f", 15)],
          IsTruncated: true,
          NextContinuationToken: "t2",
        },
        // further pages exist (IsTruncated stays true) but the cap fires first
      ],
    });

    const result = parseResult(
      await callTool(server, "b2_largest_files", { bucket: "test-bucket", limit: 3, max_scan: 5 }),
    );

    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(6); // stopped after the 2nd page (6 ≥ 5) with a token still pending
    expect(result.returned).toBe(3);
    expect(result.files.map((f: any) => f.size_bytes)).toEqual([40, 30, 20]);
    expect(result.note).toContain("max_scan");
  });

  it("returns a complete (non-truncated) result when the listing ends within the cap", async () => {
    queueS3({
      objectPages: [{ Contents: [obj("a", 10), obj("b", 20)], IsTruncated: false }],
    });

    const result = parseResult(
      await callTool(server, "b2_largest_files", {
        bucket: "test-bucket",
        limit: 10,
        max_scan: 50000,
      }),
    );

    expect(result.truncated).toBe(false); // largest_files always emits the flag
    expect(result.scanned).toBe(2);
    expect(result.returned).toBe(2);
    expect(result.files[0].size_bytes).toBe(20);
  });
});

// ── b2_unfinished_uploads ───────────────────────────────────────────────────--

describe("b2_unfinished_uploads — upload bound", () => {
  const up = (Key: string, UploadId: string, isoDate: string) => ({
    Key,
    UploadId,
    Initiated: new Date(isoDate),
  });

  it("stops at max_uploads, reports truncated, and still finds the oldest + wasted bytes", async () => {
    queueS3({
      uploadPages: [
        {
          Uploads: [up("u1", "1", "2020-02-01"), up("u2", "2", "2020-01-01")],
          IsTruncated: true,
          NextKeyMarker: "k",
          NextUploadIdMarker: "i",
        },
      ],
      partsByKey: { u1: [{ Size: 1e9 }], u2: [{ Size: 2e9 }] },
    });

    const result = parseResult(
      await callTool(server, "b2_unfinished_uploads", { bucket: "test-bucket", max_uploads: 2 }),
    );

    expect(result.truncated).toBe(true);
    expect(result.unfinished_count).toBe(2);
    expect(result.oldest_file).toBe("u2");
    expect(result.wasted_gb).toBe(3); // (1 + 2) GB
    expect(result.note).toContain("max_uploads");
  });

  it("reports wasted_gb as a lower bound when the parts-summing budget is hit", async () => {
    // Walk completes (no markers); the per-upload parts fan-out trips the budget.
    queueS3({
      uploadPages: [
        { Uploads: [up("u1", "1", "2020-02-01"), up("u2", "2", "2020-01-01")], IsTruncated: false },
      ],
      partsByKey: { u1: [{ Size: 1e9 }], u2: [{ Size: 2e9 }] },
    });

    // Clock: 0 through auth/walk/u1, then jump past the 12s budget so overBudget()
    // trips right after u1's parts are summed (u2 is then skipped for sizing).
    let clock = 0;
    jest.spyOn(Date, "now").mockImplementation(() => clock);
    const realImpl = sendSpy.getMockImplementation()!;
    sendSpy.mockImplementation(async (command: any) => {
      const out = await realImpl(command);
      if (command instanceof ListPartsCommand && command.input?.Key === "u1") clock = 999_999;
      return out;
    });

    const result = parseResult(
      await callTool(server, "b2_unfinished_uploads", { bucket: "test-bucket", max_uploads: 1000 }),
    );

    expect(result.truncated).toBe(false); // the walk itself completed
    expect(result.wasted_is_lower_bound).toBe(true);
    expect(result.sized_uploads).toBe(1);
    expect(result.wasted_gb).toBe(1); // only u1 (1 GB) summed before the budget
    expect(result.oldest_file).toBe("u2"); // oldest still found via the cheap list
  });
});
