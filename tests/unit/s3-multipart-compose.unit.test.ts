import { B2S3PeerClient } from "../../src/s3/aws-sdk-adapter";
import { registerS3MultipartTools } from "../../src/s3/multipart";
import { circuitBreaker, s3CircuitBreaker } from "../../src/utils/circuit-breaker";
import {
  DeterministicS3ClientFake,
  ToolHarness,
  parseResult,
  s3ServiceError,
  testConfig,
} from "../support/deterministic-fakes";

type SdkCommand = { constructor: { name: string }; input: Record<string, unknown> };

/**
 * Tool handlers backed by the real AWS SDK adapter with both of its transport
 * seams stubbed: `sendCommand` for read-style calls and `mutationClient().send`
 * for the no-replay completion call. Assertions see the exact SDK command
 * inputs, and the request handler refuses any real network I/O.
 */
function adapterBackedTools() {
  const peer = new B2S3PeerClient({
    region: "us-west-004",
    endpoint: "https://s3.us-west-004.backblazeb2.com",
    credentials: { accessKeyId: "key-id", secretAccessKey: "key-secret" },
    forcePathStyle: true,
    requestHandler: {
      handle: () => Promise.reject(new Error("network access is not allowed in unit tests")),
      updateHttpClientConfig() {
        return undefined;
      },
      httpHandlerConfigs() {
        return {};
      },
    } as any,
  });
  const send = vi.spyOn(peer as any, "sendCommand");
  const mutationSend = vi.fn();
  vi.spyOn(peer as any, "mutationClient").mockReturnValue({ send: mutationSend });
  const tools = new ToolHarness();
  registerS3MultipartTools(tools, peer, testConfig);
  const commands = () =>
    [...send.mock.calls, ...mutationSend.mock.calls].map((call) => call[0] as SdkCommand);
  return { peer, send, mutationSend, tools, commands };
}

afterEach(() => {
  vi.restoreAllMocks();
  circuitBreaker.close();
  s3CircuitBreaker.close();
});

describe("s3_upload_part_copy SDK mapping", () => {
  it("maps copySourceRange to the SDK CopySourceRange", async () => {
    const { peer, send, tools, commands } = adapterBackedTools();
    send.mockResolvedValueOnce({ CopyPartResult: { ETag: '"copied"' } });

    const result = await tools.call("s3_upload_part_copy", {
      bucket: "dest",
      key: "assembled.bin",
      uploadId: "upload-1",
      partNumber: 2,
      copySource: "src-bucket/source.bin",
      copySourceRange: "bytes=5242880-10485759",
    });

    expect(result.isError).toBeFalsy();
    expect(parseResult(result)).toMatchObject({ partNumber: 2, etag: '"copied"' });
    const [command] = commands();
    expect(command.constructor.name).toBe("UploadPartCopyCommand");
    expect(command.input).toMatchObject({
      Bucket: "dest",
      Key: "assembled.bin",
      UploadId: "upload-1",
      PartNumber: 2,
      CopySource: "src-bucket/source.bin",
      CopySourceRange: "bytes=5242880-10485759",
    });
    peer.destroy();
  });

  it("omits CopySourceRange when no range is requested", async () => {
    const { peer, send, tools, commands } = adapterBackedTools();
    send.mockResolvedValueOnce({ CopyPartResult: { ETag: '"whole"' } });

    await tools.call("s3_upload_part_copy", {
      bucket: "dest",
      key: "assembled.bin",
      uploadId: "upload-1",
      partNumber: 1,
      copySource: "src-bucket/source.bin",
    });

    expect(commands()[0].input.CopySourceRange).toBeUndefined();
    peer.destroy();
  });

  it("forwards a caller-encoded key and appends the source versionId", async () => {
    const { peer, send, tools, commands } = adapterBackedTools();
    send.mockResolvedValueOnce({ CopyPartResult: { ETag: '"versioned"' } });

    await tools.call("s3_upload_part_copy", {
      bucket: "dest",
      key: "assembled.bin",
      uploadId: "upload-1",
      partNumber: 3,
      copySource: "src-bucket/dir/my%20file%2B1.bin",
      copySourceRange: "bytes=0-5242879",
      copySourceVersionId: "4_z0123456789_f200_d2026",
    });

    expect(commands()[0].input).toMatchObject({
      CopySource: "src-bucket/dir/my%20file%2B1.bin?versionId=4_z0123456789_f200_d2026",
      CopySourceRange: "bytes=0-5242879",
    });
    peer.destroy();
  });
});

describe("s3_complete_multipart_upload SDK mapping", () => {
  it("sends parts in the supplied ascending order with numbers and ETags", async () => {
    const { peer, mutationSend: send, tools, commands } = adapterBackedTools();
    send.mockResolvedValueOnce({
      Location: "https://example.invalid/dest/big.bin",
      Bucket: "dest",
      Key: "big.bin",
      ETag: '"final-3"',
    });

    const result = await tools.call("s3_complete_multipart_upload", {
      bucket: "dest",
      key: "big.bin",
      uploadId: "upload-1",
      parts: [
        { partNumber: 1, etag: '"e1"' },
        { partNumber: 2, etag: '"e2"' },
        { partNumber: 3, etag: '"e3"' },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect(parseResult(result)).toEqual({
      location: "https://example.invalid/dest/big.bin",
      bucket: "dest",
      key: "big.bin",
      etag: '"final-3"',
    });
    const [command] = commands();
    expect(command.constructor.name).toBe("CompleteMultipartUploadCommand");
    expect(command.input).toMatchObject({
      Bucket: "dest",
      Key: "big.bin",
      UploadId: "upload-1",
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: '"e1"' },
          { PartNumber: 2, ETag: '"e2"' },
          { PartNumber: 3, ETag: '"e3"' },
        ],
      },
    });
    peer.destroy();
  });

  it("returns a tool error naming InvalidPart when an ETag is stale or mismatched", async () => {
    const { peer, mutationSend: send, tools } = adapterBackedTools();
    send.mockRejectedValueOnce(
      s3ServiceError(
        "InvalidPart",
        "One or more of the specified parts could not be found or the ETag did not match.",
        400,
        "rq-stale",
      ),
    );

    const result = await tools.call("s3_complete_multipart_upload", {
      bucket: "dest",
      key: "big.bin",
      uploadId: "upload-1",
      parts: [{ partNumber: 1, etag: '"stale"' }],
    });

    expect(result.isError).toBe(true);
    const text = parseResult(result) as string;
    expect(text).toContain("InvalidPart");
    expect(text).toContain("ETag did not match");
    peer.destroy();
  });
});

describe("s3_list_parts SDK mapping and pagination", () => {
  it("maps maxParts and partNumberMarker and surfaces the next marker", async () => {
    const { peer, send, tools, commands } = adapterBackedTools();
    send
      .mockResolvedValueOnce({
        Parts: [
          { PartNumber: 1, ETag: '"e1"', Size: 5242880 },
          { PartNumber: 2, ETag: '"e2"', Size: 5242880 },
        ],
        IsTruncated: true,
        NextPartNumberMarker: "2",
      })
      .mockResolvedValueOnce({
        Parts: [{ PartNumber: 3, ETag: '"e3"', Size: 1024 }],
        IsTruncated: false,
      });

    const first = parseResult(
      await tools.call("s3_list_parts", {
        bucket: "dest",
        key: "big.bin",
        uploadId: "upload-1",
        maxParts: 2,
      }),
    );
    expect(first).toMatchObject({ isTruncated: true, nextPartNumberMarker: "2" });
    expect(first.parts.map((part: { PartNumber: number }) => part.PartNumber)).toEqual([1, 2]);

    const second = parseResult(
      await tools.call("s3_list_parts", {
        bucket: "dest",
        key: "big.bin",
        uploadId: "upload-1",
        maxParts: 2,
        partNumberMarker: 2,
      }),
    );
    expect(second.isTruncated).toBe(false);
    expect(second.nextPartNumberMarker).toBeUndefined();
    expect(second.parts.map((part: { PartNumber: number }) => part.PartNumber)).toEqual([3]);

    const [firstCommand, secondCommand] = commands();
    expect(firstCommand.constructor.name).toBe("ListPartsCommand");
    expect(firstCommand.input).toMatchObject({ MaxParts: 2 });
    expect(firstCommand.input.PartNumberMarker).toBeUndefined();
    expect(secondCommand.input).toMatchObject({ MaxParts: 2, PartNumberMarker: "2" });
    peer.destroy();
  });

  it("defaults maxParts to 100 when omitted", async () => {
    const { peer, send, tools, commands } = adapterBackedTools();
    send.mockResolvedValueOnce({ Parts: [], IsTruncated: false });

    await tools.call("s3_list_parts", { bucket: "dest", key: "big.bin", uploadId: "upload-1" });

    expect(commands()[0].input).toMatchObject({ MaxParts: 100 });
    peer.destroy();
  });
});

describe("resume flow: list uploads, list parts, presign only the missing parts", () => {
  it("presigns just the part numbers that are not yet uploaded", async () => {
    const s3 = new DeterministicS3ClientFake();
    s3.allowDefault("presignUploadPart");
    const tools = new ToolHarness();
    registerS3MultipartTools(tools, s3.asPeerClient(), testConfig);
    const totalParts = 5;

    s3.respond("listMultipartUploads", {
      uploads: [{ Key: "big.bin", UploadId: "upload-1" }],
      commonPrefixes: [],
      isTruncated: false,
    });
    s3.respond(
      "listParts",
      {
        parts: [
          { PartNumber: 1, ETag: '"e1"', Size: 5242880 },
          { PartNumber: 2, ETag: '"e2"', Size: 5242880 },
        ],
        isTruncated: true,
        nextPartNumberMarker: "2",
      },
      {
        parts: [{ PartNumber: 4, ETag: '"e4"', Size: 5242880 }],
        isTruncated: false,
      },
    );

    const uploads = parseResult(
      await tools.call("s3_list_multipart_uploads", { bucket: "dest", prefix: "big.bin" }),
    );
    const upload = uploads.uploads[0];
    expect(upload).toMatchObject({ Key: "big.bin", UploadId: "upload-1" });

    const uploaded = new Set<number>();
    let marker: number | undefined;
    for (;;) {
      const page = parseResult(
        await tools.call("s3_list_parts", {
          bucket: "dest",
          key: upload.Key,
          uploadId: upload.UploadId,
          maxParts: 2,
          partNumberMarker: marker,
        }),
      );
      for (const part of page.parts) uploaded.add(part.PartNumber);
      if (!page.isTruncated) break;
      marker = Number(page.nextPartNumberMarker);
    }
    expect([...uploaded]).toEqual([1, 2, 4]);
    expect(s3.requestsFor("listParts").map((request) => request.input)).toMatchObject([
      { maxParts: 2 },
      { maxParts: 2, partNumberMarker: 2 },
    ]);

    const missing = Array.from({ length: totalParts }, (_, index) => index + 1).filter(
      (partNumber) => !uploaded.has(partNumber),
    );
    const presigned = parseResult(
      await tools.call("s3_get_presigned_upload_part_url", {
        bucket: "dest",
        key: upload.Key,
        uploadId: upload.UploadId,
        partNumbers: missing,
      }),
    );

    expect(s3.requestsFor("presignUploadPart").map((request) => request.input)).toMatchObject([
      { partNumber: 3, uploadId: "upload-1" },
      { partNumber: 5, uploadId: "upload-1" },
    ]);
    expect(presigned.parts.map((part: { partNumber: number }) => part.partNumber)).toEqual([3, 5]);
  });
});
