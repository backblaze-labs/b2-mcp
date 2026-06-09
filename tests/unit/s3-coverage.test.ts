/**
 * Extra S3 coverage: the saveToPath stream branch, the filePath upload branch,
 * and the error (catch) paths across the S3 tool handlers — exercised by making
 * the mocked S3Client.send reject.
 */

import { S3Client } from "@aws-sdk/client-s3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import { createServer } from "../../src/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { B2Config } from "../../src/utils/types";

const testConfig: B2Config = {
  applicationKeyId: "k",
  applicationKey: "s",
  appKeyId: "k",
  appKey: "s",
  region: "us-west-004",
  largeFileThreshold: 100 * 1024 * 1024,
  partSize: 100 * 1024 * 1024,
  allowLocalFiles: true,
  fileRoot: null,
};

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  const tool = (server as any)._registeredTools?.[name];
  const handler = tool.handler ?? tool.callback ?? tool.execute;
  return handler(args, {} as any);
}

let server: McpServer;
let sendSpy: jest.SpyInstance;
let dir: string;

beforeEach(() => {
  server = createServer(testConfig);
  sendSpy = jest.spyOn(S3Client.prototype as any, "send").mockResolvedValue({} as any);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-s3-"));
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("s3_get_object saveToPath (stream branch)", () => {
  it("streams the object body to disk", async () => {
    sendSpy.mockResolvedValue({
      Body: Readable.from([Buffer.from("s3-stream")]),
      ContentLength: 9,
    });
    const dest = path.join(dir, "obj.bin");
    const result = await callTool(server, "s3_get_object", {
      bucket: "b",
      key: "k",
      saveToPath: dest,
    });
    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(dest, "utf8")).toBe("s3-stream");
  });
});

describe("s3_put_object filePath (stream branch)", () => {
  it("uploads from a local file", async () => {
    const file = path.join(dir, "up.bin");
    fs.writeFileSync(file, "from-disk");
    // The handler passes a ReadStream as Body; fully drain it (as the SDK would)
    // so the temp file is read and its fd closed before afterEach removes the dir.
    sendSpy.mockImplementation(async (cmd: any) => {
      const body = cmd?.input?.Body;
      if (body && typeof body.resume === "function") {
        await new Promise<void>((r) => {
          body.on("end", () => r());
          body.on("error", () => r());
          body.resume();
        });
      }
      return {};
    });
    const result = await callTool(server, "s3_put_object", {
      bucket: "b",
      key: "k",
      filePath: file,
    });
    expect(result.isError).toBeFalsy();
    expect(sendSpy).toHaveBeenCalled();
  });
});

describe("S3 tool error paths (catch blocks)", () => {
  // Args superset — every tool finds what it needs; extras are ignored.
  const args = {
    bucket: "b",
    key: "k",
    objects: [{ key: "k" }],
    uploadId: "u",
    partNumber: 1,
    content: Buffer.from("x").toString("base64"),
    acl: "private",
    sourceBucket: "b",
    sourceKey: "k",
    destinationBucket: "b",
    destinationKey: "k",
    copySource: "b/k",
    retainUntilDate: "2030-01-01T00:00:00Z",
    mode: "GOVERNANCE",
    legalHold: "ON",
  };

  // Every S3 tool that calls the SDK (all but the presigned URL generator).
  const tools = [
    "s3_create_bucket",
    "s3_delete_bucket",
    "s3_head_bucket",
    "s3_list_objects",
    "s3_get_bucket_acl",
    "s3_put_bucket_acl",
    "s3_get_bucket_versioning",
    "s3_put_bucket_versioning",
    "s3_get_bucket_cors",
    "s3_put_bucket_cors",
    "s3_delete_bucket_cors",
    "s3_get_bucket_location",
    "s3_get_bucket_encryption",
    "s3_put_bucket_encryption",
    "s3_delete_bucket_encryption",
    "s3_get_bucket_lifecycle",
    "s3_put_bucket_lifecycle",
    "s3_delete_bucket_lifecycle",
    "s3_get_bucket_logging",
    "s3_put_bucket_logging",
    "s3_put_object",
    "s3_get_object",
    "s3_delete_object",
    "s3_delete_objects",
    "s3_head_object",
    "s3_copy_object",
    "s3_list_objects_v2",
    "s3_list_object_versions",
    "s3_get_object_acl",
    "s3_put_object_acl",
    "s3_create_multipart_upload",
    "s3_upload_part",
    "s3_complete_multipart_upload",
    "s3_abort_multipart_upload",
    "s3_list_multipart_uploads",
    "s3_list_parts",
    "s3_upload_part_copy",
    "s3_get_object_lock_configuration",
    "s3_put_object_lock_configuration",
    "s3_get_object_legal_hold",
    "s3_put_object_legal_hold",
    "s3_get_object_retention",
    "s3_put_object_retention",
  ];

  it.each(tools)("%s returns a structured error when the SDK rejects", async (tool) => {
    sendSpy.mockRejectedValue({
      name: "AccessDenied",
      message: "denied",
      $metadata: { httpStatusCode: 403, requestId: "rq" },
    });
    const result = await callTool(server, tool, args);
    expect(result.isError).toBe(true);
  });
});
