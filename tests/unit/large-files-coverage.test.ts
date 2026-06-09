/**
 * Coverage for the large-file paths not exercised elsewhere: the disk-backed
 * multipart upload (readFilePart + filePath worker + finish), the standalone
 * b2_upload_part / b2_copy_part tools, and optional-parameter branches.
 */

import axios from "axios";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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

function makeConfig(over: Partial<B2Config> = {}): B2Config {
  return {
    applicationKeyId: "k",
    applicationKey: "s",
    appKeyId: "k",
    appKey: "s",
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
const parse = (r: any) => {
  try {
    return JSON.parse(r?.content?.[0]?.text);
  } catch {
    return r;
  }
};

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
    if (url.includes("b2_finish_large_file"))
      return Promise.resolve({ data: { fileId: "lf1", action: "upload", contentLength: 120 } });
    return Promise.resolve({ data: { ok: true } });
  });
  mockedAxios.post = jest.fn().mockResolvedValue({ data: { partNumber: 1 } });
});

describe("large-file disk path (readFilePart)", () => {
  it("uploads a file from disk via the multipart worker", async () => {
    const server = createServer(makeConfig({ largeFileThreshold: 10, partSize: 50 }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-lf-"));
    const file = path.join(dir, "big.bin");
    fs.writeFileSync(file, Buffer.alloc(120, 7)); // 120 bytes / 50 → 3 parts

    try {
      const result = parse(
        await callTool(server, "b2_upload_file", {
          bucketId: "b",
          fileName: "big.bin",
          filePath: file,
        }),
      );
      expect(result.fileId).toBe("lf1");
      // start + finish + 3 part-url calls all went through the callable axios mock
      const urls = mockedAxios.mock.calls.map((c) => (c[0] as { url?: string })?.url ?? "");
      expect(urls.some((u) => u.includes("b2_start_large_file"))).toBe(true);
      expect(urls.some((u) => u.includes("b2_finish_large_file"))).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledTimes(3); // one upload per part
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("standalone large-file tools", () => {
  let server: McpServer;
  beforeEach(() => (server = createServer(makeConfig())));

  it("b2_upload_part uploads a base64 part", async () => {
    const result = parse(
      await callTool(server, "b2_upload_part", {
        uploadUrl: "https://up.example/p",
        uploadAuthToken: "t",
        partNumber: 1,
        content: Buffer.from("part-data").toString("base64"),
      }),
    );
    expect(result.partNumber).toBe(1);
    expect(mockedAxios.post).toHaveBeenCalled();
  });

  it("b2_copy_part forwards optional range + SSE", async () => {
    const result = await callTool(server, "b2_copy_part", {
      sourceFileId: "src",
      largeFileId: "lf1",
      partNumber: 2,
      range: "bytes=0-4999999",
      sourceServerSideEncryption: { mode: "SSE-C", customerKey: "k" },
      destinationServerSideEncryption: { mode: "SSE-B2" },
    });
    expect(result.isError).toBeFalsy();
  });

  it("b2_start_large_file forwards fileInfo + serverSideEncryption", async () => {
    const result = parse(
      await callTool(server, "b2_start_large_file", {
        bucketId: "b",
        fileName: "f",
        contentType: "b2/x-auto",
        fileInfo: { k: "v" },
        serverSideEncryption: { mode: "SSE-B2" },
      }),
    );
    expect(result.fileId).toBe("lf1");
  });

  it("b2_list_unfinished_large_files forwards namePrefix + startFileId", async () => {
    const result = await callTool(server, "b2_list_unfinished_large_files", {
      bucketId: "b",
      namePrefix: "pre/",
      startFileId: "f0",
    });
    expect(result.isError).toBeFalsy();
  });

  it("b2_list_parts forwards startPartNumber", async () => {
    const result = await callTool(server, "b2_list_parts", { fileId: "lf1", startPartNumber: 5 });
    expect(result.isError).toBeFalsy();
  });
});
