import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import { registerS3ObjectTools } from "../../src/s3/objects";
import type { B2S3FileVersionBinding } from "../../src/b2/s3-version-guard";
import type { B2S3DownloadedObject } from "../../src/s3/aws-sdk-adapter";
import { runWithMcpRequestSignal } from "../../src/request-context";
import { circuitBreaker } from "../../src/utils/circuit-breaker";
import { ToolHarness, parseResult, testConfig } from "../support/deterministic-fakes";

function streamFrom(
  chunks: Uint8Array[],
  onCancel: () => void = () => undefined,
): B2S3DownloadedObject["body"] {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      onCancel();
    },
  }) as unknown as B2S3DownloadedObject["body"];
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

function fileVersion(overrides: Partial<B2S3FileVersionBinding> = {}): B2S3FileVersionBinding {
  return {
    fileName: "hello.txt",
    fileId: "version-hello",
    bucketId: "bucket-id",
    contentLength: 5,
    contentType: "text/plain",
    uploadTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
    fileInfo: { owner: "fixture" },
    action: "upload",
    serverSideEncryption: "AES256",
    ...overrides,
  };
}

function notFound(message = "Object not found") {
  return Object.assign(new Error(message), { status: 404, code: "not_found" });
}

describe("S3 object tools with deterministic handler fake", () => {
  let tools: ToolHarness;
  let calls: Array<{ operation: string; input: any }> = [];
  let nextDownload: B2S3DownloadedObject = downloadedObject();
  let currentVersion: B2S3FileVersionBinding | null = null;
  const versions = new Map<string, B2S3FileVersionBinding>();
  const bucketIds = new Map([["b", "bucket-id"]]);
  let nextListObjects = {
    objects: [],
    commonPrefixes: [],
    isTruncated: false,
    keyCount: 0,
  };

  beforeEach(() => {
    calls = [];
    nextDownload = downloadedObject();
    currentVersion = null;
    versions.clear();
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
    const versionGuard = {
      async resolveS3FileVersion(input: { bucket: string; key: string; versionId: string }) {
        const version = versions.get(input.versionId);
        if (
          !version ||
          version.fileName !== input.key ||
          version.bucketId !== (bucketIds.get(input.bucket) ?? input.bucket)
        ) {
          throw notFound(`Object '${input.key}' not found in bucket '${input.bucket}'.`);
        }
        return version;
      },
      async getCurrentS3FileVersion() {
        return currentVersion;
      },
    };
    tools = new ToolHarness();
    registerS3ObjectTools(tools, s3 as any, versionGuard, testConfig);
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
      objects: [{ key: "a.txt", size: 1, lastModified: new Date(), storageClass: "STANDARD" }],
      commonPrefixes: [{ prefix: "folder/" }],
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

  it("destroys the body when inline reading aborts after headers", async () => {
    let markReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const body = new Readable({
      read() {
        markReadStarted();
      },
    });
    const destroySpy = vi.spyOn(body, "destroy");
    nextDownload = downloadedObject({
      contentLength: 1,
      body: body as B2S3DownloadedObject["body"],
    });
    const controller = new AbortController();

    const pending = runWithMcpRequestSignal(controller.signal, () =>
      tools.call("s3_get_object", { bucket: "b", key: "hello.txt" }),
    );
    await readStarted;
    controller.abort(new Error("client disconnected"));
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(destroySpy).toHaveBeenCalled();
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

  it("refuses mismatched version IDs before read, head, delete, deleteObjects, and copy", async () => {
    versions.set("secret-version", fileVersion({ fileName: "secret/private.txt" }));

    const get = await tools.call("s3_get_object", {
      bucket: "b",
      key: "public/allowed.txt",
      versionId: "secret-version",
    });
    const head = await tools.call("s3_head_object", {
      bucket: "b",
      key: "public/allowed.txt",
      versionId: "secret-version",
    });
    const oneDelete = await tools.call("s3_delete_object", {
      bucket: "b",
      key: "public/allowed.txt",
      versionId: "secret-version",
      confirm: true,
    });
    const manyDelete = parseResult(
      await tools.call("s3_delete_objects", {
        bucket: "b",
        objects: [{ key: "public/allowed.txt", versionId: "secret-version" }],
        confirm: true,
      }),
    );
    const copy = await tools.call("s3_copy_object", {
      sourceBucket: "b",
      sourceKey: "public/allowed.txt",
      sourceVersionId: "secret-version",
      destinationBucket: "b",
      destinationKey: "copy.txt",
    });

    expect(get.isError).toBe(true);
    expect(head.isError).toBe(true);
    expect(oneDelete.isError).toBe(true);
    expect(manyDelete).toMatchObject({
      deleted: [],
      attempted: 1,
      errors: [
        {
          Key: "public/allowed.txt",
          VersionId: "secret-version",
          Code: "not_found",
        },
      ],
    });
    expect(copy.isError).toBe(true);
    expect(calls.some((call) => call.operation === "getObject")).toBe(false);
    expect(calls.some((call) => call.operation === "headObject")).toBe(false);
    expect(calls.some((call) => call.operation === "deleteObject")).toBe(false);
    expect(calls.some((call) => call.operation === "deleteObjects")).toBe(false);
    expect(calls.some((call) => call.operation === "copyObject")).toBe(false);
  });

  it("keeps bulk delete partial results when one version binding is invalid", async () => {
    versions.set(
      "allowed-version",
      fileVersion({ fileName: "public/allowed.txt", fileId: "allowed-version" }),
    );
    versions.set("secret-version", fileVersion({ fileName: "secret/private.txt" }));

    const result = parseResult(
      await tools.call("s3_delete_objects", {
        bucket: "b",
        objects: [
          { key: "public/allowed.txt", versionId: "allowed-version" },
          { key: "public/blocked.txt", versionId: "secret-version" },
          { key: "public/latest.txt" },
        ],
        quiet: false,
        confirm: true,
      }),
    );

    expect(result).toMatchObject({
      deleted: [{ Key: "public/allowed.txt" }, { Key: "public/latest.txt" }],
      attempted: 3,
      errors: [
        {
          Key: "public/blocked.txt",
          VersionId: "secret-version",
          Code: "not_found",
        },
      ],
    });
    expect(calls.find((call) => call.operation === "deleteObjects")?.input.objects).toEqual([
      { key: "public/allowed.txt", versionId: "allowed-version" },
      { key: "public/latest.txt" },
    ]);
  });

  it("reports deleteMarker for current and explicit hide-marker versions", async () => {
    currentVersion = fileVersion({ action: "hide", fileId: "hide-current" });
    const current = parseResult(
      await tools.call("s3_head_object", { bucket: "b", key: "hello.txt" }),
    );

    versions.set("hide-explicit", fileVersion({ action: "hide", fileId: "hide-explicit" }));
    const explicit = parseResult(
      await tools.call("s3_head_object", {
        bucket: "b",
        key: "hello.txt",
        versionId: "hide-explicit",
      }),
    );

    expect(current).toMatchObject({
      key: "hello.txt",
      versionId: "hide-current",
      deleteMarker: true,
    });
    expect(explicit).toMatchObject({
      key: "hello.txt",
      versionId: "hide-explicit",
      deleteMarker: true,
    });
    expect(calls.some((call) => call.operation === "headObject")).toBe(false);
  });
});
