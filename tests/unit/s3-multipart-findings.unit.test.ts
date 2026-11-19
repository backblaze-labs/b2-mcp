import { S3Client, UploadPartCopyCommand } from "@aws-sdk/client-s3";
import type { MockInstance } from "vitest";
import { B2Client } from "../../src/b2/client";
import type { McpServer } from "../../src/mcp";
import { createServer, invalidateAuthManagerCache } from "../../src/server";
import { circuitBreaker, s3CircuitBreaker } from "../../src/utils/circuit-breaker";
import { parseErrorText } from "../../src/utils/errors";
import { callTool, parseResult, testConfig } from "../support/deterministic-fakes";
import { restoreB2SdkTransportForTests } from "../support/sdk-factory-hook";
import { installAuthorizedS3Transport } from "../support/sdk-test-helpers";

let server: McpServer;
let sendSpy: MockInstance;
let versionSpy: MockInstance<B2Client["resolveS3FileVersion"]>;

const input = {
  bucket: "destination-bucket",
  key: "assembled.bin",
  uploadId: "upload-1",
  partNumber: 1,
  copySource: "source-bucket/dir/my%20file%2B1.bin",
};

function copyCommands(): UploadPartCopyCommand[] {
  return sendSpy.mock.calls
    .map(([command]) => command)
    .filter(
      (command): command is UploadPartCopyCommand => command instanceof UploadPartCopyCommand,
    );
}

beforeEach(() => {
  invalidateAuthManagerCache();
  installAuthorizedS3Transport();
  sendSpy = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
    CopyPartResult: { ETag: '"copied"' },
  } as never);
  versionSpy = vi
    .spyOn(B2Client.prototype, "resolveS3FileVersion")
    .mockImplementation(async ({ key, versionId }) => ({
      fileName: key,
      fileId: versionId,
      bucketId: "source-bucket-id",
      contentLength: 10,
      contentType: "application/octet-stream",
      uploadTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
      fileInfo: {},
      action: "upload",
    }));
  server = createServer(testConfig);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreB2SdkTransportForTests();
  circuitBreaker.close();
  s3CircuitBreaker.close();
  invalidateAuthManagerCache();
});

describe("Finding C15: s3_upload_part_copy source-version binding", () => {
  it("binds the version to the decoded source bucket and key before copying", async () => {
    const result = await callTool(server, "s3_upload_part_copy", {
      ...input,
      copySourceVersionId: "verified-version",
    });

    expect(result.isError).toBeFalsy();
    expect(versionSpy).toHaveBeenCalledExactlyOnceWith({
      bucket: "source-bucket",
      key: "dir/my file+1.bin",
      versionId: "verified-version",
    });
    expect(copyCommands()).toHaveLength(1);
    expect(copyCommands()[0].input.CopySource).toBe(
      "source-bucket/dir/my%20file%2B1.bin?versionId=verified-version",
    );
    expect(parseResult(result)).toMatchObject({ partNumber: 1, etag: '"copied"' });
  });

  it.each(["foreign-version", "verified-version&versionId=foreign-version"])(
    "refuses unverified source version %s without issuing a copy",
    async (versionId) => {
      versionSpy.mockRejectedValueOnce(
        Object.assign(new Error("Source version does not belong to this object"), {
          status: 404,
          code: "not_found",
        }),
      );
      const result = await callTool(server, "s3_upload_part_copy", {
        ...input,
        copySourceVersionId: versionId,
      });

      expect(result.isError).toBe(true);
      expect(parseErrorText(parseResult(result) as string)).toMatchObject({
        status: 404,
        code: "not_found",
      });
      expect(versionSpy).toHaveBeenCalledExactlyOnceWith({
        bucket: "source-bucket",
        key: "dir/my file+1.bin",
        versionId,
      });
      expect(copyCommands()).toHaveLength(0);
    },
  );

  it("encodes a verified version ID as one query value", async () => {
    const result = await callTool(server, "s3_upload_part_copy", {
      ...input,
      copySourceVersionId: "verified+/?&=%#version",
    });

    expect(result.isError).toBeFalsy();
    expect(versionSpy).toHaveBeenCalledExactlyOnceWith({
      bucket: "source-bucket",
      key: "dir/my file+1.bin",
      versionId: "verified+/?&=%#version",
    });
    expect(copyCommands()).toHaveLength(1);
    expect(copyCommands()[0].input.CopySource).toBe(
      "source-bucket/dir/my%20file%2B1.bin?versionId=verified%2B%2F%3F%26%3D%25%23version",
    );
  });

  it("binds an embedded version to the decoded source before copying", async () => {
    const result = await callTool(server, "s3_upload_part_copy", {
      ...input,
      copySource: "source-bucket/dir/my%20file%2B1.bin?versionId=verified%2Bversion",
    });

    expect(result.isError).toBeFalsy();
    expect(versionSpy).toHaveBeenCalledExactlyOnceWith({
      bucket: "source-bucket",
      key: "dir/my file+1.bin",
      versionId: "verified+version",
    });
    expect(copyCommands()).toHaveLength(1);
    expect(copyCommands()[0].input.CopySource).toBe(
      "source-bucket/dir/my%20file%2B1.bin?versionId=verified%2Bversion",
    );
  });

  it("refuses an unverified embedded version without issuing a copy", async () => {
    versionSpy.mockRejectedValueOnce(
      Object.assign(new Error("Source version does not belong to this object"), {
        status: 404,
        code: "not_found",
      }),
    );
    const result = await callTool(server, "s3_upload_part_copy", {
      ...input,
      copySource: "source-bucket/source.bin?versionId=foreign-version",
    });

    expect(result.isError).toBe(true);
    expect(parseErrorText(parseResult(result) as string)).toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(versionSpy).toHaveBeenCalledExactlyOnceWith({
      bucket: "source-bucket",
      key: "source.bin",
      versionId: "foreign-version",
    });
    expect(copyCommands()).toHaveLength(0);
  });

  it("refuses conflicting embedded and separate versions", async () => {
    const result = await callTool(server, "s3_upload_part_copy", {
      ...input,
      copySource: "source-bucket/source.bin?versionId=foreign-version",
      copySourceVersionId: "verified-version",
    });

    expect(result.isError).toBe(true);
    expect(parseErrorText(parseResult(result) as string)).toMatchObject({
      status: 400,
      code: "bad_request",
    });
    expect(versionSpy).not.toHaveBeenCalled();
    expect(copyCommands()).toHaveLength(0);
  });

  it("accepts identical embedded and separate versions after one binding check", async () => {
    const result = await callTool(server, "s3_upload_part_copy", {
      ...input,
      copySource: "source-bucket/source.bin?versionId=verified%2Bversion",
      copySourceVersionId: "verified+version",
    });
    expect(result.isError).toBeFalsy();
    expect(versionSpy).toHaveBeenCalledExactlyOnceWith({
      bucket: "source-bucket",
      key: "source.bin",
      versionId: "verified+version",
    });
    expect(copyCommands()).toHaveLength(1);
    expect(copyCommands()[0].input.CopySource).toBe(
      "source-bucket/source.bin?versionId=verified%2Bversion",
    );
  });

  it.each([
    "source-bucket/source.bin?versionId=one&versionId=two",
    "source-bucket/source.bin?versionId=one&other=two",
    "source-bucket/source.bin?versionId=",
    "source-bucket/source.bin?versionId=bad%2",
    "source-bucket/source.bin?other=value",
  ])("refuses malformed embedded version query %s", async (copySource) => {
    const result = await callTool(server, "s3_upload_part_copy", { ...input, copySource });
    expect(result.isError).toBe(true);
    expect(parseErrorText(parseResult(result) as string)).toMatchObject({
      status: 400,
      code: "bad_request",
    });
    expect(versionSpy).not.toHaveBeenCalled();
    expect(copyCommands()).toHaveLength(0);
  });

  it("refuses embedded version copies without readFiles", async () => {
    server = createServer(testConfig, ["writeFiles"]);
    const result = await callTool(server, "s3_upload_part_copy", {
      ...input,
      copySource: "source-bucket/source.bin?versionId=verified-version",
    });
    expect(result.isError).toBe(true);
    expect(parseErrorText(parseResult(result) as string)).toMatchObject({
      status: 403,
      code: "missing_capability",
    });
    expect(versionSpy).not.toHaveBeenCalled();
    expect(copyCommands()).toHaveLength(0);
  });

  it("refuses version-targeted copies without readFiles", async () => {
    server = createServer(testConfig, ["writeFiles"]);
    const result = await callTool(server, "s3_upload_part_copy", {
      ...input,
      copySourceVersionId: "verified-version",
    });

    expect(result.isError).toBe(true);
    expect(parseErrorText(parseResult(result) as string)).toMatchObject({
      status: 403,
      code: "missing_capability",
    });
    expect(versionSpy).not.toHaveBeenCalled();
    expect(copyCommands()).toHaveLength(0);
  });

  it.each([
    "source-only",
    "source-bucket/",
    "source-bucket/bad%key",
    "source-bucket/source.bin#versionId=foreign-version",
  ])("refuses malformed or spliced copySource %s", async (copySource) => {
    const result = await callTool(server, "s3_upload_part_copy", {
      ...input,
      copySource,
      copySourceVersionId: "verified-version",
    });

    expect(result.isError).toBe(true);
    expect(parseErrorText(parseResult(result) as string)).toMatchObject({
      status: 400,
      code: "bad_request",
    });
    expect(versionSpy).not.toHaveBeenCalled();
    expect(copyCommands()).toHaveLength(0);
  });

  it("binds an encoded key literally and preserves an optional leading slash", async () => {
    const copySource = "/source-bucket/dir/my%3Ffile%23%2B%2Fpart.bin";
    const result = await callTool(server, "s3_upload_part_copy", {
      ...input,
      copySource,
      copySourceVersionId: "verified-version",
    });

    expect(result.isError).toBeFalsy();
    expect(versionSpy).toHaveBeenCalledExactlyOnceWith({
      bucket: "source-bucket",
      key: "dir/my?file#+/part.bin",
      versionId: "verified-version",
    });
    expect(copyCommands()).toHaveLength(1);
    expect(copyCommands()[0].input.CopySource).toBe(`${copySource}?versionId=verified-version`);
  });

  it("keeps unversioned copies working without a native version lookup", async () => {
    const result = await callTool(server, "s3_upload_part_copy", input);

    expect(result.isError).toBeFalsy();
    expect(versionSpy).not.toHaveBeenCalled();
    expect(copyCommands()).toHaveLength(1);
    expect(copyCommands()[0].input.CopySource).toBe(input.copySource);
  });
});
