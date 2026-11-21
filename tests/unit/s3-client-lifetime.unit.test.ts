// cspell:ignore serde
import { Readable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { B2S3VersionGuard } from "../../src/utils/types";
import { ToolHarness, parseResult, testConfig } from "../support/deterministic-fakes";

const peers = vi.hoisted(() => [] as Array<{ destroy: ReturnType<typeof vi.fn> }>);
const settings = vi.hoisted(() => ({
  body: "node" as
    | "node"
    | "node-error"
    | "web"
    | "web-split"
    | "web-error"
    | "missing"
    | "rejected",
  sdk: false,
  gate: undefined as Promise<void> | undefined,
}));
vi.mock("../../src/s3/aws-sdk-adapter.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/s3/aws-sdk-adapter.js")>();
  const { createRequire } = await import("node:module");
  const sdkRequire = createRequire(
    createRequire(`${process.cwd()}/package.json`).resolve("@aws-sdk/client-s3"),
  );
  const mixin = sdkRequire("@smithy/core/serde").sdkStreamMixin as (value: unknown) => unknown;
  return {
    ...original,
    createB2S3PeerClient: vi.fn(() => {
      let destroyed = false;
      let pulls = 0;
      const peer = {
        destroy: vi.fn(() => {
          destroyed = true;
        }),
        getObject: vi.fn(async () => {
          if (settings.body === "rejected") throw new Error("request failed");
          const result = {
            key: "key",
            contentLength: 11,
            metadata: {},
            body:
              settings.body === "missing"
                ? undefined
                : !settings.body.startsWith("node")
                  ? new ReadableStream<Uint8Array>(
                      {
                        async pull(controller) {
                          if (settings.gate) await settings.gate;
                          if (settings.body === "web-error")
                            controller.error(new Error("body failed"));
                          else if (destroyed)
                            controller.error(new Error("client destroyed before body read"));
                          else if (settings.body === "web-split") {
                            controller.enqueue(
                              new TextEncoder().encode(pulls++ === 0 ? "hello " : "world"),
                            );
                            if (pulls === 2) controller.close();
                          } else {
                            controller.enqueue(new TextEncoder().encode("hello world"));
                            controller.close();
                          }
                        },
                      },
                      { highWaterMark: 0 },
                    )
                  : new Readable({
                      read() {
                        if (settings.body === "node-error") this.destroy(new Error("body failed"));
                        else if (destroyed)
                          this.destroy(new Error("client destroyed before body read"));
                        else {
                          this.push(Buffer.from("hello world"));
                          this.push(null);
                        }
                      },
                    }),
          };
          if (settings.sdk && result.body) result.body = mixin(result.body) as typeof result.body;
          return result;
        }),
      };
      peers.push(peer);
      return peer;
    }),
  };
});

import { createAuthorizedS3Client } from "../../src/s3/client";
import { registerS3ObjectTools } from "../../src/s3/objects";

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

describe("fallback S3 download client lifetime", () => {
  beforeEach(() => {
    peers.length = 0;
    settings.body = "node";
    settings.sdk = false;
    settings.gate = undefined;
  });
  it.each(["inline", "saveToPath"])(
    "reads the complete %s body before destroying the fallback client",
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), "b2-c1-"));
      const facade = createAuthorizedS3Client({
        getConfig: () => ({ ...testConfig, fileRoot: root }),
        getAuth: async () => {
          throw new Error("authorize unavailable");
        },
      });
      const tools = new ToolHarness();
      registerS3ObjectTools(tools, facade, versions, { ...testConfig, fileRoot: root });
      try {
        const file = join(root, "download.txt");
        const result = await tools.call("s3_get_object", {
          bucket: "bucket",
          key: "key",
          ...(mode === "saveToPath" ? { saveToPath: file } : {}),
        });
        expect(result.isError, String(parseResult(result))).not.toBe(true);
        if (mode === "saveToPath") expect(readFileSync(file, "utf8")).toBe("hello world");
        else expect(parseResult(result)).toMatchObject({ content: "aGVsbG8gd29ybGQ=" });
        expect(peers).toHaveLength(1);
        expect(peers[0]?.destroy).toHaveBeenCalledTimes(1);
      } finally {
        facade.destroy();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it("keeps a fallback web stream alive until it is consumed", async () => {
    settings.body = "web";
    const facade = createAuthorizedS3Client({
      getConfig: () => testConfig,
      getAuth: async () => {
        throw new Error("authorize unavailable");
      },
    });
    const object = await facade.getObject({ bucket: "bucket", key: "key" });
    expect(peers[0]?.destroy).not.toHaveBeenCalled();
    const reader = (object.body as ReadableStream<Uint8Array>).getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toBe("hello world");
    expect((await reader.read()).done).toBe(true);
    await vi.waitFor(() => expect(peers[0]?.destroy).toHaveBeenCalledTimes(1));
    facade.destroy();
  });

  it("releases a fallback web stream when the caller cancels it", async () => {
    settings.body = "web";
    const facade = createAuthorizedS3Client({
      getConfig: () => testConfig,
      getAuth: async () => {
        throw new Error("authorize unavailable");
      },
    });
    const object = await facade.getObject({ bucket: "bucket", key: "key" });
    expect(peers[0]?.destroy).not.toHaveBeenCalled();
    await (object.body as ReadableStream<Uint8Array>).cancel();
    await vi.waitFor(() => expect(peers[0]?.destroy).toHaveBeenCalledTimes(1));
    facade.destroy();
  });
  it.each(["missing", "rejected"] as const)(
    "immediately releases a fallback client when the body is %s",
    async (mode) => {
      settings.body = mode;
      const facade = createAuthorizedS3Client({
        getConfig: () => testConfig,
        getAuth: async () => {
          throw new Error("authorize unavailable");
        },
      });
      if (mode === "rejected")
        await expect(facade.getObject({ bucket: "bucket", key: "key" })).rejects.toThrow(
          "request failed",
        );
      else expect((await facade.getObject({ bucket: "bucket", key: "key" })).body).toBeUndefined();
      expect(peers[0]?.destroy).toHaveBeenCalledTimes(1);
      facade.destroy();
    },
  );

  it("releases a fallback client when a Web body fails", async () => {
    settings.body = "web-error";
    const facade = createAuthorizedS3Client({
      getConfig: () => testConfig,
      getAuth: async () => {
        throw new Error("authorize unavailable");
      },
    });
    const object = await facade.getObject({ bucket: "bucket", key: "key" });
    const reader = (object.body as ReadableStream<Uint8Array>).getReader();
    await expect(reader.read()).rejects.toThrow("body failed");
    expect(peers[0]?.destroy).toHaveBeenCalledTimes(1);
    facade.destroy();
  });

  it("does not release the cached client when a body ends", async () => {
    const facade = createAuthorizedS3Client({
      getConfig: () => testConfig,
      getAuth: async () => ({ s3ApiUrl: "https://s3.us-west-004.backblazeb2.com" }) as never,
    });
    const object = await facade.getObject({ bucket: "bucket", key: "key" });
    const chunks: Buffer[] = [];
    for await (const chunk of object.body as Readable) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("hello world");
    expect(peers[0]?.destroy).not.toHaveBeenCalled();
    facade.destroy();
    expect(peers[0]?.destroy).toHaveBeenCalledTimes(1);
  });
  it.each(["transformToString", "transformToByteArray", "transformToWebStream"] as const)(
    "keeps the SDK Web helper %s usable and releases the client",
    async (method) => {
      settings.body = "web";
      settings.sdk = true;
      const facade = createAuthorizedS3Client({
        getConfig: () => testConfig,
        getAuth: async () => {
          throw new Error("authorize unavailable");
        },
      });
      const object = await facade.getObject({ bucket: "bucket", key: "key" });
      const body = object.body as ReadableStream<Uint8Array> & {
        transformToString(): Promise<string>;
        transformToByteArray(): Promise<Uint8Array>;
        transformToWebStream(): ReadableStream<Uint8Array>;
      };
      let result: string;
      if (method === "transformToString") result = await body.transformToString();
      else if (method === "transformToByteArray")
        result = new TextDecoder().decode(await body.transformToByteArray());
      else {
        const reader = body.transformToWebStream().getReader();
        result = new TextDecoder().decode((await reader.read()).value);
        await reader.read();
      }
      expect(result).toBe("hello world");
      await vi.waitFor(() => expect(peers[0]?.destroy).toHaveBeenCalledTimes(1));
      facade.destroy();
    },
  );

  it("does not destroy an active Web stream when a second SDK transform is refused", async () => {
    settings.body = "web";
    settings.sdk = true;
    const facade = createAuthorizedS3Client({
      getConfig: () => testConfig,
      getAuth: async () => {
        throw new Error("authorize unavailable");
      },
    });
    const object = await facade.getObject({ bucket: "bucket", key: "key" });
    const body = object.body as ReadableStream<Uint8Array> & {
      transformToString(): Promise<string>;
    };
    const reader = body.getReader();
    await expect(body.transformToString()).rejects.toThrow();
    expect(peers[0]?.destroy).not.toHaveBeenCalled();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("hello world");
    expect((await reader.read()).done).toBe(true);
    await vi.waitFor(() => expect(peers[0]?.destroy).toHaveBeenCalledTimes(1));
    facade.destroy();
  });
  it.each(["node", "web"] as const)(
    "releases an unread fallback %s stream on facade shutdown exactly once",
    async (mode) => {
      settings.body = mode;
      const facade = createAuthorizedS3Client({
        getConfig: () => testConfig,
        getAuth: async () => {
          throw new Error("authorize unavailable");
        },
      });
      const object = await facade.getObject({ bucket: "bucket", key: "key" });
      expect(peers[0]?.destroy).not.toHaveBeenCalled();
      facade.destroy();
      expect(peers[0]?.destroy).toHaveBeenCalledTimes(1);
      if (mode === "node") {
        const stream = object.body as Readable;
        const closed = new Promise<void>((resolve) => stream.once("close", resolve));
        stream.destroy();
        await closed;
      } else await (object.body as ReadableStream<Uint8Array>).cancel();
      expect(peers[0]?.destroy).toHaveBeenCalledTimes(1);
    },
  );
  it("preserves SDK transforms after a partial Web read releases its reader", async () => {
    settings.body = "web-split";
    settings.sdk = true;
    const facade = createAuthorizedS3Client({
      getConfig: () => testConfig,
      getAuth: async () => {
        throw new Error("authorize unavailable");
      },
    });
    const object = await facade.getObject({ bucket: "bucket", key: "key" });
    const body = object.body as ReadableStream<Uint8Array> & {
      transformToString(): Promise<string>;
    };
    const reader = body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("hello ");
    reader.releaseLock();
    expect(await body.transformToString()).toBe("world");
    expect(peers[0]?.destroy).toHaveBeenCalledTimes(1);
    facade.destroy();
  });
  it("releases a fallback client when a Node body fails", async () => {
    settings.body = "node-error";
    const facade = createAuthorizedS3Client({
      getConfig: () => testConfig,
      getAuth: async () => {
        throw new Error("authorize unavailable");
      },
    });
    const object = await facade.getObject({ bucket: "bucket", key: "key" });
    await expect(
      (async () => {
        for await (const chunk of object.body as Readable) {
          expect(chunk).toBeDefined();
        }
      })(),
    ).rejects.toThrow("body failed");
    await vi.waitFor(() => expect(peers[0]?.destroy).toHaveBeenCalledTimes(1));
    facade.destroy();
  });
  it("keeps the Web stream locked during an SDK transform", async () => {
    settings.body = "web";
    settings.sdk = true;
    let resume!: () => void;
    settings.gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const facade = createAuthorizedS3Client({
      getConfig: () => testConfig,
      getAuth: async () => {
        throw new Error("authorize unavailable");
      },
    });
    const object = await facade.getObject({ bucket: "bucket", key: "key" });
    const body = object.body as ReadableStream<Uint8Array> & {
      transformToString(): Promise<string>;
    };
    const result = body.transformToString();
    try {
      expect(() => body.getReader()).toThrow();
    } finally {
      resume();
      await result;
      facade.destroy();
    }
  });
});
