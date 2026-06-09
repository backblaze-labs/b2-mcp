/**
 * Tests for large-file upload failure handling: a part failure must cancel the
 * started large file (so it doesn't linger orphaned in B2), and an impossible
 * part count must be rejected up front before anything is started.
 */

import axios from "axios";
import { createServer } from "../../src/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { B2Config } from "../../src/utils/types";

jest.mock("axios");
const mockedAxios = axios as jest.MockedFunction<typeof axios> & {
  get: jest.MockedFunction<typeof axios.get>;
  post: jest.MockedFunction<typeof axios.post>;
};

const mockAuthData = {
  accountId: "acct",
  authorizationToken: "tok",
  apiInfo: {
    storageApi: {
      apiUrl: "https://api.example",
      downloadUrl: "https://dl.example",
      s3ApiUrl: "https://s3.example",
      recommendedPartSize: 1e8,
      absoluteMinimumPartSize: 5e6,
    },
  },
};

function makeConfig(over: Partial<B2Config>): B2Config {
  return {
    applicationKeyId: "test-key-id",
    applicationKey: "test-key-secret",
    appKeyId: "test-app-key-id",
    appKey: "test-app-key-secret",
    masterKeyId: "test-app-key-secret",
    masterKey: "test-app-key-secret",
    region: "us-west-004",
    largeFileThreshold: 100 * 1024 * 1024,
    partSize: 100 * 1024 * 1024,
    allowLocalFiles: true,
    fileRoot: null,
    ...over,
  };
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  const tool = (server as any)._registeredTools?.[name];
  const handler = tool.handler ?? tool.callback ?? tool.execute;
  return handler(args, {} as any);
}

function urlsCalled(): string[] {
  return mockedAxios.mock.calls.map((c) => (c[0] as { url?: string })?.url ?? "");
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
  mockedAxios.mockImplementation((config: any) => {
    const url: string = config?.url ?? "";
    if (url.includes("b2_start_large_file")) return Promise.resolve({ data: { fileId: "lf1" } });
    if (url.includes("b2_get_upload_part_url"))
      return Promise.resolve({
        data: { uploadUrl: "https://up.example/p", authorizationToken: "t" },
      });
    if (url.includes("b2_cancel_large_file")) return Promise.resolve({ data: { cancelled: true } });
    return Promise.resolve({ data: {} });
  });
});

describe("large-file upload — abort on part failure", () => {
  it("cancels the started large file when a part upload fails", async () => {
    // 60-byte payload, 10-byte threshold, 50-byte parts → large path, 2 parts.
    const server = createServer(makeConfig({ largeFileThreshold: 10, partSize: 50 }));
    // Part uploads (axios.post) fail.
    mockedAxios.post = jest.fn().mockRejectedValue(new Error("part upload failed"));

    const content = Buffer.alloc(60, 1).toString("base64");
    const result = await callTool(server, "b2_upload_file", {
      bucketId: "b",
      fileName: "big.bin",
      content,
    });

    expect(result.isError).toBe(true);
    const urls = urlsCalled();
    expect(urls.some((u) => u.includes("b2_start_large_file"))).toBe(true);
    expect(urls.some((u) => u.includes("b2_cancel_large_file"))).toBe(true);
  });
});

describe("large-file upload — part-count guard", () => {
  it("rejects before starting when the file would exceed the part limit", async () => {
    // 20000 bytes / 1-byte parts = 20000 parts > 10000 limit.
    const server = createServer(makeConfig({ largeFileThreshold: 10, partSize: 1 }));
    mockedAxios.post = jest.fn().mockResolvedValue({ data: {} });

    const content = Buffer.alloc(20000, 1).toString("base64");
    const result = await callTool(server, "b2_upload_file", {
      bucketId: "b",
      fileName: "toomany.bin",
      content,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/exceeding B2's limit/i);
    // Nothing should have been started.
    expect(urlsCalled().some((u) => u.includes("b2_start_large_file"))).toBe(false);
  });
});
