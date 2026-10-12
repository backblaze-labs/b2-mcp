// large.multipart (yes). Run by ../run-conformance; see ../../README.md.
//
// The multipart tools against what B2's S3-compatible API documents: create returns an UploadId and
// the upload is listed as in progress until it is completed or aborted; each part goes to its own
// presigned URL, from this process (the server never holds the bytes), and B2 answers with the part's
// ETag (the MD5 of its bytes, as in the S3 Upload Part example: 11 bytes `object data` have the ETag
// 85f30635602dc09bd85957a6e82a2c21); list parts reports what was uploaded, by part number, with its
// size, and pages by max-parts and part-number-marker; complete assembles the object from the parts
// and their ETags (the ETag of the result ends in `-<number of parts>`); abort discards an upload.
// https://www.backblaze.com/apidocs/s3-create-multipart-upload
// https://www.backblaze.com/apidocs/s3-upload-part https://www.backblaze.com/apidocs/s3-list-parts
// https://www.backblaze.com/apidocs/s3-list-multipart-uploads
// https://www.backblaze.com/apidocs/s3-complete-multipart-upload
// https://www.backblaze.com/apidocs/s3-abort-multipart-upload
// Every part but the last must be at least 5 MB (every part of this check is 5 MiB, the tool's own
// minimum, except the last), the last at least one byte:
// https://www.backblaze.com/docs/cloud-storage-large-files
// real B2 measurement 2026-10-12 (the Backblaze docs above do not say these; the answers of real B2 do):
// while an upload is open, ListObjectVersions is empty and ListObjectsV2 has KeyCount 0 (the upload
// shows only in ListMultipartUploads and ListParts); a complete of three parts gives an ETag ending
// -3; a complete with a non-last part under 5 MB is 400 EntityTooSmall; after an abort, ListParts is
// 404 NoSuchUpload.
// The effects are read back through other tools than the ones that set them: list uploads, list
// parts, head, list versions, and s3_get_object (a range, and the whole object saved to disk).
import {
  bareEtag,
  check,
  eq,
  md5Hex,
  PART_SIZE,
  partsOf,
  payload,
  putParts,
  readBytes,
  readWhole,
  runScenario,
  startUpload,
  uploadsOf,
  versionsOf,
} from "../lib/session.mjs";

await runScenario("large.multipart", async (s) => {
  s.step("bucket");
  const bucket = await s.bucket();

  s.step("create");
  const key = "st/large/assembled.bin";
  const upload = await startUpload(s, bucket, key, {
    contentType: "application/x-sdkharness",
    metadata: { "Sdkharness-Key": "sdkharness-value" },
  });
  check(upload.uploadId, "no UploadId was returned");
  eq("created bucket", bucket.name, upload.created.bucket);
  eq("created key", key, upload.created.key);

  s.step("listed as in progress");
  const other = await startUpload(s, bucket, "st/other/unrelated.bin");
  const listed = await uploadsOf(s, bucket, "st/large/");
  eq(
    "uploads under the prefix",
    [{ Key: key, UploadId: upload.uploadId }],
    listed.map((u) => ({ Key: u.Key, UploadId: u.UploadId })),
  );
  eq(
    "all uploads",
    [other.uploadId, upload.uploadId].sort(),
    (await uploadsOf(s, bucket)).map((u) => u.UploadId).sort(),
  );
  // Real B2 measurement 2026-10-12: an open upload is not an object and not a version.
  const openVersions = await versionsOf(s, bucket);
  eq("versions while uploads are open", 0, openVersions.versions.length);
  eq("delete markers while uploads are open", 0, openVersions.markers.length);
  const openObjects = await s.call("s3_list_objects_v2", { bucket: bucket.name });
  eq("objects listed while uploads are open", 0, openObjects.objects.length);
  eq("keyCount while uploads are open", 0, openObjects.keyCount);

  s.step("parts go to their presigned URLs");
  const partOne = payload(PART_SIZE, 101);
  const partTwo = payload(PART_SIZE, 102);
  const partThree = payload(1234, 103);
  // Part 2 first and part 1 last: the order of the uploads does not matter, only the part numbers.
  const sent = await putParts(s, upload, { 2: partTwo, 3: partThree, 1: partOne });
  const etags = Object.fromEntries(sent.map((p) => [p.partNumber, p.etag]));
  eq("etag of part 1 is the MD5 of its bytes", md5Hex(partOne), bareEtag(etags[1]));
  eq("etag of part 3 is the MD5 of its bytes", md5Hex(partThree), bareEtag(etags[3]));

  s.step("list parts");
  const parts = await partsOf(s, upload);
  eq(
    "parts listed, in part number order",
    [
      { n: 1, size: PART_SIZE, etag: md5Hex(partOne) },
      { n: 2, size: PART_SIZE, etag: md5Hex(partTwo) },
      { n: 3, size: partThree.length, etag: md5Hex(partThree) },
    ],
    parts.map((p) => ({ n: p.PartNumber, size: p.Size, etag: bareEtag(p.ETag) })),
  );
  const firstPage = await s.call("s3_list_parts", {
    bucket: bucket.name,
    key,
    uploadId: upload.uploadId,
    maxParts: 2,
  });
  eq(
    "first page of max-parts 2",
    [1, 2],
    firstPage.parts.map((p) => p.PartNumber),
  );
  eq("first page is truncated", true, firstPage.isTruncated);
  const secondPage = await s.call("s3_list_parts", {
    bucket: bucket.name,
    key,
    uploadId: upload.uploadId,
    maxParts: 2,
    partNumberMarker: Number(firstPage.nextPartNumberMarker),
  });
  eq(
    "second page starts after the marker",
    [3],
    secondPage.parts.map((p) => p.PartNumber),
  );
  eq("second page is the last", false, secondPage.isTruncated);

  s.step("complete");
  const done = await s.call("s3_complete_multipart_upload", {
    bucket: bucket.name,
    key,
    uploadId: upload.uploadId,
    parts: [1, 2, 3].map((partNumber) => ({ partNumber, etag: etags[partNumber] })),
  });
  upload.finished = true;
  eq("completed bucket", bucket.name, done.bucket);
  eq("completed key", key, done.key);
  check(
    /-3"?$/.test(done.etag ?? ""),
    `the ETag of a three-part object must end in -3, got ${done.etag}`,
  );

  s.step("the upload is no longer in progress");
  eq(
    "uploads after complete",
    [other.uploadId],
    (await uploadsOf(s, bucket)).map((u) => u.UploadId),
  );

  s.step("the assembled object");
  const whole = Buffer.concat([partOne, partTwo, partThree]);
  const { versions } = await versionsOf(s, bucket, key);
  eq("versions of the key", 1, versions.length);
  eq("listed size", whole.length, versions[0].Size);
  const head = await s.call("s3_head_object", { bucket: bucket.name, key });
  eq("contentLength", whole.length, head.contentLength);
  eq("contentType", "application/x-sdkharness", head.contentType);
  eq("custom metadata", "sdkharness-value", head.metadata?.["sdkharness-key"]);
  eq("head versionId is the listed version", versions[0].VersionId, head.versionId);
  check(
    (await readWhole(s, bucket, key)).equals(whole),
    "the assembled bytes differ from the parts",
  );
  // A read across the boundary of parts 1 and 2 shows they are joined in part number order.
  const across = await readBytes(s, bucket, key, {
    range: `bytes=${PART_SIZE - 10}-${PART_SIZE + 9}`,
  });
  check(
    across.bytes.equals(whole.subarray(PART_SIZE - 10, PART_SIZE + 10)),
    "the range across parts 1 and 2 differs from the bytes sent",
  );

  s.step("abort");
  const doomed = await startUpload(s, bucket, "st/large/aborted.bin");
  await putParts(s, doomed, { 1: payload(PART_SIZE, 104) });
  eq("the second upload is in progress", 2, (await uploadsOf(s, bucket)).length);
  await s.call("s3_abort_multipart_upload", {
    bucket: bucket.name,
    key: doomed.key,
    uploadId: doomed.uploadId,
    confirm: true,
  });
  doomed.finished = true;
  // Real B2 measurement 2026-10-12: the parts of an aborted upload are gone, 404 NoSuchUpload.
  const gone = await s.refused("s3_list_parts", {
    bucket: bucket.name,
    key: doomed.key,
    uploadId: doomed.uploadId,
  });
  check(/NoSuchUpload|404/.test(gone), `parts of an aborted upload: ${gone.slice(0, 160)}`);
  eq(
    "uploads after abort",
    [other.uploadId],
    (await uploadsOf(s, bucket)).map((u) => u.UploadId),
  );
  eq(
    "an aborted upload stores nothing",
    0,
    (await versionsOf(s, bucket, doomed.key)).versions.length,
  );

  s.step("a non-last part under the minimum is refused at complete (EntityTooSmall)");
  const small = await startUpload(s, bucket, "st/large/small-parts.bin");
  const smallSent = await putParts(s, small, { 1: payload(1000, 105), 2: payload(1000, 106) });
  const tooSmall = await s.refused("s3_complete_multipart_upload", {
    bucket: bucket.name,
    key: small.key,
    uploadId: small.uploadId,
    parts: smallSent.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
  });
  // Real B2 measurement 2026-10-12: 400 EntityTooSmall, not another refusal.
  check(/EntityTooSmall/.test(tooSmall), `refused for another reason: ${tooSmall.slice(0, 160)}`);
  // The upload is still unfinished, so the cleanup aborts it.
});
