import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerS3ObjectTools } from "../../src/s3/objects";
import type { B2S3FileVersionBinding, B2S3VersionGuard } from "../../src/utils/types";
import type {
  B2S3DeleteObjectsOptions,
  B2S3DownloadedObject,
  B2S3ListObjectsV2Options,
  B2S3ListObjectsV2Result,
  B2S3PutObjectOptions,
} from "../../src/s3/aws-sdk-adapter";
import { runWithMcpRequestSignal } from "../../src/request-context";
import {
  circuitBreaker,
  s3CircuitBreaker,
  s3TransferCircuitBreaker,
} from "../../src/utils/circuit-breaker";
import { parseErrorText } from "../../src/utils/errors";
import {
  DeterministicS3ClientFake,
  ToolHarness,
  parseResult,
  s3ServiceError,
  testConfig,
} from "../support/deterministic-fakes";

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

function expectBadRequestToolError(result: unknown, message: RegExp): void {
  const errorText = parseResult(result) as string;
  expect(errorText).toMatch(message);
  expect(parseErrorText(errorText)).toMatchObject({ code: "bad_request", status: 400 });
}

function notFound(message = "Object not found") {
  return Object.assign(new Error(message), { status: 404, code: "not_found" });
}

describe("S3 object tools with deterministic handler fake", () => {
  let tools: ToolHarness;
  let s3: DeterministicS3ClientFake;
  let versionGuard: B2S3VersionGuard;
  let currentVersion: B2S3FileVersionBinding | null = null;
  let nextCurrentVersionError: unknown = null;
  let nextBulkVersionLookupError: unknown = null;
  const versions = new Map<string, B2S3FileVersionBinding>();
  const bucketIds = new Map([["b", "bucket-id"]]);
  let bulkVersionLookups: Array<{
    bucket: string;
    objects: Array<{ key: string; versionId?: string }>;
  }> = [];

  beforeEach(() => {
    s3 = new DeterministicS3ClientFake();
    s3.allowDefault(
      "putObject",
      "deleteObject",
      "deleteObjects",
      "headObject",
      "copyObject",
      "listObjectsV2",
      "listObjectVersions",
    );
    currentVersion = null;
    nextCurrentVersionError = null;
    nextBulkVersionLookupError = null;
    versions.clear();
    bulkVersionLookups = [];
    versionGuard = {
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
    registerS3ObjectTools(tools, s3.asPeerClient(), versionGuard, testConfig);
  });

  afterEach(() => {
    circuitBreaker.close();
    s3CircuitBreaker.close();
    s3TransferCircuitBreaker.close();
  });

  function queueGetObject(overrides: Partial<B2S3DownloadedObject> = {}) {
    s3.respond("getObject", downloadedObject(overrides));
  }

  function firstRequest<TInput>(operation: string): TInput {
    const request = s3.requestsFor(operation)[0];
    if (!request) throw new Error(`No ${operation} request captured.`);
    return request.input as TInput;
  }

  function putBodyBuffer(input: B2S3PutObjectOptions): Buffer {
    if (typeof input.body === "string") return Buffer.from(input.body);
    if (input.body instanceof Uint8Array) return Buffer.from(Array.from(input.body));
    throw new Error("Expected inline object upload body to be bytes.");
  }

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
    const request = firstRequest<B2S3PutObjectOptions>("putObject");
    expect(request).toMatchObject({
      bucket: "b",
      key: "hello.txt",
      contentType: "text/plain",
      metadata: { owner: "fixture" },
      serverSideEncryption: "AES256",
    });
    expect(putBodyBuffer(request).toString()).toBe("hello");
  });

  it("requires an inline upload source before calling S3", async () => {
    const result = await tools.call("s3_put_object", {
      bucket: "b",
      key: "empty.txt",
      contentType: "text/plain",
    });

    expect(result.isError).toBe(true);
    expectBadRequestToolError(result, /Either filePath or content/);
    expect(s3.requests).toEqual([]);
  });

  it("refuses oversized inline uploads before calling S3", async () => {
    const result = await tools.call("s3_put_object", {
      bucket: "b",
      key: "large.bin",
      content: Buffer.alloc(MAX_INLINE_OBJECT_BYTES + 1).toString("base64"),
      contentType: "application/octet-stream",
    });

    expect(result.isError).toBe(true);
    expectBadRequestToolError(result, /inline limit|s3_get_presigned_url|multipart tools/i);
    expect(s3.requestsFor("putObject")).toHaveLength(0);
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
      const request = firstRequest<B2S3PutObjectOptions>("putObject");
      expect(request).toMatchObject({
        bucket: "b",
        key: "manifest.json",
        contentLength: 11,
        contentType: "application/json",
      });
      expect(putBodyBuffer(request).toString()).toBe('{"ok":true}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns small inline objects and forwards list pagination arguments", async () => {
    queueGetObject();
    const getResult = parseResult(
      await tools.call("s3_get_object", { bucket: "b", key: "hello.txt", range: "bytes=0-4" }),
    );
    const nextListObjects: B2S3ListObjectsV2Result = {
      objects: [{ Key: "a.txt", Size: 1, LastModified: new Date(), StorageClass: "STANDARD" }],
      commonPrefixes: [{ Prefix: "folder/" }],
      isTruncated: true,
      nextContinuationToken: "next",
      keyCount: 1,
    };
    s3.respond("listObjectsV2", nextListObjects);
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
    expect(firstRequest<B2S3ListObjectsV2Options>("listObjectsV2")).toMatchObject({
      bucket: "b",
      prefix: "a",
      delimiter: "/",
      maxKeys: 1,
      continuationToken: "token",
    });
  });

  it("reads inline objects from node and transformToWebStream bodies", async () => {
    queueGetObject({
      contentLength: 5,
      body: Readable.from(["hello"]) as B2S3DownloadedObject["body"],
    });
    const nodeResult = parseResult(
      await tools.call("s3_get_object", { bucket: "b", key: "node.txt" }),
    );

    queueGetObject({
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
    queueGetObject({
      contentLength: 1,
      body: body as B2S3DownloadedObject["body"],
    });

    const result = await tools.call("s3_get_object", { bucket: "b", key: "lying.bin" });

    expect(result.isError).toBe(true);
    expectBadRequestToolError(result, /inline read limit|exceeded/i);
    expect(destroySpy).toHaveBeenCalled();
  });

  it("reports missing get-object bodies for inline and saveToPath reads", async () => {
    queueGetObject({ contentLength: 0, body: undefined });
    const inline = await tools.call("s3_get_object", { bucket: "b", key: "empty-body.txt" });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-missing-body-"));
    const target = path.join(dir, "out.txt");
    try {
      queueGetObject({ contentLength: 0, body: undefined });
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
    queueGetObject({
      contentLength: -1,
      body: streamFrom([new Uint8Array([1])], () => invalidCanceled++),
    });
    const invalid = await tools.call("s3_get_object", { bucket: "b", key: "bad.txt" });
    expect(invalid.isError).toBe(true);
    expect(invalidCanceled).toBe(1);

    let largeCanceled = 0;
    queueGetObject({
      contentLength: 1024 * 1024 + 1,
      body: streamFrom([new Uint8Array([1])], () => largeCanceled++),
    });
    const large = await tools.call("s3_get_object", { bucket: "b", key: "large.bin" });
    expect(large.isError).toBe(true);
    expect(largeCanceled).toBe(1);
    expect(parseResult(large)).toMatch(/s3_get_presigned_url/);
    expect(parseResult(large)).toMatch(/saveToPath/);
  });

  it("streams saveToPath downloads to disk and reports the bytes written", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-ok-"));
    const target = path.join(dir, "nested", "out.txt");
    queueGetObject({
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
      const result = await saveTo(target);

      expect(result.isError).toBeFalsy();
      expect(parseResult(result)).toContain("(20 bytes)");
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
    queueGetObject({
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
    queueGetObject({
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
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      if (previousTimeout === undefined) delete process.env.B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS;
      else process.env.B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS = previousTimeout;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves a pre-existing file when a saveToPath download fails", async () => {
    const previousTimeout = process.env.B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS;
    process.env.B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS = "20";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-keep-"));
    const target = path.join(dir, "important.txt");
    fs.writeFileSync(target, "ORIGINAL-IMPORTANT-DATA\n");
    let pushed = false;
    const body = new Readable({
      read() {
        if (pushed) return;
        pushed = true;
        this.push(Buffer.from("partial"));
      },
    });
    queueGetObject({ contentLength: 100, body: body as B2S3DownloadedObject["body"] });

    try {
      const result = await saveTo(target);

      expect(result.isError).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("ORIGINAL-IMPORTANT-DATA\n");
      expect(fs.readdirSync(dir)).toEqual(["important.txt"]);
    } finally {
      if (previousTimeout === undefined) delete process.env.B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS;
      else process.env.B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS = previousTimeout;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function queueWebBody(text: string) {
    queueGetObject({
      contentLength: undefined,
      body: {
        transformToWebStream: () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(text));
              controller.close();
            },
          }),
      } as unknown as B2S3DownloadedObject["body"],
    });
  }

  function saveTo(
    saveToPath: string,
    {
      harness = tools,
      key = "hello.txt",
      versionId,
    }: { harness?: ToolHarness; key?: string; versionId?: string } = {},
  ) {
    return harness.call("s3_get_object", { bucket: "b", key, versionId, saveToPath });
  }

  function sandboxedTools(root: string, guard: B2S3VersionGuard = versionGuard): ToolHarness {
    const harness = new ToolHarness();
    registerS3ObjectTools(harness, s3.asPeerClient(), guard, { ...testConfig, fileRoot: root });
    return harness;
  }

  const posixIt = process.platform === "win32" ? it.skip : it;
  const linuxIt = process.platform === "linux" && fs.existsSync("/proc/self/fd") ? it : it.skip;
  const nonRootPosixIt = process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;

  // Permission bits only: setuid, setgid and sticky are not carried onto new content.
  for (const { mode, kept } of [
    { mode: 0o640, kept: 0o640 },
    { mode: 0o4755, kept: 0o755 },
  ]) {
    posixIt(
      `preserves only the permission bits of a replaced file (${mode.toString(8)})`,
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-mode-"));
        const target = path.join(dir, "secret.env");
        fs.writeFileSync(target, "OLD\n");
        fs.chmodSync(target, mode);
        queueWebBody("NEW");

        try {
          const result = await saveTo(target);

          expect(result.isError).toBeFalsy();
          expect(fs.readFileSync(target, "utf8")).toBe("NEW");
          expect(fs.statSync(target).mode & 0o7777).toBe(kept);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  }

  posixIt(
    "writes through a symlinked saveToPath target instead of replacing the link",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-link-"));
      const real = path.join(dir, "real.txt");
      const link = path.join(dir, "link.txt");
      fs.writeFileSync(real, "OLD\n");
      fs.symlinkSync(real, link);
      queueWebBody("NEW");

      try {
        const result = await saveTo(link);

        expect(result.isError).toBeFalsy();
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(real, "utf8")).toBe("NEW");
        expect(fs.readdirSync(dir).sort()).toEqual(["link.txt", "real.txt"]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("rejects a directory saveToPath target before fetching the object", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-dir-"));
    const target = path.join(dir, "existing-dir");
    fs.mkdirSync(target);

    try {
      const result = await saveTo(target);

      expect(result.isError).toBe(true);
      expectBadRequestToolError(result, /regular file.*directory/i);
      expect(s3.requestsFor("getObject")).toHaveLength(0);
      expect(fs.statSync(target).isDirectory()).toBe(true);
      expect(fs.readdirSync(dir)).toEqual(["existing-dir"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  posixIt("rejects a named pipe saveToPath target before fetching the object", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-pipe-"));
    const target = path.join(dir, "pipe");
    // cspell:disable-next-line
    execFileSync("mkfifo", [target]);

    try {
      const result = await saveTo(target);

      expect(result.isError).toBe(true);
      expectBadRequestToolError(result, /regular file.*not a regular file/i);
      expect(s3.requestsFor("getObject")).toHaveLength(0);
      expect(fs.statSync(target).isFIFO()).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  posixIt("creates the temp file exclusively instead of following a link at its name", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-excl-"));
    const target = path.join(dir, "out.txt");
    const victim = path.join(dir, "victim.txt");
    fs.writeFileSync(victim, "VICTIM\n");
    const realOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith(".part")) fs.symlinkSync(victim, String(args[0]));
      return realOpen(...(args as Parameters<typeof realOpen>));
    });
    queueWebBody("NEW");

    try {
      const result = await saveTo(target);

      expect(result.isError).toBe(true);
      expect(fs.readFileSync(victim, "utf8")).toBe("VICTIM\n");
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      openSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Capture every file handle the tool opens so tests can prove each was closed. */
  function trackOpenedHandles(): {
    handles: fs.promises.FileHandle[];
    paths: string[];
    restore: () => void;
  } {
    const handles: fs.promises.FileHandle[] = [];
    const paths: string[] = [];
    const realOpen = fs.promises.open.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof realOpen>));
      handles.push(handle);
      paths.push(String(args[0]));
      return handle;
    });
    return { handles, paths, restore: () => spy.mockRestore() };
  }

  it("bounds the temp name by UTF-8 bytes without splitting characters", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-utf8-"));
    // 1 + 60 * 4 + 4 = 245 bytes, close to NAME_MAX; the 64-byte cut lands mid-character.
    const name = `a${"\u{1F600}".repeat(60)}.txt`;
    const target = path.join(dir, name);
    const opened = trackOpenedHandles();
    queueWebBody("NEW");

    try {
      const result = await saveTo(target);

      expect(result.isError).toBeFalsy();
      const tempName = path.basename(opened.paths[0] ?? "");
      expect(tempName.startsWith(`a${"\u{1F600}".repeat(15)}.b2mcp-`)).toBe(true);
      expect(tempName).not.toContain("\uFFFD");
      expect(Buffer.byteLength(tempName)).toBe(61 + 24);
      expect(fs.readFileSync(target, "utf8")).toBe("NEW");
      expect(fs.readdirSync(dir)).toEqual([name]);
    } finally {
      opened.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves no temp file or open handle when the body is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-nobody-"));
    const target = path.join(dir, "a", "b", "out.txt");
    const opened = trackOpenedHandles();
    queueGetObject({ contentLength: 5, body: undefined });

    try {
      const result = await saveTo(target);

      expect(result.isError).toBe(true);
      expect(parseResult(result)).toMatch(/readable body/i);
      // The temp file plus, on Linux, the parent directory pinned for the rename.
      expect(opened.paths.some((opened) => opened.endsWith(".part"))).toBe(true);
      expect(opened.handles.map((handle) => handle.fd)).toEqual(opened.handles.map(() => -1));
      expect(fs.readdirSync(path.join(dir, "a", "b"))).toEqual([]);
    } finally {
      opened.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a parent directory it cannot create before fetching", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-parent-"));
    // made is created, then the 300-byte segment fails (ENAMETOOLONG; ENOENT on Windows).
    const target = path.join(dir, "made", "x".repeat(300), "out.txt");

    try {
      const result = await saveTo(target);

      expectBadRequestToolError(result, /saveToPath directory .* cannot be written/);
      expect(s3.requestsFor("getObject")).toHaveLength(0);
      expect(fs.readdirSync(dir)).toEqual(["made"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancels the body and closes the temp file when the transfer circuit is open", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-breaker-"));
    const target = path.join(dir, "out.txt");
    fs.writeFileSync(target, "KEEP\n");
    const body = new Readable({
      read() {
        // Never produces data: the transfer must be refused before it is read.
      },
    });
    queueGetObject({ contentLength: 5, body: body as B2S3DownloadedObject["body"] });
    const opened = trackOpenedHandles();
    s3TransferCircuitBreaker.open();

    try {
      const result = await saveTo(target);
      await new Promise((resolve) => setImmediate(resolve));

      expect(result.isError).toBe(true);
      expect(body.destroyed).toBe(true);
      expect(opened.paths.some((opened) => opened.endsWith(".part"))).toBe(true);
      expect(opened.handles.map((handle) => handle.fd)).toEqual(opened.handles.map(() => -1));
      expect(fs.readFileSync(target, "utf8")).toBe("KEEP\n");
      expect(fs.readdirSync(dir)).toEqual(["out.txt"]);
    } finally {
      s3TransferCircuitBreaker.close();
      opened.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a temp file write that makes no progress instead of retrying it", async () => {
    const previousTimeout = process.env.B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS;
    process.env.B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS = "200";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-stuck-"));
    const target = path.join(dir, "out.txt");
    fs.writeFileSync(target, "KEEP\n");
    let writes = 0;
    const realOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof realOpen>));
      if (String(args[0]).endsWith(".part")) {
        handle.write = (async (buffer: Buffer) => {
          writes += 1;
          await new Promise((resolve) => setImmediate(resolve));
          return { bytesWritten: 0, buffer };
        }) as typeof handle.write;
      }
      return handle;
    });
    queueWebBody("NEW");

    try {
      const result = await saveTo(target);

      expect(result.isError).toBe(true);
      expect(parseResult(result)).toMatch(/write made no progress/);
      expect(writes).toBe(1);
      expect(fs.readFileSync(target, "utf8")).toBe("KEEP\n");
      expect(fs.readdirSync(dir)).toEqual(["out.txt"]);
    } finally {
      if (previousTimeout === undefined) delete process.env.B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS;
      else process.env.B2_S3_SAVE_TO_PATH_IDLE_TIMEOUT_MS = previousTimeout;
      openSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the existing file when the body ends before its content length", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-short-"));
    const target = path.join(dir, "out.txt");
    fs.writeFileSync(target, "KEEP\n");
    queueGetObject({
      contentLength: 100,
      body: Readable.from([Buffer.from("trunc")]) as B2S3DownloadedObject["body"],
    });

    try {
      const result = await saveTo(target);

      expect(result.isError).toBe(true);
      const errorText = parseResult(result) as string;
      expect(errorText).toMatch(/5 of 100 bytes/);
      expect(parseErrorText(errorText)).toMatchObject({
        code: "incomplete_download",
        status: 502,
      });
      expect(fs.readFileSync(target, "utf8")).toBe("KEEP\n");
      expect(fs.readdirSync(dir)).toEqual(["out.txt"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Only root can make a file owned by someone else, so the vetted owner is faked by inode.
  posixIt("tries the replaced file's owner and group, then the group alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-chown-"));
    const target = path.join(dir, "owned.txt");
    fs.writeFileSync(target, "OLD\n");
    const { ino, uid, gid } = fs.statSync(target);
    const vetted = { uid: uid + 1, gid: gid + 1 };
    const fakeOwner = (method: "stat" | "lstat") => {
      const real = fs.promises[method].bind(fs.promises) as typeof fs.promises.stat;
      return vi.spyOn(fs.promises, method as "stat").mockImplementation(async (...args) => {
        const stat = await real(...(args as Parameters<typeof real>));
        if (stat.ino === ino) {
          Object.defineProperty(stat, "uid", { value: vetted.uid });
          Object.defineProperty(stat, "gid", { value: vetted.gid });
        }
        return stat;
      });
    };
    const statSpies = [fakeOwner("stat"), fakeOwner("lstat")];
    const chownCalls: Array<[number, number]> = [];
    const realOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof realOpen>));
      if (!String(args[0]).endsWith(".part")) return handle;
      handle.chown = async (owner: number, group: number) => {
        chownCalls.push([owner, group]);
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      };
      return handle;
    });
    queueWebBody("NEW");

    try {
      const result = await saveTo(target);

      expect(result.isError).toBeFalsy();
      expect(chownCalls).toEqual([
        [vetted.uid, vetted.gid],
        [-1, vetted.gid],
      ]);
      expect(fs.readFileSync(target, "utf8")).toBe("NEW");
    } finally {
      for (const spy of statSpies) spy.mockRestore();
      openSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // A user matched by the replaced file's group or other bits can land in a different
  // class on the replacement, so a carried bit that looks narrower can still widen
  // access. Ownership cannot fail under the test user, so the refusal is simulated.
  posixIt("carries only class-intersection bits when ownership or chmod is refused", async () => {
    const cases = [
      // Group read would pass to the process's own group.
      { mode: 0o640, keepUid: true, expected: 0o600 },
      // Group members were denied by their class; as "other" they would gain read.
      { mode: 0o604, keepUid: true, expected: 0o600 },
      // Everyone already had read, so carrying it widens nothing.
      { mode: 0o646, keepUid: true, expected: 0o644 },
      // The replaced owner is a third party once the uid changes too, so its bits join
      // the intersection: the write-only owner then holds the result down to `0222`.
      { mode: 0o266, keepUid: false, expected: 0o222 },
      // A refused fchmod keeps the owner-only mode the temp file was created with.
      { mode: 0o640, keepUid: true, expected: 0o600, refuseChmod: true },
      // With the group kept, only the old owner moves into group or other, so both are capped at its bits.
      { mode: 0o660, keepGid: true, expected: 0o660 },
      { mode: 0o674, keepGid: true, expected: 0o664 },
      { mode: 0o607, keepGid: true, expected: 0o606 },
    ];

    for (const { mode, keepUid = false, keepGid = false, expected, refuseChmod } of cases) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-clamp-"));
      const target = path.join(dir, "owned.txt");
      fs.writeFileSync(target, "OLD\n");
      fs.chmodSync(target, mode);
      const realOpen = fs.promises.open.bind(fs.promises);
      const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...(args as Parameters<typeof realOpen>));
        if (!String(args[0]).endsWith(".part")) return handle;
        const refused = async () => {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        };
        handle.chown = refused;
        if (refuseChmod) handle.chmod = refused;
        const realStat = handle.stat.bind(handle);
        handle.stat = (async () => {
          const stat = await realStat();
          if (!keepGid) Object.defineProperty(stat, "gid", { value: stat.gid + 1 });
          if (!keepUid) Object.defineProperty(stat, "uid", { value: stat.uid + 1 });
          return stat;
        }) as typeof handle.stat;
        return handle;
      });
      queueWebBody("NEW");

      try {
        const result = await saveTo(target);

        expect(result.isError).toBeFalsy();
        expect(fs.statSync(target).mode & 0o777).toBe(expected);
        if (expected & 0o400) expect(fs.readFileSync(target, "utf8")).toBe("NEW");
      } finally {
        openSpy.mockRestore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  posixIt("replaces a dangling symlink inside the file root instead of following it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-outside-"));
    const escapeTarget = path.join(outside, "escaped.txt");
    const link = path.join(root, "link.txt");
    fs.symlinkSync(escapeTarget, link);
    const sandboxed = sandboxedTools(root);
    queueWebBody("NEW");

    try {
      const result = await saveTo(link, { harness: sandboxed });

      expect(result.isError).toBeFalsy();
      expect(fs.existsSync(escapeTarget)).toBe(false);
      expect(fs.lstatSync(link).isFile()).toBe(true);
      expect(fs.readFileSync(link, "utf8")).toBe("NEW");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  posixIt("checks the opened temp file with fs-guard's resolver, not the native one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-resolver-"));
    const target = path.join(root, "out.txt");
    const sandboxed = sandboxedTools(root);
    // The native resolver can spell a path differently from the JS one fs-guard uses
    // for the root (letter case on macOS, mapped drives on Windows). fs.realpathSync
    // itself cannot be spied on (ESM namespace), so these spies are tripwires.
    const nativeRealpath = vi
      .spyOn(fs.promises, "realpath")
      .mockImplementation(async (p) => String(p).toUpperCase());
    const nativeSync = vi.spyOn(fs.realpathSync, "native");
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    queueWebBody("NEW");

    try {
      const result = await saveTo(target, { harness: sandboxed });

      expect(result.isError).toBeFalsy();
      expect(nativeRealpath).not.toHaveBeenCalled();
      expect(nativeSync).not.toHaveBeenCalled();
      expect(fs.readFileSync(target, "utf8")).toBe("NEW");
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform });
      nativeRealpath.mockRestore();
      nativeSync.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  posixIt("reports a file root that vanishes mid-request as bad_request", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-vanish-"));
    const root = path.join(parent, "root");
    fs.mkdirSync(root);
    const sandboxed = sandboxedTools(root);
    // The root is renamed away right after the temp file opens, before its location is checked.
    const realOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof realOpen>));
      fs.renameSync(root, `${root}-gone`);
      return handle;
    });

    try {
      const result = await saveTo(path.join(root, "out.txt"), { harness: sandboxed });

      expect(result.isError).toBe(true);
      expectBadRequestToolError(
        result,
        /sandbox root does not exist|outside the allowed directory/i,
      );
      expect(s3.requestsFor("getObject")).toHaveLength(0);
    } finally {
      openSpy.mockRestore();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("reports a failed final rename as bad_request and keeps the destination", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-rename-"));
    const target = path.join(dir, "out.txt");
    fs.writeFileSync(target, "OLD\n");
    const renameSpy = vi
      .spyOn(fs.promises, "rename")
      .mockRejectedValueOnce(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
    queueWebBody("NEW");

    try {
      const result = await saveTo(target);

      expect(result.isError).toBe(true);
      expectBadRequestToolError(result, /target .* cannot be written \(EBUSY\)/);
      expect(fs.readFileSync(target, "utf8")).toBe("OLD\n");
      expect(fs.readdirSync(dir)).toEqual(["out.txt"]);
    } finally {
      renameSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  posixIt("rechecks the file root after creating directories through a symlink", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-race-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-race-out-"));
    const escapeDir = path.join(outside, "escaped");
    // Dangling while the path is vetted, then pointed at a real directory
    // outside the root before the save creates its parents.
    fs.symlinkSync(escapeDir, path.join(root, "link"));
    const target = path.join(root, "link", "sub", "out.txt");
    const racingGuard: B2S3VersionGuard = {
      ...versionGuard,
      async resolveS3FileVersion() {
        fs.mkdirSync(escapeDir);
        return fileVersion();
      },
    };
    const sandboxed = sandboxedTools(root, racingGuard);
    const opened = trackOpenedHandles();

    try {
      const result = await saveTo(target, { harness: sandboxed, versionId: "version-hello" });

      expect(result.isError).toBe(true);
      expectBadRequestToolError(result, /outside the allowed directory/i);
      expect(s3.requestsFor("getObject")).toHaveLength(0);
      // Refused by the post-mkdir check, before any temp file is created.
      expect(opened.handles).toHaveLength(0);
      expect(fs.readdirSync(escapeDir)).toEqual(["sub"]);
      expect(fs.readdirSync(path.join(escapeDir, "sub"))).toEqual([]);
    } finally {
      opened.restore();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // The parent directory is pinned once the temp file in it is confirmed, so the
  // operations that follow resolve from that inode instead of the path. Linux only:
  // the pin is reached through /proc/self/fd.
  linuxIt("renames into the pinned directory after an ancestor is swapped away", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-pin-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-pin-out-"));
    const dir = path.join(root, "sub");
    fs.mkdirSync(dir);
    const victim = path.join(outside, "out.txt");
    fs.writeFileSync(victim, "VICTIM\n");
    const target = path.join(dir, "out.txt");
    const sandboxed = sandboxedTools(root);
    // Swapped while the body is in flight, after the temp file is open and pinned.
    s3.respond("getObject", () => {
      fs.renameSync(dir, `${dir}.stash`);
      fs.symlinkSync(outside, dir);
      return downloadedObject({
        contentLength: 3,
        body: streamFrom([new TextEncoder().encode("NEW")]),
      });
    });

    try {
      const result = await saveTo(target, { harness: sandboxed });

      expect(result.isError).toBeFalsy();
      expect(fs.readFileSync(victim, "utf8")).toBe("VICTIM\n");
      expect(fs.readdirSync(outside)).toEqual(["out.txt"]);
      expect(fs.readFileSync(path.join(`${dir}.stash`, "out.txt"), "utf8")).toBe("NEW");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // Swapped between opening the temp file and pinning its directory. With nothing in its
  // place the stat through the pin fails; a decoy of the temp name leaves the inode check.
  for (const decoy of [false, true]) {
    linuxIt(
      `refuses a parent directory that no longer holds the temp file (${decoy ? "a decoy" : "nothing"} in its place)`,
      async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-pin-swap-"));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-pin-swap-out-"));
        const bystander = path.join(outside, "lock");
        fs.mkdirSync(bystander);
        const dir = path.join(base, "shared", "lock");
        fs.mkdirSync(path.join(base, "shared"));
        const target = path.join(dir, "out.txt");
        const realOpen = fs.promises.open.bind(fs.promises);
        const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
          const handle = await realOpen(...(args as Parameters<typeof realOpen>));
          if (String(args[0]).endsWith(".part")) {
            fs.renameSync(dir, `${dir}.stash`);
            fs.symlinkSync(bystander, dir);
            if (decoy) fs.writeFileSync(path.join(bystander, path.basename(String(args[0]))), "");
          }
          return handle;
        });
        queueWebBody("NEW");

        try {
          const result = await saveTo(target);

          expect(result.isError).toBe(true);
          expectBadRequestToolError(result, /changed while the download was being prepared/i);
          expect(s3.requestsFor("getObject")).toHaveLength(0);
          expect(fs.existsSync(bystander)).toBe(true);
          expect(fs.readdirSync(outside)).toEqual(["lock"]);
        } finally {
          openSpy.mockRestore();
          fs.rmSync(base, { recursive: true, force: true });
          fs.rmSync(outside, { recursive: true, force: true });
        }
      },
    );
  }

  // A hard link to the temp file placed outside the root makes the pin's inode check
  // pass on a directory that is not inside it, so the pin is checked against the root
  // as well; otherwise the rename would put the fetched bytes outside.
  linuxIt("refuses a pinned directory outside the file root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-pin-link-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-pin-link-out-"));
    const dir = path.join(root, "sub");
    fs.mkdirSync(dir);
    const target = path.join(dir, "out.txt");
    fs.writeFileSync(target, "OLD\n");
    fs.chmodSync(target, 0o666);
    const sandboxed = sandboxedTools(root);
    const handles: fs.promises.FileHandle[] = [];
    const realOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof realOpen>));
      handles.push(handle);
      const opened = String(args[0]);
      if (opened.endsWith(".part")) {
        fs.linkSync(opened, path.join(outside, path.basename(opened)));
        fs.renameSync(dir, `${dir}.stash`);
        fs.symlinkSync(outside, dir);
      }
      return handle;
    });
    queueWebBody("NEW");

    try {
      const result = await saveTo(target, { harness: sandboxed });

      expect(result.isError).toBe(true);
      expectBadRequestToolError(result, /outside the allowed directory/i);
      expect(s3.requestsFor("getObject")).toHaveLength(0);
      expect(fs.existsSync(path.join(outside, "out.txt"))).toBe(false);
      // The temp file and the refused directory pin are both closed.
      expect(handles.map((handle) => handle.fd)).toEqual([-1, -1]);
    } finally {
      openSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // A descriptor keeps following its directory after a move, so a pin taken inside the
  // root can end up outside it while the body is in flight.
  linuxIt("refuses to commit into a pinned directory moved out of the root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-pin-move-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-pin-move-out-"));
    const dir = path.join(root, "sub");
    fs.mkdirSync(dir);
    const target = path.join(dir, "out.txt");
    const sandboxed = sandboxedTools(root);
    s3.respond("getObject", () => {
      fs.renameSync(dir, path.join(outside, "sub"));
      return downloadedObject({
        contentLength: 3,
        body: streamFrom([new TextEncoder().encode("NEW")]),
      });
    });

    try {
      const result = await saveTo(target, { harness: sandboxed });

      expect(result.isError).toBe(true);
      expectBadRequestToolError(result, /outside the allowed directory/i);
      expect(fs.readdirSync(path.join(outside, "sub"))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  for (const platform of ["linux", "darwin"] as const) {
    (platform === "linux" ? linuxIt : posixIt)(
      `refuses and keeps a temp entry replaced mid-download (${platform})`,
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-entry-"));
        const target = path.join(dir, "out.txt");
        fs.writeFileSync(target, "KEEP\n");
        const realPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: platform });
        const opened = trackOpenedHandles();
        let replaced = "";
        s3.respond("getObject", () => {
          replaced = opened.paths.find((name) => name.endsWith(".part")) ?? "";
          fs.rmSync(replaced);
          fs.writeFileSync(replaced, "ACTOR\n");
          return downloadedObject({
            contentLength: 3,
            body: streamFrom([new TextEncoder().encode("NEW")]),
          });
        });

        try {
          const result = await saveTo(target);

          expect(result.isError).toBe(true);
          expectBadRequestToolError(
            result,
            /temp file was replaced while the download was in flight/i,
          );
          expect(fs.readFileSync(target, "utf8")).toBe("KEEP\n");
          expect(fs.readFileSync(replaced, "utf8")).toBe("ACTOR\n");
        } finally {
          Object.defineProperty(process, "platform", { value: realPlatform });
          opened.restore();
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  }

  const heldCases = [
    { name: "renamed", op: "rename", body: () => streamFrom([new TextEncoder().encode("NEW")]) },
    // Ends cleanly but short of its length, so the save fails after the write.
    {
      name: "removed after a short body",
      op: "unlink",
      contentLength: 10,
      body: () => streamFrom([new TextEncoder().encode("NEW")]),
    },
    // The body errors, so the transfer tears its streams down before cleanup.
    {
      name: "removed after a body error",
      op: "unlink",
      body: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("NE"));
            controller.error(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
          },
        }) as unknown as B2S3DownloadedObject["body"],
    },
  ] as const;
  for (const held of heldCases) {
    it(`keeps the temp file open until it is ${held.name}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-held-"));
      const target = path.join(dir, "out.txt");
      fs.writeFileSync(target, "OLD\n");
      const opened = trackOpenedHandles();
      let heldAtOp: boolean | undefined;
      const real = fs.promises[held.op].bind(fs.promises) as (...args: string[]) => Promise<void>;
      const opSpy = vi
        .spyOn(fs.promises, held.op as "rename")
        .mockImplementation(async (...args) => {
          const temp = opened.handles[opened.paths.findIndex((name) => name.endsWith(".part"))];
          heldAtOp = temp !== undefined && temp.fd !== -1;
          return real(...(args as string[]));
        });
      s3.respond("getObject", () =>
        downloadedObject({
          contentLength: "contentLength" in held ? held.contentLength : 3,
          body: held.body(),
        }),
      );

      try {
        const result = await saveTo(target);

        expect(Boolean(result.isError)).toBe(held.op === "unlink");
        expect(heldAtOp).toBe(true);
        expect(opened.handles.every((handle) => handle.fd === -1)).toBe(true);
        expect(fs.readdirSync(dir)).toEqual(["out.txt"]);
      } finally {
        opSpy.mockRestore();
        opened.restore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  const destinationChanges = [
    {
      name: "had its permissions tightened",
      change: (target: string) => fs.chmodSync(target, 0o600),
      left: "KEEP\n",
    },
    {
      name: "was replaced by another file",
      change: (target: string) => {
        fs.writeFileSync(`${target}.new`, "OTHER\n");
        fs.chmodSync(`${target}.new`, 0o666);
        fs.renameSync(`${target}.new`, target);
      },
      left: "OTHER\n",
    },
    {
      name: "was swapped for a symlink to itself",
      change: (target: string) => {
        fs.renameSync(target, `${target}.orig`);
        fs.symlinkSync(`${target}.orig`, target);
      },
      left: "KEEP\n",
    },
    {
      name: "was created while absent",
      absent: true,
      change: (target: string) => fs.writeFileSync(target, "OTHER\n"),
      left: "OTHER\n",
    },
    {
      name: "was removed",
      change: (target: string) => fs.rmSync(target),
      left: null,
    },
  ];
  for (const { name, absent, change, left } of destinationChanges) {
    posixIt(`refuses to replace a destination that ${name} mid-download`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-dest-"));
      const target = path.join(dir, "out.txt");
      if (!absent) {
        fs.writeFileSync(target, "KEEP\n");
        fs.chmodSync(target, 0o666);
      }
      s3.respond("getObject", () => {
        change(target);
        return downloadedObject({
          contentLength: 3,
          body: streamFrom([new TextEncoder().encode("NEW")]),
        });
      });

      try {
        const result = await saveTo(target);

        expect(result.isError).toBe(true);
        expectBadRequestToolError(result, /target .* changed while the download was in flight/i);
        expect(fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null).toBe(left);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  // Only root can chown to another user, so the changed owner is faked by inode.
  for (const field of ["uid", "gid"] as const) {
    posixIt(`refuses to replace a destination whose ${field} changed mid-download`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-dest-owner-"));
      const target = path.join(dir, "out.txt");
      fs.writeFileSync(target, "KEEP\n");
      const vetted = fs.statSync(target);
      let lstatSpy: { mockRestore: () => void } | undefined;
      s3.respond("getObject", () => {
        const real = fs.promises.lstat.bind(fs.promises) as typeof fs.promises.lstat;
        lstatSpy = vi.spyOn(fs.promises, "lstat").mockImplementation(async (...args) => {
          const stat = await real(...(args as Parameters<typeof real>));
          if (stat.ino === vetted.ino) {
            Object.defineProperty(stat, field, { value: vetted[field] + 1 });
          }
          return stat;
        });
        return downloadedObject({
          contentLength: 3,
          body: streamFrom([new TextEncoder().encode("NEW")]),
        });
      });

      try {
        const result = await saveTo(target);

        expect(result.isError).toBe(true);
        expectBadRequestToolError(result, /target .* changed while the download was in flight/i);
        expect(fs.readFileSync(target, "utf8")).toBe("KEEP\n");
      } finally {
        lstatSpy?.mockRestore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  linuxIt("refuses a sandboxed save when /proc cannot be read", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-proc-root-"));
    const target = path.join(root, "out.txt");
    fs.writeFileSync(target, "KEEP\n");
    const sandboxed = sandboxedTools(root);
    const realReadlink = fs.promises.readlink.bind(fs.promises);
    const readlinkSpy = vi.spyOn(fs.promises, "readlink").mockImplementation(async (queried) => {
      if (String(queried).startsWith("/proc/self/fd/")) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return realReadlink(queried as Parameters<typeof realReadlink>[0]);
    });
    queueWebBody("NEW");

    try {
      const result = await saveTo(target, { harness: sandboxed });

      // No pin is possible here, so the sandboxed request fails instead of quietly
      // running the path-based operations it is meant to have replaced.
      expect(result.isError).toBe(true);
      expectBadRequestToolError(result, /\/proc is unavailable/i);
      expect(fs.readFileSync(target, "utf8")).toBe("KEEP\n");
      expect(fs.readdirSync(root)).toEqual(["out.txt"]);
    } finally {
      readlinkSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  linuxIt("refuses a sandboxed save whose parent cannot be pinned", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-pin-none-")));
    const dir = path.join(root, "a", "b");
    const sandboxed = sandboxedTools(root);
    const realOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (String(args[0]) === dir) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return realOpen(...(args as Parameters<typeof realOpen>));
    });
    queueWebBody("NEW");

    try {
      const result = await saveTo(path.join(dir, "out.txt"), { harness: sandboxed });

      expect(result.isError).toBe(true);
      expectBadRequestToolError(
        result,
        /cannot open the directory .* \(EACCES\), which is required/i,
      );
      expect(s3.requestsFor("getObject")).toHaveLength(0);
      // Left in place: directories this request created are never removed.
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      openSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  for (const platform of ["linux", "darwin"] as const) {
    posixIt(
      `rejects a temp file opened outside the file root by a symlink swap (${platform} check)`,
      async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-swap-root-"));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-swap-out-"));
        const inner = path.join(root, "inner");
        const link = path.join(root, "link");
        // Dangling while the path is vetted, so the link stays in the lexical
        // path; it becomes a valid in-root directory before the parent is made.
        fs.symlinkSync(inner, link);
        const racingGuard: B2S3VersionGuard = {
          ...versionGuard,
          async resolveS3FileVersion() {
            fs.mkdirSync(inner);
            return fileVersion();
          },
        };
        const sandboxed = sandboxedTools(root, racingGuard);
        // Every path check passes; the ancestor is swapped at the last moment, so
        // the exclusive create itself lands outside the root.
        const realOpen = fs.promises.open.bind(fs.promises);
        const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
          fs.rmSync(link);
          fs.symlinkSync(outside, link);
          return realOpen(...(args as Parameters<typeof realOpen>));
        });
        const realPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: platform });

        try {
          const result = await saveTo(path.join(root, "link", "out.txt"), {
            harness: sandboxed,
            versionId: "version-hello",
          });

          expect(result.isError).toBe(true);
          expectBadRequestToolError(result, /outside the allowed directory/i);
          expect(s3.requestsFor("getObject")).toHaveLength(0);
          expect(fs.readdirSync(outside)).toEqual([]);
          expect(fs.readdirSync(inner)).toEqual([]);
        } finally {
          Object.defineProperty(process, "platform", { value: realPlatform });
          openSpy.mockRestore();
          fs.rmSync(root, { recursive: true, force: true });
          fs.rmSync(outside, { recursive: true, force: true });
        }
      },
    );
  }

  for (const decoy of ["copy", "hard link"] as const) {
    posixIt(`rejects a temp file whose path is swapped back to a ${decoy} after open`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-swapback-root-"));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-swapback-out-"));
      const inner = path.join(root, "inner");
      const link = path.join(root, "link");
      fs.symlinkSync(inner, link);
      const racingGuard: B2S3VersionGuard = {
        ...versionGuard,
        async resolveS3FileVersion() {
          fs.mkdirSync(inner);
          return fileVersion();
        },
      };
      const sandboxed = sandboxedTools(root, racingGuard);
      // The create lands outside, then the link is restored and the in-root temp name is
      // filled, so the real path looks fine and only the device/inode and link count remain.
      const realOpen = fs.promises.open.bind(fs.promises);
      const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
        fs.rmSync(link);
        fs.symlinkSync(outside, link);
        const handle = await realOpen(...(args as Parameters<typeof realOpen>));
        fs.rmSync(link);
        fs.symlinkSync(inner, link);
        const name = path.basename(String(args[0]));
        if (decoy === "copy") fs.writeFileSync(path.join(inner, name), "decoy");
        else fs.linkSync(path.join(outside, name), path.join(inner, name));
        return handle;
      });
      const realPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });

      try {
        const result = await saveTo(path.join(root, "link", "out.txt"), {
          harness: sandboxed,
          versionId: "version-hello",
        });

        expect(result.isError).toBe(true);
        expectBadRequestToolError(result, /outside the allowed directory/i);
        expect(s3.requestsFor("getObject")).toHaveLength(0);
      } finally {
        Object.defineProperty(process, "platform", { value: realPlatform });
        openSpy.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  }

  nonRootPosixIt("rejects a non-writable directory before fetching the object", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-ro-dir-"));
    const target = path.join(dir, "writable.txt");
    fs.writeFileSync(target, "KEEP\n");
    fs.chmodSync(dir, 0o555);

    try {
      const result = await saveTo(target);

      expect(result.isError).toBe(true);
      expectBadRequestToolError(result, /directory .* cannot be written \(EACCES\)/);
      expect(s3.requestsFor("getObject")).toHaveLength(0);
      expect(fs.readFileSync(target, "utf8")).toBe("KEEP\n");
    } finally {
      fs.chmodSync(dir, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  nonRootPosixIt("refuses to replace a read-only saveToPath target", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-ro-"));
    const target = path.join(dir, "locked.txt");
    fs.writeFileSync(target, "KEEP\n");
    fs.chmodSync(target, 0o444);

    try {
      const result = await saveTo(target);

      expect(result.isError).toBe(true);
      expectBadRequestToolError(result, /not writable/i);
      expect(s3.requestsFor("getObject")).toHaveLength(0);
      expect(fs.readFileSync(target, "utf8")).toBe("KEEP\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  nonRootPosixIt("saves into a writable directory it cannot list without a file root", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-save-dropbox-"));
    const target = path.join(dir, "out.txt");
    fs.chmodSync(dir, 0o333);
    queueWebBody("NEW");

    try {
      const result = await saveTo(target);

      expect(result.isError).toBeFalsy();
      expect(fs.readFileSync(target, "utf8")).toBe("NEW");
    } finally {
      fs.chmodSync(dir, 0o755);
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
    queueGetObject({
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
    expect(firstRequest<B2S3DeleteObjectsOptions>("deleteObjects").objects).toEqual([
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
    expect(s3.requestsFor("deleteObjects")).toHaveLength(0);
  });

  it("enforces destructive confirmation on object delete calls", async () => {
    const blocked = await tools.call("s3_delete_objects", {
      bucket: "b",
      objects: [{ key: "a.txt" }],
    });
    expect(blocked.isError).toBe(true);
    expect(s3.requestsFor("deleteObjects")).toHaveLength(0);

    const blockedBypass = parseResult(
      await tools.call("s3_delete_objects", {
        bucket: "b",
        objects: [{ key: "a.txt", versionId: "v1" }],
        bypassGovernance: true,
      }),
    );
    expect(blockedBypass).toContain("bypass governance-mode Object Lock retention");
    expect(s3.requestsFor("deleteObjects")).toHaveLength(0);

    const allowed = parseResult(
      await tools.call("s3_delete_objects", {
        bucket: "b",
        objects: [{ key: "a.txt" }],
        quiet: false,
        confirm: true,
      }),
    );
    expect(allowed).toMatchObject({ attempted: 1, aborted: false, maxConcurrency: 1 });
    expect(firstRequest<B2S3DeleteObjectsOptions>("deleteObjects")).toMatchObject({
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
    expect(s3.requestsFor("getObject")).toHaveLength(0);
    expect(s3.requestsFor("headObject")).toHaveLength(0);
    expect(s3.requestsFor("deleteObject")).toHaveLength(0);
    expect(s3.requestsFor("deleteObjects")).toHaveLength(0);
    expect(s3.requestsFor("copyObject")).toHaveLength(0);
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
    expect(firstRequest<B2S3DeleteObjectsOptions>("deleteObjects").objects).toEqual([
      { key: "public/allowed.txt", versionId: "allowed-version" },
      { key: "public/latest.txt" },
    ]);
  });

  it("reports deleteMarker for current and explicit hide-marker versions", async () => {
    currentVersion = fileVersion({ action: "hide", fileId: "hide-current" });
    s3.fail(
      "headObject",
      Object.assign(s3ServiceError("NotFound", "not found", 404), {
        $metadata: { httpHeaders: { "x-amz-delete-marker": "true" }, httpStatusCode: 404 },
      }),
    );
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
    expect(s3.requestsFor("headObject")).toHaveLength(1);
  });

  it("preserves the S3 head error when delete-marker fallback cannot synthesize one", async () => {
    const headError = Object.assign(s3ServiceError("NoSuchKey", "missing", 404, "rq-head"), {
      DeleteMarker: true,
    });
    s3.fail("headObject", headError);
    currentVersion = fileVersion({ action: "upload" });

    const uploadVersion = await tools.call("s3_head_object", { bucket: "b", key: "hello.txt" });

    s3.fail("headObject", headError);
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
      error: s3ServiceError("AccessDenied", "denied", 403, "rq-put"),
      expected: { code: "AccessDenied", status: 403, requestId: "rq-put" },
    },
    {
      tool: "s3_get_object",
      operation: "getObject",
      args: { bucket: "b", key: "missing.txt" },
      error: s3ServiceError("NoSuchKey", "missing", 404, "rq-get"),
      expected: { code: "NoSuchKey", status: 404, requestId: "rq-get" },
    },
    {
      tool: "s3_delete_object",
      operation: "deleteObject",
      args: { bucket: "b", key: "locked.txt", confirm: true },
      error: s3ServiceError("AccessDenied", "delete denied", 403, "rq-delete"),
      expected: { code: "AccessDenied", status: 403, requestId: "rq-delete" },
    },
    {
      tool: "s3_delete_objects",
      operation: "deleteObjects",
      args: { bucket: "b", objects: [{ key: "locked.txt" }], confirm: true },
      error: s3ServiceError("AccessDenied", "bulk delete denied", 403, "rq-delete-many"),
      expected: { code: "AccessDenied", status: 403, requestId: "rq-delete-many" },
    },
    {
      tool: "s3_head_object",
      operation: "headObject",
      args: { bucket: "b", key: "missing.txt" },
      error: s3ServiceError("NoSuchKey", "missing", 404, "rq-head-mapping"),
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
      error: s3ServiceError("PreconditionFailed", "condition failed", 412, "rq-copy"),
      expected: { code: "PreconditionFailed", status: 412, requestId: "rq-copy" },
    },
    {
      tool: "s3_list_objects_v2",
      operation: "listObjectsV2",
      args: { bucket: "b" },
      error: s3ServiceError("AccessDenied", "list denied", 403, "rq-list"),
      expected: { code: "AccessDenied", status: 403, requestId: "rq-list" },
    },
    {
      tool: "s3_list_object_versions",
      operation: "listObjectVersions",
      args: { bucket: "b" },
      error: s3ServiceError("AccessDenied", "versions denied", 403, "rq-versions"),
      expected: { code: "AccessDenied", status: 403, requestId: "rq-versions" },
    },
  ])(
    "maps $tool S3 errors into MCP error text",
    async ({ tool, operation, args, error, expected }) => {
      s3.fail(operation, error);

      const result = await tools.call(tool, args);

      expect(result.isError).toBe(true);
      expect(parseErrorText(parseResult(result))).toMatchObject(expected);
    },
  );
});
