import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerS3ObjectTools } from "../../src/s3/objects";
import type { B2S3FileVersionBinding } from "../../src/utils/types";
import type { B2S3DownloadedObject } from "../../src/s3/aws-sdk-adapter";
import { runWithMcpRequestSignal } from "../../src/request-context";
import {
  circuitBreaker,
  s3CircuitBreaker,
  s3TransferCircuitBreaker,
} from "../../src/utils/circuit-breaker";
import { parseErrorText } from "../../src/utils/errors";
import { ToolHarness, parseResult, testConfig } from "../support/deterministic-fakes";

const MAX_INLINE_OBJECT_BYTES = 1024 * 1024;

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

function s3Error(name: string, status: number, message: string, requestId = `${name}-request`) {
  return Object.assign(new Error(message), {
    name,
    $metadata: { httpStatusCode: status, requestId },
  });
}

describe("S3 object tools with deterministic handler fake", () => {
  let tools: ToolHarness;
  let calls: Array<{ operation: string; input: any }> = [];
  let nextDownload: B2S3DownloadedObject = downloadedObject();
  let currentVersion: B2S3FileVersionBinding | null = null;
  let nextHeadObjectError: unknown = null;
  let nextCurrentVersionError: unknown = null;
  let nextBulkVersionLookupError: unknown = null;
  let operationErrors = new Map<string, unknown>();
  const versions = new Map<string, B2S3FileVersionBinding>();
  const bucketIds = new Map([["b", "bucket-id"]]);
  let bulkVersionLookups: Array<{
    bucket: string;
    objects: Array<{ key: string; versionId?: string }>;
  }> = [];
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
    nextHeadObjectError = null;
    nextCurrentVersionError = null;
    nextBulkVersionLookupError = null;
    operationErrors = new Map();
    versions.clear();
    bulkVersionLookups = [];
    nextListObjects = {
      objects: [],
      commonPrefixes: [],
      isTruncated: false,
      keyCount: 0,
    };
    const s3 = {
      async putObject(input: any) {
        calls.push({ operation: "putObject", input });
        if (operationErrors.has("putObject")) throw operationErrors.get("putObject");
      },
      async getObject(input: any) {
        calls.push({ operation: "getObject", input });
        if (operationErrors.has("getObject")) throw operationErrors.get("getObject");
        return nextDownload;
      },
      async deleteObject(input: any) {
        calls.push({ operation: "deleteObject", input });
        if (operationErrors.has("deleteObject")) throw operationErrors.get("deleteObject");
      },
      async deleteObjects(input: any) {
        calls.push({ operation: "deleteObjects", input });
        if (operationErrors.has("deleteObjects")) throw operationErrors.get("deleteObjects");
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
        if (operationErrors.has("headObject")) throw operationErrors.get("headObject");
        if (nextHeadObjectError) throw nextHeadObjectError;
        return {
          ...downloadedObject(),
          serverSideEncryption: "AES256",
          deleteMarker: false,
        };
      },
      async copyObject(input: any) {
        calls.push({ operation: "copyObject", input });
        if (operationErrors.has("copyObject")) throw operationErrors.get("copyObject");
      },
      async listObjectsV2(input: any) {
        calls.push({ operation: "listObjectsV2", input });
        if (operationErrors.has("listObjectsV2")) throw operationErrors.get("listObjectsV2");
        return nextListObjects;
      },
      async listObjectVersions(input: any) {
        calls.push({ operation: "listObjectVersions", input });
        if (operationErrors.has("listObjectVersions"))
          throw operationErrors.get("listObjectVersions");
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
      async resolveS3FileVersions(input: {
        bucket: string;
        objects: Array<{ key: string; versionId?: string }>;
      }) {
        if (nextBulkVersionLookupError) throw nextBulkVersionLookupError;
        bulkVersionLookups.push(input);
        return input.objects.map((object) => {
          if (object.versionId === undefined) return { object, version: null };
          const version = versions.get(object.versionId);
          if (
            !version ||
            version.fileName !== object.key ||
            version.bucketId !== (bucketIds.get(input.bucket) ?? input.bucket)
          ) {
            return {
              object,
              version: null,
              error: notFound(`Object '${object.key}' not found in bucket '${input.bucket}'.`),
            };
          }
          return { object, version };
        });
      },
      async getCurrentS3FileVersion() {
        if (nextCurrentVersionError) throw nextCurrentVersionError;
        return currentVersion;
      },
    };
    tools = new ToolHarness();
    registerS3ObjectTools(tools, s3 as any, versionGuard, testConfig);
  });

  afterEach(() => {
    circuitBreaker.close();
    s3CircuitBreaker.close();
    s3TransferCircuitBreaker.close();
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

  it("requires an inline upload source before calling S3", async () => {
    const result = await tools.call("s3_put_object", {
      bucket: "b",
      key: "empty.txt",
      contentType: "text/plain",
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/Either filePath or content/);
    expect(calls).toEqual([]);
  });

  it("uploads a small local file through the inline filePath branch", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-inline-put-"));
    const filePath = path.join(dir, "manifest.json");
    try {
      fs.writeFileSync(filePath, '{"ok":true}');

      const result = await tools.call("s3_put_object", {
        bucket: "b",
        key: "manifest.json",
        filePath,
        contentType: "application/json",
      });

      expect(result.isError).toBeFalsy();
      expect(calls[0]).toMatchObject({
        operation: "putObject",
        input: {
          bucket: "b",
          key: "manifest.json",
          contentLength: 11,
          contentType: "application/json",
        },
      });
      expect(Buffer.from(calls[0].input.body).toString()).toBe('{"ok":true}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
      objects: [{ Key: "a.txt", Size: 1, StorageClass: "STANDARD" }],
      commonPrefixes: [{ Prefix: "folder/" }],
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

  it("reads inline objects from node and transformToWebStream bodies", async () => {
    nextDownload = downloadedObject({
      contentLength: 5,
      body: Readable.from(["hello"]) as B2S3DownloadedObject["body"],
    });
    const nodeResult = parseResult(
      await tools.call("s3_get_object", { bucket: "b", key: "node.txt" }),
    );

    nextDownload = downloadedObject({
      contentLength: 13,
      body: {
        transformToWebStream: () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("via-transform"));
              controller.close();
            },
          }),
      } as unknown as B2S3DownloadedObject["body"],
    });
    const transformResult = parseResult(
      await tools.call("s3_get_object", { bucket: "b", key: "transform.txt" }),
    );

    expect(nodeResult.content).toBe(Buffer.from("hello").toString("base64"));
    expect(transformResult.content).toBe(Buffer.from("via-transform").toString("base64"));
  });

  it("enforces the inline cap while reading an oversized node body", async () => {
    const body = Readable.from([Buffer.alloc(MAX_INLINE_OBJECT_BYTES + 1)]);
    const destroySpy = vi.spyOn(body, "destroy");
    nextDownload = downloadedObject({
      contentLength: 1,
      body: body as B2S3DownloadedObject["body"],
    });

    const result = await tools.call("s3_get_object", { bucket: "b", key: "lying.bin" });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/inline read limit|exceeded/i);
    expect(destroySpy).toHaveBeenCalled();
  });

  it("reports missing get-object bodies for inline and saveToPath reads", async () => {
    nextDownload = downloadedObject({ contentLength: 0, body: undefined });
    const inline = await tools.call("s3_get_object", { bucket: "b", key: "empty-body.txt" });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-missing-body-"));
    const target = path.join(dir, "out.txt");
    try {
      nextDownload = downloadedObject({ contentLength: 0, body: undefined });
      const saved = await tools.call("s3_get_object", {
        bucket: "b",
        key: "empty-body.txt",
        saveToPath: target,
      });

      expect(inline.isError).toBe(true);
      expect(saved.isError).toBe(true);
      expect(parseResult(inline)).toMatch(/readable body/i);
      expect(parseResult(saved)).toMatch(/readable body/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it("streams saveToPath downloads to disk and reports unknown length", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-ok-"));
    const target = path.join(dir, "nested", "out.txt");
    nextDownload = downloadedObject({
      contentLength: undefined,
      body: {
        transformToWebStream: () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("saved through stream"));
              controller.close();
            },
          }),
      } as unknown as B2S3DownloadedObject["body"],
    });

    try {
      const result = await tools.call("s3_get_object", {
        bucket: "b",
        key: "hello.txt",
        saveToPath: target,
      });

      expect(result.isError).toBeFalsy();
      expect(parseResult(result)).toContain("unknown bytes");
      expect(fs.readFileSync(target, "utf8")).toBe("saved through stream");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it("times out stalled saveToPath downloads and removes the partial file", async () => {
    const previousTimeout = process.env.B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS;
    process.env.B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS = "20";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-stall-"));
    const target = path.join(dir, "out.txt");
    let pushed = false;
    const body = new Readable({
      read() {
        if (pushed) return;
        pushed = true;
        this.push(Buffer.from("partial"));
      },
    });
    const destroySpy = vi.spyOn(body, "destroy");
    nextDownload = downloadedObject({
      contentLength: 100,
      body: body as B2S3DownloadedObject["body"],
    });

    try {
      const result = await tools.call("s3_get_object", {
        bucket: "b",
        key: "hello.txt",
        saveToPath: target,
      });

      expect(result.isError).toBe(true);
      expect(parseResult(result)).toMatch(/No object body progress/i);
      expect(destroySpy).toHaveBeenCalled();
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      if (previousTimeout === undefined) delete process.env.B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS;
      else process.env.B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS = previousTimeout;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not return partial inline content when web-stream cancellation resolves done", async () => {
    let resolveRead: (value: { done: boolean; value?: Uint8Array }) => void = () => undefined;
    const reader = {
      read: vi.fn(
        () =>
          new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
            resolveRead = resolve;
          }),
      ),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    };
    nextDownload = downloadedObject({
      contentLength: 5,
      body: { getReader: () => reader } as unknown as B2S3DownloadedObject["body"],
    });
    const controller = new AbortController();

    const pending = runWithMcpRequestSignal(controller.signal, () =>
      tools.call("s3_get_object", { bucket: "b", key: "hello.txt" }),
    );
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalled());
    controller.abort(new Error("client disconnected"));
    resolveRead({ done: true });
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatch(/client disconnected|aborted/i);
    expect(reader.cancel).toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalled();
  });

  it("preserves unversioned deletes when bulk version validation throws", async () => {
    nextBulkVersionLookupError = Object.assign(new Error("version lookup failed"), {
      status: 503,
      code: "version_lookup_failed",
      requestId: "rq-version-lookup",
    });

    const result = parseResult(
      await tools.call("s3_delete_objects", {
        bucket: "b",
        objects: [{ key: "latest.txt" }, { key: "old.txt", versionId: "v1" }],
        quiet: false,
        confirm: true,
      }),
    );

    expect(result).toMatchObject({
      deleted: [{ Key: "latest.txt" }],
      attempted: 2,
      errors: [
        {
          Key: "old.txt",
          VersionId: "v1",
          Code: "version_lookup_failed",
          Message: "version lookup failed",
          RequestId: "rq-version-lookup",
        },
      ],
    });
    expect(calls.find((call) => call.operation === "deleteObjects")?.input.objects).toEqual([
      { key: "latest.txt" },
    ]);
  });

  it("returns an empty deleteObjects result without calling S3", async () => {
    const result = parseResult(
      await tools.call("s3_delete_objects", {
        bucket: "b",
        objects: [],
        confirm: true,
      }),
    );

    expect(result).toMatchObject({
      deleted: [],
      errors: [],
      attempted: 0,
      aborted: false,
      maxConcurrency: 0,
    });
    expect(calls.some((call) => call.operation === "deleteObjects")).toBe(false);
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
    expect(bulkVersionLookups).toEqual([
      {
        bucket: "b",
        objects: [
          { key: "public/allowed.txt", versionId: "allowed-version" },
          { key: "public/blocked.txt", versionId: "secret-version" },
          { key: "public/latest.txt" },
        ],
      },
    ]);
    expect(calls.find((call) => call.operation === "deleteObjects")?.input.objects).toEqual([
      { key: "public/allowed.txt", versionId: "allowed-version" },
      { key: "public/latest.txt" },
    ]);
  });

  it("reports deleteMarker for current and explicit hide-marker versions", async () => {
    currentVersion = fileVersion({ action: "hide", fileId: "hide-current" });
    nextHeadObjectError = Object.assign(new Error("not found"), {
      name: "NotFound",
      $metadata: { httpHeaders: { "x-amz-delete-marker": "true" }, httpStatusCode: 404 },
    });
    const current = parseResult(
      await tools.call("s3_head_object", { bucket: "b", key: "hello.txt" }),
    );

    versions.set("hide-explicit", fileVersion({ action: "hide", fileId: "hide-explicit" }));
    nextHeadObjectError = null;
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
    expect(calls.filter((call) => call.operation === "headObject")).toHaveLength(1);
  });

  it("preserves the S3 head error when delete-marker fallback cannot synthesize one", async () => {
    nextHeadObjectError = Object.assign(s3Error("NoSuchKey", 404, "missing", "rq-head"), {
      DeleteMarker: true,
    });
    currentVersion = fileVersion({ action: "upload" });

    const uploadVersion = await tools.call("s3_head_object", { bucket: "b", key: "hello.txt" });

    nextCurrentVersionError = new Error("native version lookup failed");
    const fallbackFailure = await tools.call("s3_head_object", {
      bucket: "b",
      key: "hello.txt",
    });

    expect(uploadVersion.isError).toBe(true);
    expect(fallbackFailure.isError).toBe(true);
    expect(parseErrorText(parseResult(uploadVersion))).toMatchObject({
      code: "NoSuchKey",
      status: 404,
      requestId: "rq-head",
    });
    expect(parseErrorText(parseResult(fallbackFailure))).toMatchObject({
      code: "NoSuchKey",
      status: 404,
      requestId: "rq-head",
    });
  });

  it.each([
    {
      tool: "s3_put_object",
      operation: "putObject",
      args: {
        bucket: "b",
        key: "put.txt",
        content: Buffer.from("hello").toString("base64"),
        contentType: "text/plain",
      },
      error: s3Error("AccessDenied", 403, "denied", "rq-put"),
      expected: { code: "AccessDenied", status: 403, requestId: "rq-put" },
    },
    {
      tool: "s3_get_object",
      operation: "getObject",
      args: { bucket: "b", key: "missing.txt" },
      error: s3Error("NoSuchKey", 404, "missing", "rq-get"),
      expected: { code: "NoSuchKey", status: 404, requestId: "rq-get" },
    },
    {
      tool: "s3_delete_object",
      operation: "deleteObject",
      args: { bucket: "b", key: "locked.txt", confirm: true },
      error: s3Error("AccessDenied", 403, "delete denied", "rq-delete"),
      expected: { code: "AccessDenied", status: 403, requestId: "rq-delete" },
    },
    {
      tool: "s3_delete_objects",
      operation: "deleteObjects",
      args: { bucket: "b", objects: [{ key: "locked.txt" }], confirm: true },
      error: s3Error("AccessDenied", 403, "bulk delete denied", "rq-delete-many"),
      expected: { code: "AccessDenied", status: 403, requestId: "rq-delete-many" },
    },
    {
      tool: "s3_head_object",
      operation: "headObject",
      args: { bucket: "b", key: "missing.txt" },
      error: s3Error("NoSuchKey", 404, "missing", "rq-head-mapping"),
      expected: { code: "NoSuchKey", status: 404, requestId: "rq-head-mapping" },
    },
    {
      tool: "s3_copy_object",
      operation: "copyObject",
      args: {
        sourceBucket: "b",
        sourceKey: "source.txt",
        destinationBucket: "b",
        destinationKey: "dest.txt",
      },
      error: s3Error("PreconditionFailed", 412, "condition failed", "rq-copy"),
      expected: { code: "PreconditionFailed", status: 412, requestId: "rq-copy" },
    },
    {
      tool: "s3_list_objects_v2",
      operation: "listObjectsV2",
      args: { bucket: "b" },
      error: s3Error("AccessDenied", 403, "list denied", "rq-list"),
      expected: { code: "AccessDenied", status: 403, requestId: "rq-list" },
    },
    {
      tool: "s3_list_object_versions",
      operation: "listObjectVersions",
      args: { bucket: "b" },
      error: s3Error("AccessDenied", 403, "versions denied", "rq-versions"),
      expected: { code: "AccessDenied", status: 403, requestId: "rq-versions" },
    },
  ])(
    "maps $tool S3 errors into MCP error text",
    async ({ tool, operation, args, error, expected }) => {
      operationErrors.set(operation, error);

      const result = await tools.call(tool, args);

      expect(result.isError).toBe(true);
      expect(parseErrorText(parseResult(result))).toMatchObject(expected);
    },
  );
});
