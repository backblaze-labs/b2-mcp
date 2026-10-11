// files.server_side_copy (yes). Run by ../run-conformance; see ../../README.md.
//
// s3_copy_object against what B2's S3 CopyObject documents: the destination is a new object with the
// source's bytes, size and content type, and the source's custom metadata when the directive is COPY
// (the S3 default); with REPLACE the metadata and content type given in the request are the ones
// stored instead; x-amz-copy-source-version-id picks which version of the source is copied; the
// destination gets a version id of its own; the source is read, never changed.
// https://www.backblaze.com/apidocs/s3-copy-object
// A source that does not exist is refused and creates nothing (the S3 NoSuchKey answer).
// `src_last_modified_millis` is metadata B2's S3 layer adds to every stored object (it differs between
// source and copy), so it is left out of the metadata comparisons.
import {
  check,
  eq,
  newestVersionId,
  payload,
  put,
  readBytes,
  runScenario,
  userMetadata,
  versionsOf,
} from "../lib/session.mjs";

await runScenario("files.server_side_copy", async (s) => {
  s.step("bucket");
  const bucket = await s.bucket();
  const other = await s.bucket();

  s.step("upload the source");
  const key = "st/copy/source.txt";
  const data = payload(3000, 70);
  const metadata = { origin: "sdkharness", team: "b2" };
  await put(s, bucket, key, data, { contentType: "text/plain", metadata });
  const sourceVersion = await newestVersionId(s, bucket, key);
  const sourceHead = await s.call("s3_head_object", { bucket: bucket.name, key });
  eq("source metadata", metadata, userMetadata(sourceHead.metadata));

  s.step("copy, default directive (COPY), same bucket");
  await s.call("s3_copy_object", {
    sourceBucket: bucket.name,
    sourceKey: key,
    destinationBucket: bucket.name,
    destinationKey: "st/copy/same-bucket.txt",
  });
  const same = await readBytes(s, bucket, "st/copy/same-bucket.txt");
  check(same.bytes.equals(data), "the copy's bytes differ from the source's");
  eq("copy contentLength", data.length, same.contentLength);
  eq("copy contentType", "text/plain", same.contentType);
  eq("copy metadata", metadata, userMetadata(same.metadata));
  const sameHead = await s.call("s3_head_object", {
    bucket: bucket.name,
    key: "st/copy/same-bucket.txt",
  });
  check(
    sameHead.versionId && sameHead.versionId !== sourceVersion,
    "the copy has no version id of its own",
  );
  eq("copy size by head", data.length, sameHead.contentLength);

  s.step("copy into another bucket");
  await s.call("s3_copy_object", {
    sourceBucket: bucket.name,
    sourceKey: key,
    destinationBucket: other.name,
    destinationKey: "st/copy/other-bucket.txt",
  });
  const across = await readBytes(s, other, "st/copy/other-bucket.txt");
  check(across.bytes.equals(data), "the cross-bucket copy's bytes differ from the source's");
  eq("cross-bucket copy metadata", metadata, userMetadata(across.metadata));
  eq(
    "the other bucket lists only the copy",
    ["st/copy/other-bucket.txt"],
    (await s.call("s3_list_objects_v2", { bucket: other.name })).objects.map((o) => o.Key),
  );

  s.step("copy, REPLACE directive");
  await s.call("s3_copy_object", {
    sourceBucket: bucket.name,
    sourceKey: key,
    destinationBucket: bucket.name,
    destinationKey: "st/copy/replaced.txt",
    metadataDirective: "REPLACE",
    contentType: "text/csv",
    metadata: { replaced: "yes" },
  });
  const replaced = await readBytes(s, bucket, "st/copy/replaced.txt");
  check(replaced.bytes.equals(data), "the REPLACE copy's bytes differ from the source's");
  eq("REPLACE contentType", "text/csv", replaced.contentType);
  eq("REPLACE metadata is the new set only", { replaced: "yes" }, userMetadata(replaced.metadata));

  s.step("copy a chosen version of the source");
  const newer = payload(1500, 71);
  await put(s, bucket, key, newer, { contentType: "text/plain", metadata });
  check(
    (await newestVersionId(s, bucket, key)) !== sourceVersion,
    "the second upload did not make a new version",
  );
  await s.call("s3_copy_object", {
    sourceBucket: bucket.name,
    sourceKey: key,
    sourceVersionId: sourceVersion,
    destinationBucket: bucket.name,
    destinationKey: "st/copy/old-version.txt",
  });
  const old = await readBytes(s, bucket, "st/copy/old-version.txt");
  check(old.bytes.equals(data), "copying sourceVersionId did not copy that version's bytes");
  await s.call("s3_copy_object", {
    sourceBucket: bucket.name,
    sourceKey: key,
    destinationBucket: bucket.name,
    destinationKey: "st/copy/newest.txt",
  });
  const latest = await readBytes(s, bucket, "st/copy/newest.txt");
  check(latest.bytes.equals(newer), "copying with no version did not copy the newest version");

  s.step("the source is untouched");
  const { versions } = await versionsOf(s, bucket, key);
  eq("source versions", 2, versions.filter((v) => v.Key === key).length);
  const oldRead = await readBytes(s, bucket, key, { versionId: sourceVersion });
  check(oldRead.bytes.equals(data), "the source's first version changed after the copies");
  eq("source metadata after the copies", metadata, userMetadata(oldRead.metadata));
  eq("source contentType after the copies", "text/plain", oldRead.contentType);

  s.step("a missing source is refused and creates nothing");
  const refused = await s.refused("s3_copy_object", {
    sourceBucket: bucket.name,
    sourceKey: "st/copy/not-there.txt",
    destinationBucket: bucket.name,
    destinationKey: "st/copy/from-nothing.txt",
  });
  check(
    /404|NoSuchKey|not.?found/i.test(refused),
    `a missing source was not a not-found answer: ${refused.slice(0, 160)}`,
  );
  const stored = (
    await s.call("s3_list_objects_v2", { bucket: bucket.name, prefix: "st/copy/" })
  ).objects.map((o) => o.Key);
  check(
    !stored.includes("st/copy/from-nothing.txt"),
    "a copy from a missing source created an object",
  );
});
