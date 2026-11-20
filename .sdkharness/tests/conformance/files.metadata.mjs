// files.metadata (yes). Run by ../run-conformance; see ../../README.md.
//
// s3_head_object is S3 HeadObject: "retrieves metadata from an object without returning the object
// itself". It reports the stored size and content type, the custom metadata sent at upload (S3
// metadata names are case-insensitive and come back lower-cased), the version id the listing shows,
// can address an older version, and a key with nothing under it is a 404.
// https://www.backblaze.com/apidocs/s3-head-object
// https://www.backblaze.com/apidocs/s3-list-object-versions
import { check, eq, payload, put, runScenario, versionsOf } from "../lib/session.mjs";

await runScenario("files.metadata", async (s) => {
  s.step("bucket");
  const bucket = await s.bucket();

  s.step("upload two versions");
  const key = "st/metadata/object.bin";
  const first = payload(1500, 6);
  const second = payload(2500, 7);
  await put(s, bucket, key, first, {
    contentType: "application/x-first",
    metadata: { Owner: "first", "Sdkharness-Key": "one" },
  });
  await put(s, bucket, key, second, {
    contentType: "application/x-second",
    metadata: { Owner: "second" },
  });
  const { versions } = await versionsOf(s, bucket, key);
  eq("versions of the key", 2, versions.length);
  const [newest, oldest] = versions;

  s.step("head the current version");
  const head = await s.call("s3_head_object", { bucket: bucket.name, key });
  eq("contentLength", second.length, head.contentLength);
  eq("contentType", "application/x-second", head.contentType);
  eq("custom metadata", "second", head.metadata?.owner);
  eq("a key the second upload did not send", undefined, head.metadata?.["sdkharness-key"]);
  eq("versionId is the newest listed", newest.VersionId, head.versionId);
  check(/^"[0-9a-f]+"$/.test(head.etag ?? ""), `etag is not a quoted hex string: ${head.etag}`);
  check(
    !Number.isNaN(Date.parse(head.lastModified)),
    `lastModified is not a date: ${head.lastModified}`,
  );

  s.step("head an older version");
  const old = await s.call("s3_head_object", {
    bucket: bucket.name,
    key,
    versionId: oldest.VersionId,
  });
  eq("older contentLength", first.length, old.contentLength);
  eq("older contentType", "application/x-first", old.contentType);
  eq("older custom metadata", "first", old.metadata?.owner);
  eq("older custom metadata, second key", "one", old.metadata?.["sdkharness-key"]);
  eq("older versionId", oldest.VersionId, old.versionId);

  s.step("a key with nothing under it is a 404");
  const refused = await s.refused("s3_head_object", {
    bucket: bucket.name,
    key: "st/metadata/missing",
  });
  check(/HTTP 404/.test(refused), `a missing key did not read as 404: ${refused.slice(0, 120)}`);
});
