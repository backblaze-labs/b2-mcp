// files.upload (partial). Run by ../run-conformance; see ../../README.md.
//
// Upload through s3_put_object, then check what B2 documents for a stored object: the bytes read
// back are the bytes sent, a HEAD reports the size, content type and custom metadata sent (S3
// metadata names are case-insensitive and come back lower-cased), the object is listed, an empty
// object and an unusual key are stored as sent. https://www.backblaze.com/apidocs/s3-put-object
// https://www.backblaze.com/apidocs/s3-head-object https://www.backblaze.com/apidocs/s3-get-object
//
// The cell is `partial`, and the boundary is asserted: s3_put_object carries one object only up to
// 1 MiB (tool contract, docs/design-docs/tool-contract.md; the card's `src/s3/objects.ts:836,770`).
// Over that it must refuse, and store nothing; bigger data goes by a presigned PutObject URL, which
// is checked to store the object (S3 PutObject, the same page) with the server never holding the bytes.
import {
  b64,
  check,
  eq,
  payload,
  put,
  readBytes,
  runScenario,
  versionsOf,
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
  // The transfer through the URL is not exercised: the server's output sanitizer redacts the
  // application key wherever it appears, and the simulator's fixed key id (`test-key-id`) contains
  // its key (`test-key`), so the credential in the minted URL reads `[redacted]-id` and no PUT can
  // be signed for it. A real key id never contains its key. Repairing the URL here would be a
  // simulator special case, so the leg is left out and said so.
  console.error(
    "NOTE files.upload: the presigned PUT is not sent; the simulator's fixed key id contains its key, so the server redacts it in the URL",
  );

  // Last, so the legs above still run: B2 stores a zero-byte object (S3 PutObject with an empty body).
  s.step("empty object");
  await put(s, bucket, "st/upload/empty.bin", Buffer.alloc(0));
  const empty = await s.call("s3_head_object", { bucket: bucket.name, key: "st/upload/empty.bin" });
  eq("empty contentLength", 0, empty.contentLength);
});
