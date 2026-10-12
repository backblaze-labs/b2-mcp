// urls.s3_presign (yes). Run by ../run-conformance; see ../../README.md.
//
// s3_get_presigned_url, GetObject or PutObject, against what B2 documents for pre-signed URLs: the
// S3-compatible API supports them for downloading and uploading
// (https://www.backblaze.com/docs/cloud-storage-s3-compatible-api, "Pre-Signed URLs"), a URL is an
// AWS Signature V4 query string (X-Amz-Algorithm=AWS4-HMAC-SHA256, X-Amz-Credential, X-Amz-Expires,
// X-Amz-SignedHeaders, X-Amz-Signature) whose expiry defaults to 3,600 seconds, a plain `curl` of a
// GetObject URL returns the object, and uploads through a pre-signed URL are possible
// (https://www.backblaze.com/docs/cloud-storage-use-the-aws-cli-with-backblaze-b2); browser-based
// uploads by POST are not supported, so no presigned-POST tool may exist.
// Every URL is used from this process with no credential but the URL, as a client of its own, and
// what a PUT stored is read back through other tools (head, list versions, get object).
import {
  check,
  eq,
  newestVersionId,
  payload,
  put,
  readBytes,
  readWhole,
  runScenario,
  versionsOf,
  viaPresignedUrl,
} from "../lib/session.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

await runScenario("urls.s3_presign", async (s) => {
  s.step("boundary: presigned POST is not a tool");
  const { tools } = await s.client.listTools();
  eq(
    "tools named for a presigned POST",
    [],
    tools.map((t) => t.name).filter((name) => /presigned_post|post_policy/i.test(name)),
  );

  s.step("bucket and two versions of an object");
  const bucket = await s.bucket();
  const key = "st/presign/data.bin";
  const oldData = payload(70 * 1024 + 3, 131);
  const newData = payload(90 * 1024 + 5, 132);
  await put(s, bucket, key, oldData, { contentType: "application/x-sdkharness-old" });
  const oldVersion = await newestVersionId(s, bucket, key);
  await put(s, bucket, key, newData, { contentType: "application/x-sdkharness-new" });
  const newVersion = await newestVersionId(s, bucket, key);
  check(oldVersion !== newVersion, "the two uploads share one version id");

  s.step("GetObject: the URL is a SigV4 query string with the default expiry");
  const get = await s.call("s3_get_presigned_url", {
    bucket: bucket.name,
    key,
    operation: "GetObject",
  });
  eq("operation", "GetObject", get.operation);
  eq("expiresIn", 3600, get.expiresIn);
  const getUrl = new URL(get.url);
  eq("path", `/${bucket.name}/${key}`, getUrl.pathname);
  eq("algorithm", "AWS4-HMAC-SHA256", getUrl.searchParams.get("X-Amz-Algorithm"));
  eq("X-Amz-Expires defaults to 3600", "3600", getUrl.searchParams.get("X-Amz-Expires"));
  check(getUrl.searchParams.get("X-Amz-Credential"), "the URL names no credential");
  check(getUrl.searchParams.get("X-Amz-SignedHeaders"), "the URL names no signed headers");
  check(getUrl.searchParams.get("X-Amz-Signature"), "the URL carries no signature");
  check(
    Math.abs(Date.parse(get.expiresAt) - (Date.now() + 3600 * 1000)) < 120 * 1000,
    `expiresAt is not about an hour from now: ${get.expiresAt}`,
  );

  s.step("GetObject: a plain GET of the URL returns the newest version");
  const fetched = await viaPresignedUrl("GET", get.url);
  eq("GET status", 200, fetched.status);
  check(
    fetched.bytes.equals(newData),
    "the bytes behind the GetObject URL differ from the newest version",
  );
  eq(
    "content type of the newest version",
    "application/x-sdkharness-new",
    fetched.headers["content-type"],
  );

  s.step("GetObject: versionId picks the older version");
  const older = await s.call("s3_get_presigned_url", {
    bucket: bucket.name,
    key,
    operation: "GetObject",
    versionId: oldVersion,
  });
  const olderFetched = await viaPresignedUrl("GET", older.url);
  eq("GET status of the older version", 200, olderFetched.status);
  check(
    olderFetched.bytes.equals(oldData),
    "the URL for the older version did not return the older bytes",
  );
  eq(
    "content type of the older version",
    "application/x-sdkharness-old",
    olderFetched.headers["content-type"],
  );

  s.step("GetObject: an explicit expiry is the one in the URL");
  const timed = await s.call("s3_get_presigned_url", {
    bucket: bucket.name,
    key,
    operation: "GetObject",
    expiresIn: 600,
  });
  eq("X-Amz-Expires", "600", new URL(timed.url).searchParams.get("X-Amz-Expires"));
  eq("expiresIn", 600, timed.expiresIn);

  s.step("PutObject: the URL stores what is sent to it, larger than the inline limit");
  const bigKey = "st/presign/uploaded.bin";
  const big = payload(2 * 1024 * 1024 + 11, 133);
  const put1 = await s.call("s3_get_presigned_url", {
    bucket: bucket.name,
    key: bigKey,
    operation: "PutObject",
    contentType: "application/x-sdkharness-put",
    expiresIn: 900,
    confirm: true,
  });
  eq("operation", "PutObject", put1.operation);
  eq("PutObject X-Amz-Expires", "900", new URL(put1.url).searchParams.get("X-Amz-Expires"));
  eq("PutObject path", `/${bucket.name}/${bigKey}`, new URL(put1.url).pathname);
  const sent = await viaPresignedUrl("PUT", put1.url, big, {
    "content-type": "application/x-sdkharness-put",
  });
  eq("PUT status", 200, sent.status);

  s.step("PutObject: read back through other tools");
  const { versions } = await versionsOf(s, bucket, bigKey);
  eq("versions of the uploaded key", 1, versions.length);
  eq("listed size", big.length, versions[0].Size);
  const head = await s.call("s3_head_object", { bucket: bucket.name, key: bigKey });
  eq("contentLength", big.length, head.contentLength);
  eq("contentType", "application/x-sdkharness-put", head.contentType);
  check(
    (await readWhole(s, bucket, bigKey)).equals(big),
    "the stored bytes differ from the bytes PUT to the URL",
  );

  s.step("PutObject: a small object round trip, read inline");
  const smallKey = "st/presign/small.txt";
  const small = Buffer.from("through a presigned URL");
  const put2 = await s.call("s3_get_presigned_url", {
    bucket: bucket.name,
    key: smallKey,
    operation: "PutObject",
    contentType: "text/plain",
    confirm: true,
  });
  eq(
    "small PUT status",
    200,
    (await viaPresignedUrl("PUT", put2.url, small, { "content-type": "text/plain" })).status,
  );
  const inline = await readBytes(s, bucket, smallKey);
  check(inline.bytes.equals(small), "the small object's bytes differ");
  eq("small object contentType", "text/plain", inline.contentType);
  // A GET URL minted for the object just stored returns the same bytes to a client with no credential.
  const getSmall = await s.call("s3_get_presigned_url", {
    bucket: bucket.name,
    key: smallKey,
    operation: "GetObject",
  });
  check(
    (await viaPresignedUrl("GET", getSmall.url)).bytes.equals(small),
    "the GET URL of the small object returned other bytes",
  );

  s.step("an expired URL is refused and returns no bytes");
  const brief = await s.call("s3_get_presigned_url", {
    bucket: bucket.name,
    key,
    operation: "GetObject",
    expiresIn: 1,
  });
  eq("brief X-Amz-Expires", "1", new URL(brief.url).searchParams.get("X-Amz-Expires"));
  await sleep(2500);
  const expired = await viaPresignedUrl("GET", brief.url);
  check(expired.status >= 400, `an expired URL answered ${expired.status}`);
  check(!expired.bytes.equals(newData), "an expired URL still returned the object");

  s.step("the stored objects are untouched by the reads");
  eq(
    "versions of the first key",
    [newVersion, oldVersion],
    (await versionsOf(s, bucket, key)).versions.map((v) => v.VersionId),
  );
  check(
    (await readBytes(s, bucket, key)).bytes.equals(newData),
    "the first object's bytes changed",
  );
});
