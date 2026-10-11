// files.download_content (yes). Run by ../run-conformance; see ../../README.md.
//
// Download an object by key through s3_get_object: GetObject "retrieves an object" by bucket and
// key, so the bytes are the bytes stored, the content type and length are the stored ones, a
// Range returns exactly that slice, and a key that does not exist is a 404 (NoSuchKey).
// https://www.backblaze.com/apidocs/s3-get-object
// Range is a supported GetObject header: https://www.backblaze.com/docs/cloud-storage-s3-compatible-api
// The card's claim is that `saveToPath` streams the object to disk, so that is checked too.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, eq, payload, put, readBytes, runScenario } from "../lib/session.mjs";

await runScenario("files.download_content", async (s) => {
  s.step("bucket");
  const bucket = await s.bucket();

  s.step("upload");
  const key = "st/download/data.bin";
  const data = payload(300 * 1024 + 5, 3);
  await put(s, bucket, key, data, { contentType: "application/x-sdkharness" });

  s.step("download whole");
  const got = await readBytes(s, bucket, key);
  check(got.bytes.equals(data), "downloaded bytes differ from the stored bytes");
  eq("contentLength", data.length, got.contentLength);
  eq("contentType", "application/x-sdkharness", got.contentType);

  s.step("range");
  const slice = await readBytes(s, bucket, key, { range: "bytes=1000-1999" });
  eq("range length", 1000, slice.bytes.length);
  check(slice.bytes.equals(data.subarray(1000, 2000)), "the ranged bytes are not bytes 1000-1999");
  const tail = await readBytes(s, bucket, key, { range: `bytes=${data.length - 10}-` });
  check(tail.bytes.equals(data.subarray(data.length - 10)), "an open-ended range is not the tail");

  s.step("save to a path");
  const dir = mkdtempSync(join(tmpdir(), "sdkharness-download-"));
  try {
    const path = join(dir, "saved.bin");
    await s.call("s3_get_object", { bucket: bucket.name, key, saveToPath: path });
    check(readFileSync(path).equals(data), "the file saved to disk differs from the stored bytes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  s.step("a missing key is a 404");
  const refused = await s.refused("s3_get_object", {
    bucket: bucket.name,
    key: "st/download/missing",
  });
  check(/HTTP 404/.test(refused), `a missing key did not read as 404: ${refused.slice(0, 120)}`);
});
