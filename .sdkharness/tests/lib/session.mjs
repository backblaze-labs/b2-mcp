// Shared plumbing for the sdkharness checks: the built stdio server driven over MCP as a client
// would, the one result line, and the helpers the conformance scenarios share.
// See ../../README.md. Run by ../run-health and ../run-conformance.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Start the built server (dist/index.js) and connect an MCP client to it over stdio. */
export async function startServer(clientName, extraEnv = {}) {
  // Only the simulator's fixed test credential and the test-only endpoint reach the server. The key
  // id must not contain the key: the server redacts the key wherever it appears, in a presigned URL too.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--require",
      join(ROOT, "test-support/loopback-dns-preload.cjs"),
      join(ROOT, "dist/index.js"),
    ],
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test",
      NODE_EXTRA_CA_CERTS: process.env.SDKHARNESS_SIMULATOR_CA,
      B2_TEST_REALM: process.env.SDKHARNESS_REALM,
      B2_TEST_LOOPBACK_HOST: process.env.SDKHARNESS_FIXTURE_HOST,
      B2_APPLICATION_KEY_ID: "sim-test-id",
      B2_APPLICATION_KEY: "sim-test-secret",
      B2_REGION: "us-west-004",
      B2_SECRET_SINK: "off",
      ...extraEnv,
    },
    stderr: "inherit",
  });
  const client = new Client({ name: clientName, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Call a tool; a tool error throws with the server's text, a JSON body is parsed. */
export async function call(client, name, args) {
  const out = await client.callTool({ name, arguments: args });
  const text = out.content.map((part) => part.text ?? "").join("");
  if (out.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/** Call a tool that must be refused; returns the error text (what the caller would read). */
export async function callRefused(client, name, args) {
  const out = await client.callTool({ name, arguments: args });
  const text = out.content.map((part) => part.text ?? "").join("");
  if (!out.isError) throw new Error(`${name} was accepted; the call must be refused`);
  return text;
}

/**
 * Run one conformance scenario and print the one result line. Every bucket made through
 * `s.bucket()` is emptied and deleted afterwards, on failure too. `options.env` adds to the
 * server's environment (a scenario that needs a setting the default lacks says why, in its file).
 * `s.cleanup(fn)` registers a step that runs before the buckets are removed (for example to lift
 * a legal hold, which blocks a delete); it runs on failure too and its own failure is a NOTE.
 */
export async function runScenario(id, scenario, options = {}) {
  const result = (outcome, reason) =>
    console.log(`SDKHARNESS_RESULT\tconformance\t${id}\t${outcome}\t${reason}`);
  const s = { current: "start", buckets: [], cleanups: [] };
  let client;
  try {
    client = await startServer(`sdkharness-conformance-${id}`, options.env);
    s.client = client;
    s.step = (name) => {
      s.current = name;
    };
    s.call = (name, args) => call(client, name, args);
    s.refused = (name, args) => callRefused(client, name, args);
    s.cleanup = (fn) => {
      s.cleanups.push(fn);
    };
    s.forget = (bucket) => {
      s.buckets.splice(s.buckets.indexOf(bucket), 1);
    };
    s.bucket = async (options = {}) => {
      const name = `sdkharness-conf-${randomBytes(5).toString("hex")}`;
      const created = await call(client, "b2_create_bucket", {
        bucketName: name,
        bucketType: "allPrivate",
        ...options,
      });
      const bucket = { name, id: created.bucketId, created };
      s.buckets.push(bucket);
      return bucket;
    };
    await scenario(s);
    result("PASS", "-");
  } catch (error) {
    const why = String(error?.message ?? error).replace(/\s+/g, " ");
    result("FAIL", `${s.current} -- ${why.slice(0, 300)}`);
    process.exitCode = 1;
  } finally {
    if (client) {
      for (const fn of s.cleanups.reverse()) {
        await fn().catch((error) =>
          console.error(`NOTE cleanup step failed: ${String(error?.message ?? error)}`),
        );
      }
      for (const bucket of s.buckets) await removeBucket(client, bucket);
      await client.close().catch(() => undefined);
    }
  }
}

// Best effort: the simulator is discarded with the run, so a leftover is a NOTE, not a verdict.
async function removeBucket(client, bucket) {
  try {
    let page = {};
    do {
      page = await call(client, "s3_list_object_versions", { bucket: bucket.name, ...page });
      for (const v of [...(page.versions ?? []), ...(page.deleteMarkers ?? [])]) {
        // A governance-retained version needs the bypass; one that is not retained ignores it.
        const out = await call(client, "s3_delete_objects", {
          bucket: bucket.name,
          objects: [{ key: v.Key, versionId: v.VersionId }],
          bypassGovernance: true,
          quiet: false,
          confirm: true,
        });
        if (out.errors?.length) throw new Error(JSON.stringify(out.errors[0]));
      }
      page = page.isTruncated
        ? { keyMarker: page.nextKeyMarker, versionIdMarker: page.nextVersionIdMarker }
        : null;
    } while (page);
    await call(client, "b2_delete_bucket", { bucketId: bucket.id, confirm: true });
  } catch (error) {
    console.error(`NOTE cleanup of ${bucket.name} failed: ${String(error?.message ?? error)}`);
  }
}

// ---- assertions ---------------------------------------------------------------------------

export function check(condition, message) {
  if (!condition) throw new Error(message);
}

export function eq(what, expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---- data -----------------------------------------------------------------------------------

/** Deterministic, incompressible-looking bytes: a different seed gives different content. */
export function payload(length, seed) {
  const out = Buffer.alloc(length);
  let block = createHash("sha256").update(`sdkharness-${seed}`).digest();
  for (let i = 0; i < length; i += block.length) {
    block.copy(out, i, 0, Math.min(block.length, length - i));
    block = createHash("sha256").update(block).digest();
  }
  return out;
}

export const b64 = (bytes) => Buffer.from(bytes).toString("base64");
export const unb64 = (text) => Buffer.from(text, "base64");

// ---- object helpers (the s3_* tools) ------------------------------------------------------

/** Upload through s3_put_object (it signs a content type, so one is always sent). */
export async function put(s, bucket, key, bytes, options = {}) {
  await s.call("s3_put_object", {
    bucket: bucket.name,
    key,
    content: b64(bytes),
    contentType: options.contentType ?? "application/octet-stream",
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}

/** Every version and delete marker under a prefix, newest first per key, across pages. */
export async function versionsOf(s, bucket, prefix) {
  const versions = [];
  const markers = [];
  let page = {};
  do {
    const out = await s.call("s3_list_object_versions", {
      bucket: bucket.name,
      ...(prefix ? { prefix } : {}),
      ...page,
    });
    versions.push(...(out.versions ?? []));
    markers.push(...(out.deleteMarkers ?? []));
    page = out.isTruncated
      ? { keyMarker: out.nextKeyMarker, versionIdMarker: out.nextVersionIdMarker }
      : null;
  } while (page);
  return { versions, markers };
}

/** A fresh listing of one bucket through b2_list_buckets, as the caller would read its settings. */
export async function bucketInfo(s, bucket) {
  const out = await s.call("b2_list_buckets", { bucketName: bucket.name });
  eq(
    "buckets listed by name",
    [bucket.id],
    out.buckets.map((b) => b.bucketId),
  );
  return out.buckets[0];
}

/** The version id (which is also the native file id) of the newest version of a key. */
export async function newestVersionId(s, bucket, key) {
  const { versions } = await versionsOf(s, bucket, key);
  const mine = versions.filter((v) => v.Key === key);
  check(mine.length > 0, `no version of ${key} is stored`);
  return mine[0].VersionId;
}

/** Custom metadata without `src_last_modified_millis`, which B2's S3 layer adds to every upload. */
export function userMetadata(metadata) {
  const { src_last_modified_millis: _mtime, ...rest } = metadata ?? {};
  return rest;
}

/** Read an object inline and return the decoded bytes. */
export async function readBytes(s, bucket, key, extra = {}) {
  const out = await s.call("s3_get_object", { bucket: bucket.name, key, ...extra });
  return { ...out, bytes: unb64(out.content ?? "") };
}

// ---- a presigned URL, as a caller outside the server would use it ---------------------------

/**
 * PUT or GET a presigned URL from this process. The URL names the simulator's fixture host,
 * which only the server process resolves; here the connection goes to the loopback listener
 * directly and trusts only the simulator's own certificate.
 */
export function viaPresignedUrl(method, url, body, headers = {}) {
  const target = new URL(url);
  const loopback = new URL(process.env.SDKHARNESS_SIMULATOR_HTTPS_URL);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        ca: readFileSync(process.env.SDKHARNESS_SIMULATOR_CA),
        lookup: (_host, options, done) =>
          options?.all
            ? done(null, [{ address: loopback.hostname, family: 4 }])
            : done(null, loopback.hostname, 4),
        headers: body ? { "content-length": body.length, ...headers } : headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, bytes: Buffer.concat(chunks), headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// ---- multipart upload helpers (the s3_*multipart* tools and presigned part URLs) ------------

/** B2's minimum size of every part but the last is 5 MB; the tool contract says 5 MiB. */
export const PART_SIZE = 5 * 1024 * 1024;

/** An ETag as a header or a listing shows it, with or without its quotes. */
export const bareEtag = (etag) => String(etag ?? "").replace(/^"|"$/g, "");

export const md5Hex = (bytes) => createHash("md5").update(bytes).digest("hex");

/**
 * Start a multipart upload through s3_create_multipart_upload. It is aborted at cleanup unless the
 * scenario finished or aborted it (set `upload.finished = true`), so no unfinished upload is left
 * to block the bucket's removal.
 */
export async function startUpload(s, bucket, key, options = {}) {
  const out = await s.call("s3_create_multipart_upload", { bucket: bucket.name, key, ...options });
  const upload = {
    bucket: bucket.name,
    key,
    uploadId: out.uploadId,
    created: out,
    finished: false,
  };
  s.cleanup(async () => {
    if (upload.finished) return;
    await s.call("s3_abort_multipart_upload", {
      bucket: bucket.name,
      key,
      uploadId: upload.uploadId,
      confirm: true,
    });
  });
  return upload;
}

/**
 * Mint presigned part URLs for the given part numbers (one s3_get_presigned_upload_part_url call),
 * then PUT each part's bytes to its own URL from this process, as a client outside the server
 * would. `bytesByNumber` maps a part number to its bytes. Returns `{ partNumber, etag }` per part,
 * the ETag read from the PUT response header.
 */
export async function putParts(s, upload, bytesByNumber) {
  const numbers = Object.keys(bytesByNumber).map(Number);
  const minted = await s.call("s3_get_presigned_upload_part_url", {
    bucket: upload.bucket,
    key: upload.key,
    uploadId: upload.uploadId,
    partNumbers: numbers,
  });
  eq(
    "presigned part numbers",
    numbers,
    minted.parts.map((p) => p.partNumber),
  );
  const done = [];
  for (const part of minted.parts) {
    const sent = await viaPresignedUrl("PUT", part.url, bytesByNumber[part.partNumber]);
    eq(`PUT of part ${part.partNumber}`, 200, sent.status);
    check(sent.headers.etag, `the PUT of part ${part.partNumber} returned no ETag header`);
    done.push({ partNumber: part.partNumber, etag: sent.headers.etag });
  }
  return done;
}

/** Every part s3_list_parts reports for an upload, across pages. */
export async function partsOf(s, upload) {
  const parts = [];
  let marker;
  do {
    const out = await s.call("s3_list_parts", {
      bucket: upload.bucket,
      key: upload.key,
      uploadId: upload.uploadId,
      ...(marker === undefined ? {} : { partNumberMarker: marker }),
    });
    parts.push(...out.parts);
    marker = out.isTruncated ? Number(out.nextPartNumberMarker) : undefined;
  } while (marker !== undefined);
  return parts;
}

/** The in-progress uploads s3_list_multipart_uploads reports for a bucket, optionally by prefix. */
export async function uploadsOf(s, bucket, prefix) {
  const out = await s.call("s3_list_multipart_uploads", {
    bucket: bucket.name,
    ...(prefix ? { prefix } : {}),
  });
  return out.uploads;
}

/**
 * Save a whole stored object to a temporary file through s3_get_object (the only way it reads more
 * than 1 MiB), return its bytes and remove the file.
 */
export async function readWhole(s, bucket, key, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sdkharness-whole-"));
  try {
    const path = join(dir, "saved.bin");
    await s.call("s3_get_object", { bucket: bucket.name, key, saveToPath: path, ...extra });
    return readFileSync(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
