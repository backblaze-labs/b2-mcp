import { ReadableStream } from "node:stream/web";
import { registerS3ObjectTools } from "../../src/s3/objects";
import type { B2S3DownloadedObject } from "../../src/s3/aws-sdk-adapter";
import { circuitBreaker } from "../../src/utils/circuit-breaker";
import { ToolHarness, parseResult, testConfig } from "../support/deterministic-fakes";

function streamFrom(chunks: Uint8Array[], onCancel: () => void = () => undefined) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      onCancel();
    },
  });
}

function downloadedObject(overrides: Partial<B2S3DownloadedObject> = {}): B2S3DownloadedObject {
  const body = streamFrom([new TextEncoder().encode("hello")]);
  return {
    key: "hello.txt",
    contentType: "text/plain",
    contentLength: 5,
    lastModified: new Date("2026-01-01T00:00:00.000Z"),
    etag: '"etag"',
    versionId: "version-hello",
    metadata: { owner: "fixture" },
    body,
    ...overrides,
  };
}

describe("S3 object tools with deterministic handler fake", () => {
  let tools: ToolHarness;
  let calls: Array<{ operation: string; input: any }> = [];
  let nextDownload: B2S3DownloadedObject = downloadedObject();
  let nextListObjects = {
    objects: [],
    commonPrefixes: [],
    isTruncated: false,
    keyCount: 0,
  };

  beforeEach(() => {
    calls = [];
    nextDownload = downloadedObject();
    nextListObjects = {
      objects: [],
      commonPrefixes: [],
      isTruncated: false,
      keyCount: 0,
    };
    const s3 = {
      async putObject(input: any) {
        calls.push({ operation: "putObject", input });
      },
      async getObject(input: any) {
        calls.push({ operation: "getObject", input });
        return nextDownload;
      },
      async deleteObject(input: any) {
        calls.push({ operation: "deleteObject", input });
      },
      async deleteObjects(input: any) {
        calls.push({ operation: "deleteObjects", input });
        return {
          deleted: input.quiet ? [] : input.objects.map((object: any) => ({ Key: object.key })),
          errors: [],
          attempted: input.objects.length,
          aborted: false,
          maxConcurrency: 1,
        };
      },
      async headObject(input: any) {
        calls.push({ operation: "headObject", input });
        return {
          ...downloadedObject(),
          serverSideEncryption: "AES256",
          deleteMarker: false,
        };
      },
      async copyObject(input: any) {
        calls.push({ operation: "copyObject", input });
      },
      async listObjectsV2(input: any) {
        calls.push({ operation: "listObjectsV2", input });
        return nextListObjects;
      },
      async listObjectVersions(input: any) {
        calls.push({ operation: "listObjectVersions", input });
        return {
          versions: [],
          deleteMarkers: [],
          commonPrefixes: [],
          isTruncated: false,
        };
      },
    };
    tools = new ToolHarness();
    registerS3ObjectTools(tools, s3 as any, testConfig);
  });

  afterEach(() => {
    circuitBreaker.close();
  });

  it("uploads base64 content without touching the filesystem", async () => {
    const result = await tools.call("s3_put_object", {
      bucket: "b",
      key: "hello.txt",
      content: Buffer.from("hello").toString("base64"),
      contentType: "text/plain",
      metadata: { owner: "fixture" },
      serverSideEncryption: "AES256",
    });

    expect(result.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({
      operation: "putObject",
      input: {
        bucket: "b",
        key: "hello.txt",
        contentType: "text/plain",
        metadata: { owner: "fixture" },
        serverSideEncryption: "AES256",
      },
    });
    expect(Buffer.from(calls[0].input.body).toString()).toBe("hello");
  });

  it("returns small inline objects and forwards list pagination arguments", async () => {
    const getResult = parseResult(
      await tools.call("s3_get_object", { bucket: "b", key: "hello.txt", range: "bytes=0-4" }),
    );
    nextListObjects = {
      objects: [{ Key: "a.txt", Size: 1, LastModified: new Date(), StorageClass: "STANDARD" }],
      commonPrefixes: [{ Prefix: "folder/" }],
      isTruncated: true,
      nextContinuationToken: "next",
      keyCount: 1,
    } as any;
    const listResult = parseResult(
      await tools.call("s3_list_objects_v2", {
        bucket: "b",
        prefix: "a",
        delimiter: "/",
        maxKeys: 1,
        continuationToken: "token",
      }),
    );

    expect(getResult.content).toBe(Buffer.from("hello").toString("base64"));
    expect(listResult).toMatchObject({
      isTruncated: true,
      nextContinuationToken: "next",
      keyCount: 1,
    });
    expect(calls.find((call) => call.operation === "listObjectsV2")?.input).toMatchObject({
      bucket: "b",
      prefix: "a",
      delimiter: "/",
      maxKeys: 1,
      continuationToken: "token",
    });
  });

  it("cancels inline reads with invalid or oversized content lengths", async () => {
    let invalidCanceled = 0;
    nextDownload = downloadedObject({
      contentLength: -1,
      body: streamFrom([new Uint8Array([1])], () => invalidCanceled++),
    });
    const invalid = await tools.call("s3_get_object", { bucket: "b", key: "bad.txt" });
    expect(invalid.isError).toBe(true);
    expect(invalidCanceled).toBe(1);

    let largeCanceled = 0;
    nextDownload = downloadedObject({
      contentLength: 1024 * 1024 + 1,
      body: streamFrom([new Uint8Array([1])], () => largeCanceled++),
    });
    const large = await tools.call("s3_get_object", { bucket: "b", key: "large.bin" });
    expect(large.isError).toBe(true);
    expect(largeCanceled).toBe(1);
  });

  it("enforces destructive confirmation on object delete calls", async () => {
    const blocked = await tools.call("s3_delete_objects", {
      bucket: "b",
      objects: [{ key: "a.txt" }],
    });
    expect(blocked.isError).toBe(true);
    expect(calls.some((call) => call.operation === "deleteObjects")).toBe(false);

    const blockedBypass = parseResult(
      await tools.call("s3_delete_objects", {
        bucket: "b",
        objects: [{ key: "a.txt", versionId: "v1" }],
        bypassGovernance: true,
      }),
    );
    expect(blockedBypass).toContain("bypass governance-mode Object Lock retention");
    expect(calls.some((call) => call.operation === "deleteObjects")).toBe(false);

    const allowed = parseResult(
      await tools.call("s3_delete_objects", {
        bucket: "b",
        objects: [{ key: "a.txt" }],
        quiet: false,
        confirm: true,
      }),
    );
    expect(allowed).toMatchObject({ attempted: 1, aborted: false, maxConcurrency: 1 });
    expect(calls.find((call) => call.operation === "deleteObjects")?.input).toMatchObject({
      quiet: false,
    });
  });
});
