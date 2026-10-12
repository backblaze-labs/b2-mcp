// large.compose_mixed (partial). Run by ../run-conformance; see ../../README.md.
//
// B2 documents that a large file is assembled from parts, each uploaded or copied from an existing
// file in any bucket of the same account, so one file can mix uploaded and copied parts:
// https://www.backblaze.com/docs/cloud-storage-large-files  (parts of 5 MB or more, but the last)
// https://www.backblaze.com/apidocs/s3-upload-part-copy  (a part copied from `x-amz-copy-source`)
// https://www.backblaze.com/apidocs/s3-upload-part https://www.backblaze.com/apidocs/s3-complete-multipart-upload
// real B2 measurement 2026-10-12: an upload part copy of a range past the end of the source is 400
// InvalidArgument 'Range specified is not valid for source object of size: <n>'; a copy of a whole
// small part works; a single small last part completes (only a non-last part under 5 MB is
// EntityTooSmall).
// The card's claim is `partial`: s3_upload_part_copy copies a byte range of a stored object into a
// part, new bytes use presigned part URLs, and there is no single compose tool. So this check builds
// one object from three parts the way an agent would: part 1 copied from an older version of a stored
// object in ANOTHER bucket, part 2 uploaded to a presigned URL, part 3 a range copied from the newest
// version; then it reads the assembled object back through other tools. The boundary (no tool
// composes in one call) is asserted from the server's tool list.
import {
  bareEtag,
  check,
  eq,
  md5Hex,
  newestVersionId,
  PART_SIZE,
  partsOf,
  payload,
  putParts,
  readWhole,
  runScenario,
  startUpload,
  uploadsOf,
  versionsOf,
  viaPresignedUrl,
} from "../lib/session.mjs";

/** Store bytes under a key with the presigned PutObject URL tool, as a caller with no credential would. */
async function putViaUrl(s, bucket, key, bytes) {
  const minted = await s.call("s3_get_presigned_url", {
    bucket: bucket.name,
    key,
    operation: "PutObject",
    contentType: "application/octet-stream",
    confirm: true,
  });
  const sent = await viaPresignedUrl("PUT", minted.url, bytes, {
    "content-type": "application/octet-stream",
  });
  eq(`presigned PUT of ${key}`, 200, sent.status);
}

await runScenario("large.compose_mixed", async (s) => {
  s.step("boundary: no tool composes in one call");
  const { tools } = await s.client.listTools();
  const names = tools.map((t) => t.name);
  eq(
    "tools named for composing",
    [],
    names.filter((name) => /compos|assembl|concat|merge/i.test(name)),
  );
  check(names.includes("s3_upload_part_copy"), "the tool s3_upload_part_copy is not exposed");

  s.step("buckets and two versions of a source object");
  const source = await s.bucket();
  const target = await s.bucket();
  const srcKey = "st/compose/source.bin";
  const srcOld = payload(PART_SIZE + 2000, 121);
  const srcNew = payload(PART_SIZE + 2000, 122);
  await putViaUrl(s, source, srcKey, srcOld);
  const oldVersion = await newestVersionId(s, source, srcKey);
  await putViaUrl(s, source, srcKey, srcNew);
  const newVersion = await newestVersionId(s, source, srcKey);
  check(oldVersion !== newVersion, "the two uploads share one version id");

  s.step("part 1 is copied from the older version, in the other bucket");
  const key = "st/compose/mixed.bin";
  const upload = await startUpload(s, target, key, { contentType: "application/x-sdkharness" });
  const copyOne = await s.call("s3_upload_part_copy", {
    bucket: target.name,
    key,
    uploadId: upload.uploadId,
    partNumber: 1,
    copySource: `${source.name}/${srcKey}`,
    copySourceVersionId: oldVersion,
    copySourceRange: `bytes=0-${PART_SIZE - 1}`,
  });
  eq("copied part number", 1, copyOne.partNumber);
  eq(
    "etag of a copied part is the MD5 of the copied range",
    md5Hex(srcOld.subarray(0, PART_SIZE)),
    bareEtag(copyOne.etag),
  );

  s.step("part 2 is new bytes, sent to a presigned part URL");
  const fresh = payload(PART_SIZE, 123);
  const [two] = await putParts(s, upload, { 2: fresh });

  s.step("part 3 is a range of the newest version (no version id given)");
  const tailRange = `bytes=${PART_SIZE}-${PART_SIZE + 999}`;
  const copyThree = await s.call("s3_upload_part_copy", {
    bucket: target.name,
    key,
    uploadId: upload.uploadId,
    partNumber: 3,
    copySource: `${source.name}/${srcKey}`,
    copySourceRange: tailRange,
  });
  eq(
    "etag of the tail copy is the MD5 of the newest version's range",
    md5Hex(srcNew.subarray(PART_SIZE, PART_SIZE + 1000)),
    bareEtag(copyThree.etag),
  );

  s.step("list parts shows the three parts, copied and uploaded alike");
  eq(
    "parts listed",
    [
      { n: 1, size: PART_SIZE, etag: bareEtag(copyOne.etag) },
      { n: 2, size: PART_SIZE, etag: bareEtag(two.etag) },
      { n: 3, size: 1000, etag: bareEtag(copyThree.etag) },
    ],
    (await partsOf(s, upload)).map((p) => ({
      n: p.PartNumber,
      size: p.Size,
      etag: bareEtag(p.ETag),
    })),
  );

  s.step("a range past the end of the source is refused (InvalidArgument)");
  // Real B2 measurement 2026-10-12. The source version is `srcNew`, PART_SIZE + 2000 bytes long, and
  // s3_upload_part_copy passes copySourceRange through as given, so a range ending past the end is expressible.
  const sourceSize = srcNew.length;
  const outOfRange = await s.refused("s3_upload_part_copy", {
    bucket: target.name,
    key,
    uploadId: upload.uploadId,
    partNumber: 4,
    copySource: `${source.name}/${srcKey}`,
    copySourceRange: `bytes=0-${sourceSize + 999}`,
  });
  check(
    outOfRange.includes(`Range specified is not valid for source object of size: ${sourceSize}`),
    `the out-of-range copy was refused for another reason: ${outOfRange.slice(0, 200)}`,
  );
  eq(
    "the refused copy leaves the parts as they were",
    [1, 2, 3],
    (await partsOf(s, upload)).map((p) => p.PartNumber),
  );

  s.step("complete");
  await s.call("s3_complete_multipart_upload", {
    bucket: target.name,
    key,
    uploadId: upload.uploadId,
    parts: [
      { partNumber: 1, etag: copyOne.etag },
      { partNumber: 2, etag: two.etag },
      { partNumber: 3, etag: copyThree.etag },
    ],
  });
  upload.finished = true;
  eq("uploads left", [], await uploadsOf(s, target));

  s.step("the assembled object");
  const expected = Buffer.concat([
    srcOld.subarray(0, PART_SIZE),
    fresh,
    srcNew.subarray(PART_SIZE, PART_SIZE + 1000),
  ]);
  const { versions } = await versionsOf(s, target, key);
  eq("versions of the key", 1, versions.length);
  eq("listed size", expected.length, versions[0].Size);
  const head = await s.call("s3_head_object", { bucket: target.name, key });
  eq("contentLength", expected.length, head.contentLength);
  eq("contentType", "application/x-sdkharness", head.contentType);
  check(
    (await readWhole(s, target, key)).equals(expected),
    "the assembled bytes differ from the copied and uploaded parts",
  );

  s.step("the sources are unchanged");
  eq(
    "versions of the source",
    [newVersion, oldVersion],
    (await versionsOf(s, source, srcKey)).versions.map((v) => v.VersionId),
  );
  check(
    (await readWhole(s, source, srcKey, { versionId: oldVersion })).equals(srcOld),
    "the older source version changed",
  );
});
