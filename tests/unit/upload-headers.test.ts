/**
 * Header-parity tests for b2_upload_file. The filePath (streamed) and
 * content (base64) branches must produce byte-identical upload headers —
 * that equivalence is the reason buildUploadHeaders/uploadSmallFile exist.
 * Also covers fileInfo-key validation (header-injection guard).
 */

import axios from "axios";
import * as crypto from "crypto";
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

const testConfig: B2Config = {
  applicationKeyId: "test-key-id",
  applicationKey: "test-key-secret",
  appKeyId: "test-app-key-id",
  appKey: "test-app-key-secret",
  region: "us-west-004",
  largeFileThreshold: 100 * 1024 * 1024,
  partSize: 100 * 1024 * 1024,
  allowLocalFiles: true,
  fileRoot: null,
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

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  const tool = (server as any)._registeredTools?.[name];
  const handler = tool.handler ?? tool.callback ?? tool.execute;
  return handler(args, {} as any);
}

function lastPostHeaders(): Record<string, string> {
  const calls = mockedAxios.post.mock.calls;
  return (calls[calls.length - 1][2] as { headers: Record<string, string> }).headers;
}

let server: McpServer;
let tmpFile: string;
const bytes = Buffer.from("hello world — this is the upload payload under test");

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.get = jest.fn().mockResolvedValue({ data: mockAuthData });
  // client.call("b2_get_upload_url", …) goes through the callable axios mock
  mockedAxios.mockResolvedValue({
    data: { uploadUrl: "https://up.example/u", authorizationToken: "uptok" },
  } as any);
  // Drain the body stream the way axios would, so the temp file's fd is fully
  // read and closed before afterEach removes the directory.
  mockedAxios.post = jest.fn().mockImplementation(async (_url: string, body: unknown) => {
    const stream = body as NodeJS.ReadableStream | undefined;
    if (stream && typeof stream.resume === "function") {
      await new Promise<void>((r) => {
        stream.on("end", () => r());
        stream.on("error", () => r());
        stream.resume();
      });
    }
    return { data: { fileId: "f1" } };
  });
  server = createServer(testConfig);
  tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "b2-up-")), "payload.txt");
  fs.writeFileSync(tmpFile, bytes);
});

afterEach(() => fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }));

const sse = {
  mode: "SSE-C" as const,
  algorithm: "AES256",
  customerKey: "Y3VzdG9tZXIta2V5",
  customerKeyMd5: "bWQ1",
};

describe("b2_upload_file header parity", () => {
  it("produces identical upload headers for filePath and base64 content", async () => {
    await callTool(server, "b2_upload_file", {
      bucketId: "b",
      fileName: "f.txt",
      filePath: tmpFile,
      contentType: "text/plain",
      fileInfo: { foo: "bar" },
      serverSideEncryption: sse,
    });
    const fromFile = lastPostHeaders();

    mockedAxios.post.mockClear();

    await callTool(server, "b2_upload_file", {
      bucketId: "b",
      fileName: "f.txt",
      content: bytes.toString("base64"),
      contentType: "text/plain",
      fileInfo: { foo: "bar" },
      serverSideEncryption: sse,
    });
    const fromBase64 = lastPostHeaders();

    expect(fromBase64).toEqual(fromFile);
  });

  it("sets the expected header values (sha1, length, fileInfo, SSE-C)", async () => {
    await callTool(server, "b2_upload_file", {
      bucketId: "b",
      fileName: "name with spaces.txt",
      content: bytes.toString("base64"),
      contentType: "text/plain",
      fileInfo: { foo: "bar baz" },
      serverSideEncryption: sse,
    });
    const h = lastPostHeaders();
    expect(h["X-Bz-Content-Sha1"]).toBe(crypto.createHash("sha1").update(bytes).digest("hex"));
    expect(h["Content-Length"]).toBe(String(bytes.length));
    expect(h["X-Bz-File-Name"]).toBe(encodeURIComponent("name with spaces.txt"));
    expect(h["X-Bz-Info-foo"]).toBe(encodeURIComponent("bar baz"));
    expect(h["X-Bz-Server-Side-Encryption"]).toBe("SSE-C");
    expect(h["X-Bz-Server-Side-Encryption-Customer-Key"]).toBe(sse.customerKey);
  });

  it("rejects a fileInfo key that could inject a header", async () => {
    const result = await callTool(server, "b2_upload_file", {
      bucketId: "b",
      fileName: "f.txt",
      content: bytes.toString("base64"),
      fileInfo: { "bad\r\nX-Evil": "1" },
    });
    expect(result.isError).toBe(true);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
