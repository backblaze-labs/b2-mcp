/**
 * Cases for the multipart/copy tools: C10, C17, C18, C26. Each asserts the correct behavior.
 * The C10 and C26 defects they first recorded are fixed, so all four run as normal tests.
 */
import { S3Client } from "@aws-sdk/client-s3";
import { createServer, invalidateAuthManagerCache } from "../../src/server";
import { B2Client } from "../../src/b2/client";
import type { McpServer } from "../../src/mcp";
import { circuitBreaker, s3CircuitBreaker } from "../../src/utils/circuit-breaker";
import { callTool, testConfig } from "../support/deterministic-fakes";
import { installAuthorizedS3Transport } from "../support/sdk-test-helpers";
import { restoreB2SdkTransportForTests } from "../support/sdk-factory-hook";
import type { MockInstance } from "vitest";

let server: McpServer;
let sendSpy: MockInstance;

function commandsNamed(name: string) {
  return sendSpy.mock.calls.map((call) => call[0]).filter((c) => c.constructor.name === name);
}

beforeEach(() => {
  invalidateAuthManagerCache();
  installAuthorizedS3Transport();
  sendSpy = vi.spyOn(S3Client.prototype as any, "send").mockResolvedValue({} as any);
  vi.spyOn(B2Client.prototype, "resolveS3FileVersions").mockImplementation(async ({ objects }) =>
    objects.map((object) => ({ object, version: null })),
  );
  vi.spyOn(B2Client.prototype, "getCurrentS3FileVersion").mockResolvedValue(null);
  server = createServer(testConfig);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreB2SdkTransportForTests();
  circuitBreaker.close();
  s3CircuitBreaker.close();
  invalidateAuthManagerCache();
});

describe("Finding C17: s3_create_multipart_upload applies the content-type guard", () => {
  it("rejects a browser-executable content type like s3_put_object does", async () => {
    const result = await callTool(server, "s3_create_multipart_upload", {
      bucket: "b",
      key: "page.html",
      contentType: "text/html",
    });

    expect(result.isError, "text/html is refused").toBe(true);
    expect(commandsNamed("CreateMultipartUploadCommand"), "no create sent").toHaveLength(0);
  });
});

describe("Finding C18: s3_copy_object REPLACE applies the content-type guard", () => {
  it("rejects a browser-executable replacement content type", async () => {
    const result = await callTool(server, "s3_copy_object", {
      sourceBucket: "b",
      sourceKey: "a.bin",
      destinationBucket: "b",
      destinationKey: "page.html",
      metadataDirective: "REPLACE",
      contentType: "text/html",
    });

    expect(result.isError, "text/html is refused").toBe(true);
    expect(commandsNamed("CopyObjectCommand"), "no copy sent").toHaveLength(0);
  });
});

describe("Finding C26: create-multipart acl is a documented no-op and must not be sent", () => {
  it("does not forward ACL to CreateMultipartUpload", async () => {
    sendSpy.mockResolvedValue({ UploadId: "u", Bucket: "b", Key: "k" });

    const result = await callTool(server, "s3_create_multipart_upload", {
      bucket: "b",
      key: "k",
      contentType: "application/octet-stream",
      acl: "public-read",
    });

    expect(result.isError, "create succeeds").toBeFalsy();
    const creates = commandsNamed("CreateMultipartUploadCommand");
    expect(creates, "one create sent").toHaveLength(1);
    expect(creates[0].input.ACL, "ACL is not forwarded").toBeUndefined();
  });
});

describe("Finding C10: abort multipart upload does not use the retrying client", () => {
  it("sends AbortMultipartUpload through a client with a single attempt", async () => {
    let attempts: number | undefined;
    sendSpy.mockImplementation(async function (
      this: S3Client,
      command: { constructor: { name: string } },
    ) {
      if (command.constructor.name === "AbortMultipartUploadCommand") {
        const max = this.config.maxAttempts;
        attempts = typeof max === "function" ? await max() : Number(max);
      }
      return {};
    });

    const result = await callTool(server, "s3_abort_multipart_upload", {
      bucket: "b",
      key: "k",
      uploadId: "u",
      confirm: true,
    });

    expect(result.isError, "abort succeeds").toBeFalsy();
    expect(attempts, "abort command reached the client").toBeDefined();
    expect(attempts, "max attempts of the client used for the abort").toBe(1);
  });
});
