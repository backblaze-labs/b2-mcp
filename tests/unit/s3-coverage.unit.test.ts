/**
 * Extra S3 coverage: the error (catch) paths across the retained S3 tool
 * handlers — exercised by making the mocked S3Client.send reject.
 */

import { S3Client } from "@aws-sdk/client-s3";
import { createServer } from "../../src/server";
import type { McpServer } from "../../src/mcp";
import { callTool, testConfig } from "../support/deterministic-fakes";
import type { MockInstance } from "vitest";

let server: McpServer;
let sendSpy: MockInstance;

beforeEach(() => {
  sendSpy = vi.spyOn(S3Client.prototype as any, "send").mockResolvedValue({} as any);
  server = createServer(testConfig);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("S3 tool error paths (catch blocks)", () => {
  // Args superset — every tool finds what it needs; extras are ignored.
  const args = {
    bucket: "b",
    key: "k",
    rules: [{ id: "r", status: "Enabled" }],
  };

  // The retained S3 tools that call the SDK (presigned URL generator excluded —
  // it does not call SDK.send).
  const tools = ["s3_head_bucket", "s3_put_bucket_lifecycle", "s3_get_bucket_location"];

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
