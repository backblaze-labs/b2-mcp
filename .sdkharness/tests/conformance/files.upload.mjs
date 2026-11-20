// files.upload (partial). Run by ../run-conformance; see ../../README.md.
//
// Upload through s3_put_object, then check what B2 documents for a stored object: the bytes read
// back are the bytes sent, a HEAD reports the size, content type and custom metadata sent (S3
// metadata names are case-insensitive and come back lower-cased), the object is listed, an empty
// object and an unusual key are stored as sent. https://www.backblaze.com/apidocs/s3-put-object
// https://www.backblaze.com/apidocs/s3-head-object https://www.backblaze.com/apidocs/s3-get-object
//
// real B2 measurement 2026-10-12: an object stored with no content type at all is reported as
// `binary/octet-stream` (not `application/octet-stream`). s3_put_object always signs a content type,
// so this check sends an explicit one everywhere and asserts only that; the default is not asserted.
//
// The cell is `partial`, and the boundary is asserted: s3_put_object carries one object only up to
// 1 MiB (tool contract, docs/design-docs/tool-contract.md; the card's `src/s3/objects.ts:836,770`).
// Over that it must refuse, and store nothing; bigger data goes by a presigned PutObject URL: the
// object is PUT to it from this process, with no credential but the URL, and stored as sent (S3
// PutObject, the same page; B2 supports uploads to pre-signed URLs made by an S3 SDK:
// https://www.backblaze.com/docs/cloud-storage-use-the-aws-cli-with-backblaze-b2).
import {
  b64,
  check,
  eq,
  payload,
  put,
  readBytes,
  readWhole,
  runScenario,
  versionsOf,
  viaPresignedUrl,
} from "../lib/session.mjs";

const MIB = 1024 * 1024;

await runScenario("files.upload", async (s) => {
  s.step("bucket");
  const bucket = await s.bucket();

  s.step("upload");
  const key = "st/upload/data.bin";
  const data = payload(64 * 1024 + 17, 1);
  await put(s, bucket, key, data, {
    contentType: "application/x-sdkharness",
    metadata: { "Sdkharness-Key": "sdkharness-value" },
  });

  s.step("listed");
  const { versions } = await versionsOf(s, bucket, key);
  eq("versions of the key", 1, versions.length);
  eq("listed size", data.length, versions[0].Size);

  s.step("head");
  const head = await s.call("s3_head_object", { bucket: bucket.name, key });
  eq("contentLength", data.length, head.contentLength);
  eq("contentType", "application/x-sdkharness", head.contentType);
  eq("custom metadata", "sdkharness-value", head.metadata?.["sdkharness-key"]);
  eq("head versionId is the listed version", versions[0].VersionId, head.versionId);

  s.step("download");
  const got = await readBytes(s, bucket, key);
  check(got.bytes.equals(data), "downloaded bytes differ from the uploaded bytes");

  s.step("unusual key");
  const odd = "st/upload/sp ace/ünï+cöde.txt";
  const oddData = Buffer.from("unusual key");
  await put(s, bucket, odd, oddData, { contentType: "text/plain" });
  const oddGot = await readBytes(s, bucket, odd);
  check(oddGot.bytes.equals(oddData), "bytes of the unusually named object differ");
  eq("unusual key name", odd, oddGot.key);

  s.step("boundary: inline over 1 MiB is refused");
  const over = payload(MIB + 1, 2);
  await s.refused("s3_put_object", {
    bucket: bucket.name,
    key: "st/upload/over.bin",
    content: b64(over),
    contentType: "application/octet-stream",
  });
  eq(
    "versions of the refused key",
    0,
    (await versionsOf(s, bucket, "st/upload/over.bin")).versions.length,
  );

  s.step("boundary: a presigned PutObject URL is minted for the bigger object");
  const presigned = await s.call("s3_get_presigned_url", {
    bucket: bucket.name,
    key: "st/upload/over.bin",
    operation: "PutObject",
    contentType: "application/octet-stream",
    confirm: true,
  });
  const url = new URL(presigned.url);
  eq("presigned operation", "PutObject", presigned.operation);
  eq("presigned path", `/${bucket.name}/st/upload/over.bin`, url.pathname);
  eq("presigned algorithm", "AWS4-HMAC-SHA256", url.searchParams.get("X-Amz-Algorithm"));
  check(url.searchParams.has("X-Amz-Signature"), "the presigned URL carries no signature");

  s.step("boundary: the bigger object goes through the presigned URL");
  // The bytes travel from this process to the URL, not through the server (a client of its own,
  // sending the one signed content-type header and no credential), and are read back by other tools.
  const sent = await viaPresignedUrl("PUT", presigned.url, over, {
    "content-type": "application/octet-stream",
  });
  eq("presigned PUT status", 200, sent.status);
  const overVersions = (await versionsOf(s, bucket, "st/upload/over.bin")).versions;
  eq("versions of the presigned key", 1, overVersions.length);
  eq("listed size of the presigned object", over.length, overVersions[0].Size);
  const overHead = await s.call("s3_head_object", {
    bucket: bucket.name,
    key: "st/upload/over.bin",
  });
  eq("presigned object contentLength", over.length, overHead.contentLength);
  eq("presigned object contentType", "application/octet-stream", overHead.contentType);
  check(
    (await readWhole(s, bucket, "st/upload/over.bin")).equals(over),
    "the bytes read back from the presigned upload differ from the bytes sent",
  );

  // Last, so the legs above still run: B2 stores a zero-byte object (S3 PutObject with an empty body).
  s.step("empty object");
  await put(s, bucket, "st/upload/empty.bin", Buffer.alloc(0));
  const empty = await s.call("s3_head_object", { bucket: bucket.name, key: "st/upload/empty.bin" });
  eq("empty contentLength", 0, empty.contentLength);
});
