import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import {
  FAKE_HOST,
  FAKE_KEY,
  FAKE_KEY_ID,
  startFakeB2Endpoint,
  writeFixtureFile,
  type FakeB2Endpoint,
} from "../../test-support/fake-b2-endpoint";
import { stringifySpawnEnv } from "../../test-support/mcp-server-process";
import {
  MODERN_PROTOCOL_VERSION,
  ROOT,
  protocolEnv,
  requireBuiltEntrypoints,
} from "../support/protocol";

/**
 * Customer-health basic path: the real built stdio server, driven over MCP,
 * talking to a local HTTPS fake through the test-only `B2_TEST_REALM` override.
 * No real B2 credentials or network are involved; the fixture credentials only
 * match the fake. See docs/TESTING.md ("Local fake endpoint").
 */

const DIST_INDEX = join(ROOT, "dist/index.js");
const PRELOAD = join(ROOT, "test-support/loopback-dns-preload.cjs");

let endpoint: FakeB2Endpoint;
let workDir: string;

beforeAll(async () => {
  requireBuiltEntrypoints();
  endpoint = await startFakeB2Endpoint();
  workDir = mkdtempSync(join(tmpdir(), "b2-basic-path-"));
});

afterAll(async () => {
  await endpoint.close();
  rmSync(workDir, { recursive: true, force: true });
});

async function connect(extraEnv: NodeJS.ProcessEnv = {}): Promise<Client> {
  const env = protocolEnv({
    B2_APPLICATION_KEY_ID: FAKE_KEY_ID,
    B2_APPLICATION_KEY: FAKE_KEY,
    B2_REGION: "us-west-004",
    B2_REGISTER_ALL_TOOLS: "false",
    B2_SECRET_SINK: "off",
    B2_FILE_ROOT: workDir,
    B2_TEST_REALM: endpoint.origin,
    B2_TEST_LOOPBACK_HOST: FAKE_HOST,
    NODE_EXTRA_CA_CERTS: endpoint.caCertPath,
    ...extraEnv,
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--require", PRELOAD, DIST_INDEX],
    cwd: ROOT,
    env: stringifySpawnEnv(env),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "b2-mcp-basic-path-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } }, defaultCacheTtlMs: 0 },
  );
  await client.connect(transport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("");
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text };
  }
}

function putPart(rawUrl: string, body: Buffer): Promise<string> {
  const url = new URL(rawUrl);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        method: "PUT",
        host: "127.0.0.1",
        port: url.port,
        path: `${url.pathname}${url.search}`,
        servername: FAKE_HOST,
        headers: { host: url.host },
        ca: readFileSync(endpoint.caCertPath),
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          res.statusCode === 200
            ? resolve(String(res.headers.etag))
            : reject(new Error(`part PUT returned ${res.statusCode}`)),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

async function createBucket(client: Client, name: string): Promise<string> {
  const created = await call(client, "b2_create_bucket", {
    bucketName: name,
    bucketType: "allPrivate",
  });
  expect(created).toMatchObject({ bucketName: name, bucketType: "allPrivate" });
  return String(created.bucketId);
}

describe("basic path against the local fake endpoint (MCP 2026-07-28, stdio)", () => {
  it("round-trips a small object: create, put, head, get, list, copy, delete", async () => {
    const client = await connect();
    try {
      const bucket = "basic-path-small";
      const bucketId = await createBucket(client, bucket);
      const content = Buffer.from("hello from the basic path");

      await call(client, "s3_put_object", {
        bucket,
        key: "docs/hello.txt",
        content: content.toString("base64"),
        contentType: "text/plain",
      });
      expect(await call(client, "s3_head_object", { bucket, key: "docs/hello.txt" })).toMatchObject(
        {
          key: "docs/hello.txt",
          contentType: "text/plain",
          contentLength: content.length,
        },
      );
      const fetched = await call(client, "s3_get_object", { bucket, key: "docs/hello.txt" });
      expect(Buffer.from(String(fetched.content), "base64")).toEqual(content);

      await call(client, "s3_copy_object", {
        sourceBucket: bucket,
        sourceKey: "docs/hello.txt",
        destinationBucket: bucket,
        destinationKey: "copies/hello.txt",
      });
      const listed = await call(client, "s3_list_objects_v2", { bucket });
      expect((listed.objects as Array<{ Key: string }>).map((o) => o.Key)).toEqual([
        "copies/hello.txt",
        "docs/hello.txt",
      ]);

      await call(client, "s3_delete_object", { bucket, key: "docs/hello.txt", confirm: true });
      await call(client, "s3_delete_object", { bucket, key: "copies/hello.txt", confirm: true });
      expect((await call(client, "s3_list_objects_v2", { bucket })).objects).toEqual([]);
      await call(client, "b2_delete_bucket", { bucketId, confirm: true });

      // The traffic really crossed the loopback socket, and nothing else did.
      expect(endpoint.s3Requests.map((r) => r.split(" ")[0])).toEqual(
        expect.arrayContaining(["PUT", "HEAD", "GET", "DELETE"]),
      );
    } finally {
      await client.close();
    }
  });

  it("moves a multi-MiB object through a minted presigned part URL and saveToPath", async () => {
    const client = await connect();
    try {
      const bucket = "basic-path-large";
      const bucketId = await createBucket(client, bucket);
      const first = writeFixtureFile(join(workDir, "part-1.bin"), 5 * 1024 * 1024);
      const second = writeFixtureFile(join(workDir, "part-2.bin"), 1024 * 1024 + 17);
      const whole = Buffer.concat([first, second]);

      const { uploadId } = await call(client, "s3_create_multipart_upload", {
        bucket,
        key: "big.bin",
      });
      const minted = await call(client, "s3_get_presigned_upload_part_url", {
        bucket,
        key: "big.bin",
        uploadId,
        partNumbers: [1, 2],
      });
      const urls = minted.parts as Array<{ partNumber: number; url: string }>;
      const etags = [await putPart(urls[0].url, first), await putPart(urls[1].url, second)];
      await call(client, "s3_complete_multipart_upload", {
        bucket,
        key: "big.bin",
        uploadId,
        parts: etags.map((etag, index) => ({ partNumber: index + 1, etag })),
      });

      const savePath = join(workDir, "downloaded.bin");
      await call(client, "s3_get_object", { bucket, key: "big.bin", saveToPath: savePath });
      const saved = readFileSync(savePath);
      expect(saved.length).toBe(whole.length);
      expect(sha256(saved)).toBe(sha256(whole));

      await call(client, "s3_delete_object", { bucket, key: "big.bin", confirm: true });
      await call(client, "b2_delete_bucket", { bucketId, confirm: true });
    } finally {
      await client.close();
    }
  });
});
