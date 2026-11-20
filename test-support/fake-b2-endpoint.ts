import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";

/** Host the spawned server resolves to loopback; neither an IP literal nor `localhost`. */
export const FAKE_HOST = "b2-fake.test";
/** Fixture credentials. The id is not a substring of the key (the secret sanitizer redacts both). */
export const FAKE_KEY_ID = "fixtureAlphaKeyId";
export const FAKE_KEY = "fixtureOmegaSecretValue";

/** A running local HTTPS fake of the B2 native and S3-compatible endpoints. */
export interface FakeB2Endpoint {
  /** Exact origin to pass as `B2_TEST_REALM`. */
  readonly origin: string;
  /** PEM file to pass as `NODE_EXTRA_CA_CERTS` to the spawned server. */
  readonly caCertPath: string;
  /** The SDK's public in-process simulator that serves the native API. */
  readonly simulator: B2Simulator;
  /** Requests seen by the S3 handler, as `METHOD /path?query`. */
  readonly s3Requests: string[];
  /** Release the socket and remove the temporary certificate. */
  close(): Promise<void>;
}

interface StoredObject {
  body: Buffer;
  contentType: string;
  modified: Date;
}

interface MultipartUpload {
  key: string;
  parts: Map<number, Buffer>;
}

const xml = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const etagOf = (body: Buffer): string => `"${createHash("md5").update(body).digest("hex")}"`;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Decode an `aws-chunked` payload (SigV4 streaming framing) into the raw object bytes. */
function decodeAwsChunked(raw: Buffer): Buffer {
  const out: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const lineEnd = raw.indexOf("\r\n", offset);
    if (lineEnd === -1) break;
    const size = Number.parseInt(raw.subarray(offset, lineEnd).toString().split(";")[0] ?? "", 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(out);
}

/**
 * Minimal in-memory S3 handler: exactly the calls the basic-path tests make
 * (put/head/get/list/copy/delete object and multipart). It checks that the
 * request names the fixture key id but does not verify the signature.
 */
class FakeS3 {
  private readonly buckets = new Map<string, Map<string, StoredObject>>();
  private readonly uploads = new Map<string, MultipartUpload>();

  constructor(private readonly requests: string[]) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    this.requests.push(`${req.method} ${url.pathname}${url.search}`);
    const credential = `${req.headers.authorization ?? ""}${url.searchParams.get("X-Amz-Credential") ?? ""}`;
    if (!credential.includes(FAKE_KEY_ID)) return this.error(res, 403, "AccessDenied");
    const [bucket = "", ...rest] = url.pathname.split("/").filter(Boolean);
    const key = rest.map(decodeURIComponent).join("/");
    const objects = this.buckets.get(bucket) ?? new Map<string, StoredObject>();
    this.buckets.set(bucket, objects);
    const method = req.method ?? "GET";
    const uploadId = url.searchParams.get("uploadId");

    if (!key) return this.list(res, url, objects);
    if (method === "POST" && url.searchParams.has("uploads")) {
      const id = randomUUID();
      this.uploads.set(id, { key, parts: new Map() });
      return this.send(
        res,
        200,
        xml(
          `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        ),
      );
    }
    if (method === "PUT" && uploadId) {
      const upload = this.uploads.get(uploadId);
      if (!upload) return this.error(res, 404, "NoSuchUpload");
      const part = await this.readObjectBody(req);
      upload.parts.set(Number(url.searchParams.get("partNumber")), part);
      res.writeHead(200, { ETag: etagOf(part) }).end();
      return;
    }
    if (method === "POST" && uploadId)
      return this.complete(req, res, bucket, key, uploadId, objects);
    if (method === "DELETE" && uploadId) {
      this.uploads.delete(uploadId);
      res.writeHead(204).end();
      return;
    }
    const copySource = req.headers["x-amz-copy-source"];
    if (method === "PUT" && typeof copySource === "string") {
      const [srcBucket = "", ...srcKey] = decodeURIComponent(copySource)
        .replace(/^\//, "")
        .split("/");
      const source = this.buckets.get(srcBucket)?.get(srcKey.join("/"));
      if (!source) return this.error(res, 404, "NoSuchKey");
      objects.set(key, { ...source, modified: new Date() });
      return this.send(
        res,
        200,
        xml(
          `<CopyObjectResult><ETag>${etagOf(source.body)}</ETag><LastModified>${new Date().toISOString()}</LastModified></CopyObjectResult>`,
        ),
      );
    }
    if (method === "PUT") {
      const body = await this.readObjectBody(req);
      objects.set(key, {
        body,
        contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
        modified: new Date(),
      });
      res.writeHead(200, { ETag: etagOf(body) }).end();
      return;
    }
    if (method === "DELETE") {
      objects.delete(key);
      res.writeHead(204).end();
      return;
    }
    const object = objects.get(key);
    if (!object) {
      if (method === "HEAD") res.writeHead(404).end();
      else this.error(res, 404, "NoSuchKey");
      return;
    }
    res.writeHead(200, {
      ETag: etagOf(object.body),
      "Content-Length": object.body.length,
      "Content-Type": object.contentType,
      "Last-Modified": object.modified.toUTCString(),
    });
    res.end(method === "HEAD" ? undefined : object.body);
  }

  private async readObjectBody(req: IncomingMessage): Promise<Buffer> {
    const raw = await readBody(req);
    const chunked =
      String(req.headers["content-encoding"] ?? "").includes("aws-chunked") ||
      String(req.headers["x-amz-content-sha256"] ?? "").startsWith("STREAMING-");
    return chunked ? decodeAwsChunked(raw) : raw;
  }

  private list(res: ServerResponse, url: URL, objects: Map<string, StoredObject>): void {
    const prefix = url.searchParams.get("prefix") ?? "";
    const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const contents = keys
      .map((key) => {
        const object = objects.get(key) as StoredObject;
        return `<Contents><Key>${escapeXml(key)}</Key><LastModified>${object.modified.toISOString()}</LastModified><ETag>${etagOf(object.body)}</ETag><Size>${object.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
      })
      .join("");
    this.send(
      res,
      200,
      xml(
        `<ListBucketResult><Name>bucket</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
      ),
    );
  }

  private async complete(
    req: IncomingMessage,
    res: ServerResponse,
    bucket: string,
    key: string,
    uploadId: string,
    objects: Map<string, StoredObject>,
  ): Promise<void> {
    const upload = this.uploads.get(uploadId);
    if (!upload) return this.error(res, 404, "NoSuchUpload");
    const requested = [
      ...(await readBody(req)).toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g),
    ]
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);
    const parts = requested.map((n) => upload.parts.get(n));
    if (parts.length === 0 || parts.some((part) => !part))
      return this.error(res, 400, "InvalidPart");
    const body = Buffer.concat(parts as Buffer[]);
    objects.set(key, { body, contentType: "application/octet-stream", modified: new Date() });
    this.uploads.delete(uploadId);
    this.send(
      res,
      200,
      xml(
        `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${escapeXml(key)}</Key><ETag>${etagOf(body)}</ETag></CompleteMultipartUploadResult>`,
      ),
    );
  }

  private send(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { "Content-Type": "application/xml" }).end(body);
  }

  private error(res: ServerResponse, status: number, code: string): void {
    this.send(res, status, xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`));
  }
}

/**
 * Start the fake endpoint on a loopback HTTPS socket.
 *
 * @remarks
 * Native B2 calls (authorize, buckets, upload/download URLs) are served by the
 * SDK's public in-process {@link B2Simulator} through its documented transport.
 * S3-style paths are served by a tiny in-memory handler. The server certificate
 * is generated per run with the `openssl` CLI and never committed.
 */
export async function startFakeB2Endpoint(): Promise<FakeB2Endpoint> {
  const dir = mkdtempSync(join(tmpdir(), "b2-fake-endpoint-"));
  const keyPath = join(dir, "key.pem");
  const caCertPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
      ...["-keyout", keyPath, "-out", caCertPath, "-days", "2", "-subj", `/CN=${FAKE_HOST}`],
      ...["-addext", `subjectAltName=DNS:${FAKE_HOST}`],
    ],
    { stdio: "ignore" },
  );
  const simulator = new B2Simulator({ minimumPartSize: 1024, recommendedPartSize: 1024 });
  const transport = simulator.transport();
  const s3Requests: string[] = [];
  const s3 = new FakeS3(s3Requests);

  const server: Server = createServer(
    { key: readFileSync(keyPath), cert: readFileSync(caCertPath) },
    (req, res) => {
      const url = new URL(req.url ?? "/", `https://${req.headers.host}`);
      const native = url.pathname.startsWith("/b2api/") || url.pathname.startsWith("/file/");
      const handled = native ? serveNative(req, res, url) : s3.handle(req, res, url);
      handled.catch((err: unknown) => {
        res.writeHead(500).end(String(err));
      });
    },
  );

  async function serveNative(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[name] = value;
    }
    const response = await transport.send({
      method: (req.method ?? "GET") as "GET" | "HEAD" | "POST",
      url: url.href,
      headers,
      ...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}),
    });
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `https://${FAKE_HOST}:${port}`,
    caCertPath,
    simulator,
    s3Requests,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Write a deterministic file of `size` bytes, for large-object cases. */
export function writeFixtureFile(path: string, size: number): Buffer {
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;
  writeFileSync(path, data);
  return data;
}
