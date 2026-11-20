import { Readable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerS3ObjectTools } from "../../src/s3/objects";
import type { B2S3DownloadedObject, B2S3PutObjectOptions } from "../../src/s3/aws-sdk-adapter";
import type { B2S3VersionGuard } from "../../src/utils/types";
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
  testConfig,
} from "../support/deterministic-fakes";

const CAP = 1024 * 1024;

// Version binding is never consulted without a versionId; fail loudly if that changes.
const unusedVersionGuard: B2S3VersionGuard = {
  async resolveS3FileVersion() {
    throw new Error("unexpected version lookup");
  },
  async resolveS3FileVersions() {
    throw new Error("unexpected version lookup");
  },
  async getCurrentS3FileVersion() {
    throw new Error("unexpected version lookup");
  },
};

let s3: DeterministicS3ClientFake;
let tools: ToolHarness;
let dir: string;

beforeEach(() => {
  s3 = new DeterministicS3ClientFake();
  s3.allowDefault("putObject");
  tools = new ToolHarness();
  registerS3ObjectTools(tools, s3.asPeerClient(), unusedVersionGuard, testConfig);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-inline-cap-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  circuitBreaker.close();
  s3CircuitBreaker.close();
  s3TransferCircuitBreaker.close();
});

function expectInlineUploadRefusal(result: unknown, size: number): void {
  const text = parseResult(result) as string;
  expect(text).toContain(`is ${size} bytes, over the ${CAP}-byte inline limit for s3_put_object`);
  expect(text).toContain("s3_get_presigned_url");
  expect(parseErrorText(text)).toMatchObject({ code: "bad_request", status: 400 });
  expect(s3.requestsFor("putObject")).toHaveLength(0);
}

function sentBody(): Uint8Array {
  const body = (s3.requestsFor("putObject")[0].input as B2S3PutObjectOptions).body;
  if (!(body instanceof Uint8Array)) throw new Error("Expected a byte body.");
  return body;
}

function queueDownload(overrides: Partial<B2S3DownloadedObject>): void {
  s3.respond<unknown, B2S3DownloadedObject>("getObject", {
    key: "obj.bin",
    contentType: "application/octet-stream",
    lastModified: new Date("2026-01-01T00:00:00.000Z"),
    etag: '"etag"',
    metadata: {},
    ...overrides,
  });
}

describe("s3_put_object inline cap boundary", () => {
  it("accepts exactly 1,048,576 bytes of base64 content", async () => {
    const result = await tools.call("s3_put_object", {
      bucket: "b",
      key: "exact.bin",
      content: Buffer.alloc(CAP, 7).toString("base64"),
      contentType: "application/octet-stream",
    });

    expect(result.isError).toBeFalsy();
    expect(s3.requestsFor("putObject")).toHaveLength(1);
    expect(s3.requestsFor("putObject")[0].input).toMatchObject({ contentLength: CAP });
    expect(sentBody().byteLength).toBe(CAP);
  });

  it("rejects 1,048,577 bytes of base64 content with the documented message", async () => {
    const result = await tools.call("s3_put_object", {
      bucket: "b",
      key: "over.bin",
      content: Buffer.alloc(CAP + 1, 7).toString("base64"),
      contentType: "application/octet-stream",
    });

    expect(result.isError).toBe(true);
    expectInlineUploadRefusal(result, CAP + 1);
  });

  it("accepts a filePath of exactly 1,048,576 bytes", async () => {
    const filePath = path.join(dir, "exact.bin");
    fs.writeFileSync(filePath, Buffer.alloc(CAP, 9));

    const result = await tools.call("s3_put_object", {
      bucket: "b",
      key: "exact.bin",
      filePath,
      contentType: "application/octet-stream",
    });

    expect(result.isError).toBeFalsy();
    expect(s3.requestsFor("putObject")[0].input).toMatchObject({ contentLength: CAP });
    expect(sentBody().byteLength).toBe(CAP);
  });

  it("rejects a filePath of 1,048,577 bytes with the documented message", async () => {
    const filePath = path.join(dir, "over.bin");
    fs.writeFileSync(filePath, Buffer.alloc(CAP + 1, 9));

    const result = await tools.call("s3_put_object", {
      bucket: "b",
      key: "over.bin",
      filePath,
      contentType: "application/octet-stream",
    });

    expect(result.isError).toBe(true);
    expectInlineUploadRefusal(result, CAP + 1);
  });
});

describe("s3_get_object inline cap boundary", () => {
  it("returns a body of exactly 1,048,576 bytes inline as base64", async () => {
    queueDownload({
      contentLength: CAP,
      body: Readable.from([Buffer.alloc(CAP, 3)]) as B2S3DownloadedObject["body"],
    });

    const result = await tools.call("s3_get_object", { bucket: "b", key: "obj.bin" });

    expect(result.isError).toBeFalsy();
    const payload = parseResult(result);
    expect(payload).toMatchObject({ contentLength: CAP, encoding: "base64" });
    expect(Buffer.from(payload.content, "base64").byteLength).toBe(CAP);
  });

  it("refuses a body of 1,048,577 bytes and cancels it without reading", async () => {
    let canceled = 0;
    queueDownload({
      contentLength: CAP + 1,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(CAP + 1));
          controller.close();
        },
        cancel() {
          canceled++;
        },
      }) as unknown as B2S3DownloadedObject["body"],
    });

    const result = await tools.call("s3_get_object", { bucket: "b", key: "obj.bin" });

    expect(result.isError).toBe(true);
    const text = parseResult(result) as string;
    expect(text).toContain(`Object is ${CAP + 1} bytes, over the ${CAP}-byte inline read limit`);
    expect(text).toContain("saveToPath");
    expect(parseErrorText(text)).toMatchObject({ code: "bad_request", status: 400 });
    expect(canceled).toBe(1);
  });

  it("does not apply the inline cap to saveToPath", async () => {
    const target = path.join(dir, "big.bin");
    queueDownload({
      contentLength: CAP + 1,
      body: Readable.from([Buffer.alloc(CAP + 1, 5)]) as B2S3DownloadedObject["body"],
    });

    const result = await tools.call("s3_get_object", {
      bucket: "b",
      key: "obj.bin",
      saveToPath: target,
    });

    expect(result.isError).toBeFalsy();
    expect(parseResult(result)).toContain(`(${CAP + 1} bytes)`);
    expect(fs.statSync(target).size).toBe(CAP + 1);
  });
});
