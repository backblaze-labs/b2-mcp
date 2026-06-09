/**
 * Coverage for the streaming saveToPath download path (B2Client.downloadToFile)
 * — a GET with responseType "stream" piped to disk, exercised here with a mocked
 * axios stream so no network or large buffer is involved.
 */

import axios from "axios";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import { createServer } from "../../src/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { B2Config } from "../../src/utils/types";

jest.mock("axios");
const mockedAxios = axios as jest.MockedFunction<typeof axios> & {
  get: jest.MockedFunction<typeof axios.get>;
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

const config: B2Config = {
  applicationKeyId: "k",
  applicationKey: "s",
  appKeyId: "k",
  appKey: "s",
  masterKeyId: "s",
  masterKey: "s",
  region: "us-west-004",
  largeFileThreshold: 1e8,
  partSize: 1e8,
  allowLocalFiles: true,
  fileRoot: null,
};

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  const tool = (server as any)._registeredTools?.[name];
  const handler = tool.handler ?? tool.callback ?? tool.execute;
  return handler(args, {} as any);
}

let server: McpServer;
let dir: string;

beforeEach(() => {
  jest.clearAllMocks();
  // Auth GET returns auth; any other GET returns a readable stream "download".
  mockedAxios.get = jest.fn().mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("b2_authorize_account")) {
      return Promise.resolve({ data: mockAuthData });
    }
    return Promise.resolve({
      data: Readable.from([Buffer.from("hello-stream")]),
      headers: { "content-type": "text/plain", "content-length": "12" },
    });
  });
  server = createServer(config);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-dl-"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("streaming download to saveToPath", () => {
  it("b2_download_file_by_name streams the body to disk", async () => {
    const dest = path.join(dir, "out.txt");
    const result = await callTool(server, "b2_download_file_by_name", {
      bucketName: "bkt",
      fileName: "f.txt",
      saveToPath: dest,
    });
    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(dest, "utf8")).toBe("hello-stream");
  });

  it("b2_download_file_by_id streams the body to disk", async () => {
    const dest = path.join(dir, "byid.txt");
    const result = await callTool(server, "b2_download_file_by_id", {
      fileId: "4_zabc",
      saveToPath: dest,
    });
    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(dest, "utf8")).toBe("hello-stream");
  });
});
