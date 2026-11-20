/**
 * Cases for src/s3/objects.ts: C2, C5, C6, C7, C8, C9. Each asserts the correct behavior.
 * C6 and the valid-base64 property already hold and run as normal tests; the other cases are
 * still defective and use `knownDefect` (see tests/support/known-defect.ts).
 */
import fc from "fast-check";
import { ReadableStream } from "node:stream/web";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerS3ObjectTools } from "../../src/s3/objects";
import type { B2S3DownloadedObject } from "../../src/s3/aws-sdk-adapter";
import { MAX_MCP_BODY_BYTES, readCappedBodyBytes } from "../../src/utils/http-body-limit";
import {
  circuitBreaker,
  s3CircuitBreaker,
  s3TransferCircuitBreaker,
} from "../../src/utils/circuit-breaker";
import { parseErrorText } from "../../src/utils/errors";
import type { B2Config, B2S3VersionGuard } from "../../src/utils/types";
import {
  DeterministicS3ClientFake,
  ToolHarness,
  parseResult,
  testConfig,
} from "../support/deterministic-fakes";
import { FASTCHECK_SEED } from "../support/fast-check-seed";
import { expectDefect, knownDefect } from "../support/known-defect";

const INLINE_LIMIT = 1024 * 1024;

const noVersions: B2S3VersionGuard = {
  async resolveS3FileVersion() {
    throw new Error("not used");
  },
  async resolveS3FileVersions(input) {
    return input.objects.map((object) => ({ object, version: null }));
  },
  async getCurrentS3FileVersion() {
    return null;
  },
};

function streamFrom(chunks: Uint8Array[]): B2S3DownloadedObject["body"] {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }) as unknown as B2S3DownloadedObject["body"];
}

function setup(config: B2Config = testConfig) {
  const s3 = new DeterministicS3ClientFake();
  s3.allowDefault("putObject");
  const tools = new ToolHarness();
  registerS3ObjectTools(tools, s3.asPeerClient(), noVersions, config);
  return { s3, tools };
}

afterEach(() => {
  circuitBreaker.close();
  s3CircuitBreaker.close();
  s3TransferCircuitBreaker.close();
});

describe("Finding C5: early local-file refusals are client errors (400), not 500", () => {
  let dir: string;
  let outside: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-c5-root-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "b2-c5-out-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "x");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  knownDefect("s3_put_object with local files disabled returns 400", async () => {
    const { tools, s3 } = setup({ ...testConfig, allowLocalFiles: false });
    const result = await tools.call("s3_put_object", {
      bucket: "b",
      key: "k",
      filePath: path.join(outside, "secret.txt"),
      contentType: "text/plain",
    });
    expect(result.isError, "request is refused").toBe(true);
    expect(s3.requests, "no S3 request sent").toEqual([]);
    const error = parseErrorText(parseResult(result) as string);
    await expectDefect(() => expect(error, "error status").toMatchObject({ status: 400 }));
  });

  knownDefect("s3_put_object with a filePath outside the sandbox root returns 400", async () => {
    const { tools, s3 } = setup({ ...testConfig, fileRoot: dir });
    const result = await tools.call("s3_put_object", {
      bucket: "b",
      key: "k",
      filePath: path.join(outside, "secret.txt"),
      contentType: "text/plain",
    });
    expect(result.isError, "request is refused").toBe(true);
    expect(s3.requests, "no S3 request sent").toEqual([]);
    const error = parseErrorText(parseResult(result) as string);
    await expectDefect(() => expect(error, "error status").toMatchObject({ status: 400 }));
  });

  knownDefect("s3_get_object with local files disabled and saveToPath returns 400", async () => {
    const { tools, s3 } = setup({ ...testConfig, allowLocalFiles: false });
    const result = await tools.call("s3_get_object", {
      bucket: "b",
      key: "k",
      saveToPath: path.join(dir, "out.bin"),
    });
    expect(result.isError, "request is refused").toBe(true);
    expect(s3.requests, "no S3 request sent").toEqual([]);
    const error = parseErrorText(parseResult(result) as string);
    await expectDefect(() => expect(error, "error status").toMatchObject({ status: 400 }));
  });

  knownDefect("s3_get_object with a saveToPath outside the sandbox root returns 400", async () => {
    const { tools, s3 } = setup({ ...testConfig, fileRoot: dir });
    const result = await tools.call("s3_get_object", {
      bucket: "b",
      key: "k",
      saveToPath: path.join(outside, "out.bin"),
    });
    expect(result.isError, "request is refused").toBe(true);
    expect(s3.requests, "no S3 request sent").toEqual([]);
    const error = parseErrorText(parseResult(result) as string);
    await expectDefect(() => expect(error, "error status").toMatchObject({ status: 400 }));
  });
});

describe("Finding C6: empty inline content", () => {
  it("uploads a zero-byte object for content='' instead of rejecting it as missing", async () => {
    const { tools, s3 } = setup();
    const result = await tools.call("s3_put_object", {
      bucket: "b",
      key: "empty.txt",
      content: "",
      contentType: "text/plain",
    });

    expect(result.isError, "empty content is accepted").toBeFalsy();
    const puts = s3.requestsFor("putObject");
    expect(puts, "one put sent").toHaveLength(1);
    const body = (puts[0].input as { body: Uint8Array }).body;
    expect(Buffer.from(body), "uploaded body is zero bytes").toEqual(Buffer.alloc(0));
  });
});

describe("Finding C7: inline upload input handling", () => {
  knownDefect(
    "rejects content that is not valid base64 instead of uploading decoded garbage (property)",
    async () => {
      // fc.check reports the property's own failure (the AssertionError from the checks below)
      // as errorInstance, so only that failure is accepted as the defect.
      const details = await fc.check(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 24 }),
          fc.constantFrom("!", "@", "#", "$", "%", "^", "*", "("),
          fc.string({ maxLength: 24 }),
          async (head, bad, tail) => {
            const { tools, s3 } = setup();
            const result = await tools.call("s3_put_object", {
              bucket: "b",
              key: "k",
              content: `${head}${bad}${tail}`,
              contentType: "text/plain",
            });
            expect(result.isError, "invalid base64 is refused").toBe(true);
            expect(s3.requestsFor("putObject"), "no put sent").toHaveLength(0);
          },
        ),
        { numRuns: 25, seed: FASTCHECK_SEED },
      );
      await expectDefect(() => {
        if (details.failed) throw details.errorInstance;
      });
    },
  );

  it("uploads exactly the bytes of any valid base64 content (property, guard)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 1, maxLength: 64 }), async (bytes) => {
        const { tools, s3 } = setup();
        const result = await tools.call("s3_put_object", {
          bucket: "b",
          key: "k",
          content: Buffer.from(bytes).toString("base64"),
          contentType: "application/octet-stream",
        });
        expect(result.isError, "valid base64 is accepted").toBeFalsy();
        const body = (s3.requestsFor("putObject")[0].input as { body: Uint8Array }).body;
        expect(Buffer.from(body).equals(Buffer.from(bytes)), "uploaded bytes match").toBe(true);
      }),
      { numRuns: 25, seed: FASTCHECK_SEED },
    );
  });

  knownDefect("does not silently let filePath win when content is also supplied", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-c7-"));
    try {
      const file = path.join(dir, "a.txt");
      fs.writeFileSync(file, "FROM-FILE");
      const { tools, s3 } = setup();
      const result = await tools.call("s3_put_object", {
        bucket: "b",
        key: "k",
        filePath: file,
        content: Buffer.from("FROM-CONTENT").toString("base64"),
        contentType: "text/plain",
      });

      // Ambiguous input must be refused, not resolved by quietly ignoring one source.
      await expectDefect(() => {
        expect(result.isError, "filePath plus content is refused").toBe(true);
        expect(s3.requestsFor("putObject"), "no put sent").toHaveLength(0);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Inline limit the s3_put_object description advertises, in bytes (for example "≤1 MiB"). */
function advertisedInlineLimitBytes(): number {
  let description = "";
  const registrar = {
    registerTool(name: string, config: { description?: string }) {
      if (name === "s3_put_object") description = config.description ?? "";
    },
  };
  const s3 = new DeterministicS3ClientFake();
  registerS3ObjectTools(registrar as never, s3.asPeerClient(), noVersions, testConfig);
  const match = /≤\s*(\d+)\s*MiB/.exec(description);
  if (!match) throw new Error(`s3_put_object description has no "≤N MiB" limit: ${description}`);
  return Number(match[1]) * 1024 * 1024;
}

/** The complete JSON-RPC tools/call request an MCP client sends for an inline upload. */
function putObjectRequestBody(payloadBytes: number): Uint8Array {
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "s3_put_object",
      arguments: {
        bucket: "b",
        key: "limit.bin",
        content: Buffer.alloc(payloadBytes).toString("base64"),
        contentType: "application/octet-stream",
      },
    },
  };
  return new TextEncoder().encode(JSON.stringify(request));
}

const postRequest = (body: Uint8Array) =>
  new Request("http://localhost/mcp", { method: "POST", body: body as never });

describe("Finding C8: inline put limit versus the HTTP body cap", () => {
  it("the HTTP body reader accepts a request of exactly the cap and rejects one byte more (guard)", async () => {
    expect(
      await readCappedBodyBytes(postRequest(new Uint8Array(MAX_MCP_BODY_BYTES))),
      "request of exactly the cap",
    ).not.toBeNull();
    expect(
      await readCappedBodyBytes(postRequest(new Uint8Array(MAX_MCP_BODY_BYTES + 1))),
      "request one byte over the cap",
    ).toBeNull();
  });

  knownDefect(
    "a complete MCP tools/call request carrying the largest inline upload is accepted by the HTTP body cap",
    async () => {
      const inlineLimit = advertisedInlineLimitBytes();
      expect(inlineLimit, "the tool advertises 1 MiB inline").toBe(INLINE_LIMIT);

      const { tools, s3 } = setup();
      const result = await tools.call("s3_put_object", {
        bucket: "b",
        key: "limit.bin",
        content: Buffer.alloc(inlineLimit).toString("base64"),
        contentType: "application/octet-stream",
      });
      expect(result.isError, "the tool accepts the advertised maximum inline payload").toBeFalsy();
      expect(s3.requestsFor("putObject"), "one put sent").toHaveLength(1);

      // The whole serialized request (JSON-RPC envelope included) goes through the HTTP reader.
      // A payload the tool accepts but the HTTP transport rejects (413) is a contract gap.
      const accepted = await readCappedBodyBytes(postRequest(putObjectRequestBody(inlineLimit)));
      await expectDefect(() =>
        expect(
          accepted,
          "HTTP accepts the full request for the largest inline upload",
        ).not.toBeNull(),
      );
    },
  );
});

describe("Finding C9: failed save-to-path downloads leave nothing behind", () => {
  knownDefect("does not create the parent directories when the object fetch fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-c9-"));
    try {
      const { tools, s3 } = setup();
      s3.respond("getObject", () => {
        throw Object.assign(new Error("Object not found"), { status: 404, code: "not_found" });
      });
      const target = path.join(root, "made", "up", "out.bin");

      const result = await tools.call("s3_get_object", {
        bucket: "b",
        key: "missing",
        saveToPath: target,
      });

      expect(result.isError, "missing object is an error").toBe(true);
      await expectDefect(() =>
        expect(fs.existsSync(path.join(root, "made")), "parent directory created").toBe(false),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Finding C2: inline s3_get_object checks the received length", () => {
  knownDefect("fails when the body ends before the advertised contentLength", async () => {
    const { tools, s3 } = setup();
    s3.respond("getObject", () => ({
      key: "k",
      contentType: "text/plain",
      contentLength: 10,
      lastModified: new Date("2026-01-01T00:00:00.000Z"),
      etag: '"e"',
      versionId: "v",
      metadata: {},
      body: streamFrom([new TextEncoder().encode("abc")]),
    }));

    const result = await tools.call("s3_get_object", { bucket: "b", key: "k" });

    await expectDefect(() => {
      expect(result.isError, "truncated body is an error").toBe(true);
      expect(parseErrorText(parseResult(result) as string), "error code").toMatchObject({
        code: "incomplete_download",
      });
    });
  });
});
