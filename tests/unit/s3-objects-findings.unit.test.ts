import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerS3ObjectTools } from "../../src/s3/objects";
import { parseErrorText } from "../../src/utils/errors";
import type { B2S3VersionGuard } from "../../src/utils/types";
import type { B2S3PutObjectOptions } from "../../src/s3/aws-sdk-adapter";
import {
  DeterministicS3ClientFake,
  ToolHarness,
  parseResult,
  testConfig,
} from "../support/deterministic-fakes";

const versions: B2S3VersionGuard = {
  async resolveS3FileVersion() {
    throw new Error("Unexpected version lookup");
  },
  async resolveS3FileVersions() {
    return [];
  },
  async getCurrentS3FileVersion() {
    return null;
  },
};

describe("Finding C7: upload input validation", () => {
  let root: string;
  let tools: ToolHarness;
  let s3: DeterministicS3ClientFake;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "b2-c7-")));
    s3 = new DeterministicS3ClientFake().allowDefault("putObject");
    tools = new ToolHarness();
    registerS3ObjectTools(tools, s3.asPeerClient(), versions, { ...testConfig, fileRoot: root });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const args = { bucket: "bucket", key: "key", contentType: "text/plain" };

  it.each([
    ["invalid character", "aGVsbG8*gd29ybGQ="],
    ["internal padding", "aGV=sbG8="],
    ["excess padding", "aGVsbG8==="],
    ["incomplete quantum", "a"],
    ["nonzero padding bits", "Zh=="],
    ["whitespace", "aGVs bG8="],
  ])("rejects malformed base64: %s", async (_label, content) => {
    const result = await tools.call("s3_put_object", { ...args, content });
    expect(result.isError).toBe(true);
    expect(parseErrorText(parseResult(result) as string)).toMatchObject({
      status: 400,
      code: "bad_request",
    });
    expect(s3.requests).toEqual([]);
  });

  it.each(["aGVsbG8=", ""])(
    "rejects filePath with content %j without uploading",
    async (content) => {
      const filePath = path.join(root, "source.txt");
      fs.writeFileSync(filePath, "file");
      const result = await tools.call("s3_put_object", { ...args, filePath, content });
      expect(result.isError).toBe(true);
      expect(parseErrorText(parseResult(result) as string)).toMatchObject({
        status: 400,
        code: "bad_request",
      });
      expect(s3.requests).toEqual([]);
    },
  );

  it("uploads the exact bytes of valid base64", async () => {
    const result = await tools.call("s3_put_object", { ...args, content: "aGVsbG8gd29ybGQ=" });
    expect(result.isError).not.toBe(true);
    const input = s3.requestsFor("putObject")[0]?.input as B2S3PutObjectOptions;
    expect(Buffer.from(input.body as Uint8Array).toString("utf8")).toBe("hello world");
    expect(input.contentLength).toBe(11);
  });

  it.each([
    ["without padding", "aGk", "hi"],
    ["empty", "", ""],
  ])("accepts valid %s base64", async (_label, content, expected) => {
    const result = await tools.call("s3_put_object", { ...args, content });
    expect(result.isError).not.toBe(true);
    const input = s3.requestsFor("putObject")[0]?.input as B2S3PutObjectOptions;
    expect(Buffer.from(input.body as Uint8Array).toString("utf8")).toBe(expected);
    expect(input.contentLength).toBe(Buffer.byteLength(expected));
  });

  it("accepts a file exactly at the inline limit", async () => {
    const filePath = path.join(root, "max.bin");
    fs.writeFileSync(filePath, Buffer.alloc(1024 * 1024, 65));
    const result = await tools.call("s3_put_object", { ...args, filePath });
    expect(result.isError).not.toBe(true);
    const input = s3.requestsFor("putObject")[0]?.input as B2S3PutObjectOptions;
    expect(input.contentLength).toBe(1024 * 1024);
    expect(input.body).toEqual(Buffer.alloc(1024 * 1024, 65));
  });

  it.each([
    ["within limit", " world", "hello world"],
    ["beyond limit", "x".repeat(1024 * 1024), null],
  ])("handles file growth after the size snapshot (%s)", async (_label, suffix, expected) => {
    const filePath = path.join(root, "source.txt");
    fs.writeFileSync(filePath, "hello");
    const open = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...openArgs) => {
      const handle = await open(...(openArgs as Parameters<typeof open>));
      if (String(openArgs[0]) !== filePath) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "stat")
            return async () => {
              const snapshot = await target.stat();
              fs.appendFileSync(filePath, suffix);
              return snapshot;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    try {
      const result = await tools.call("s3_put_object", { ...args, filePath });
      if (expected === null) {
        expect(result.isError).toBe(true);
        expect(parseErrorText(parseResult(result) as string)).toMatchObject({
          status: 400,
          code: "bad_request",
        });
        expect(s3.requests).toEqual([]);
      } else {
        expect(result.isError).not.toBe(true);
        const input = s3.requestsFor("putObject")[0]?.input as B2S3PutObjectOptions;
        expect(Buffer.from(input.body as Uint8Array).toString("utf8")).toBe(expected);
        expect(input.contentLength).toBe(Buffer.byteLength(expected));
      }
    } finally {
      openSpy.mockRestore();
    }
  });
  it("uses bytes read when an oversized file shrinks after stat", async () => {
    const filePath = path.join(root, "shrinking.txt");
    fs.writeFileSync(filePath, Buffer.alloc(1024 * 1024 + 1));
    const open = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...openArgs) => {
      const handle = await open(...(openArgs as Parameters<typeof open>));
      if (String(openArgs[0]) !== filePath) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "stat")
            return async () => {
              const snapshot = await target.stat();
              fs.writeFileSync(filePath, "small");
              return snapshot;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    try {
      const result = await tools.call("s3_put_object", { ...args, filePath });
      expect(result.isError).not.toBe(true);
      const input = s3.requestsFor("putObject")[0]?.input as B2S3PutObjectOptions;
      expect(Buffer.from(input.body as Uint8Array).toString("utf8")).toBe("small");
      expect(input.contentLength).toBe(5);
    } finally {
      openSpy.mockRestore();
    }
  });
});
