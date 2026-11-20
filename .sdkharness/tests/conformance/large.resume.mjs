// large.resume (partial). Run by ../run-conformance; see ../../README.md.
//
// The card claims no resume tool, only the building blocks: s3_list_multipart_uploads ("Use to
// resume ..."), s3_list_parts, and presigning only the missing part numbers. So this check does what
// an agent that lost its state would do, with a second server process that has never seen the upload:
// find the unfinished upload by its key, read which parts B2 already holds (with their ETags), send
// only the missing part, complete, and find the object whole. B2 keeps the parts of an unfinished
// large file until it is finished or cancelled, and lists them:
// https://www.backblaze.com/apidocs/s3-list-multipart-uploads https://www.backblaze.com/apidocs/s3-list-parts
// https://www.backblaze.com/apidocs/s3-upload-part https://www.backblaze.com/apidocs/s3-complete-multipart-upload
// (an in-progress upload "has been initiated ... but has not yet been completed or aborted"; the
// part-number-marker pages a listing). Part sizes: https://www.backblaze.com/docs/cloud-storage-large-files
// real B2 measurement 2026-10-12: the last part may be small (even a single part of 10 bytes
// completes, ETag ending -1; the 4,321-byte last part here is that case), while a small part that is
// not the last is 400 EntityTooSmall; the open upload and its parts are listed by
// ListMultipartUploads and ListParts only (not as an object or a version), which is why a second
// process finds it by those two calls.
// The boundary is asserted too: the server exposes no tool that resumes an upload.
import {
  bareEtag,
  check,
  eq,
  md5Hex,
  PART_SIZE,
  partsOf,
  payload,
  putParts,
  readWhole,
  runScenario,
  startServer,
  startUpload,
  uploadsOf,
  versionsOf,
  viaPresignedUrl,
} from "../lib/session.mjs";

await runScenario("large.resume", async (s) => {
  s.step("bucket");
  const bucket = await s.bucket();

  s.step("boundary: no tool resumes an upload");
  const { tools } = await s.client.listTools();
  const names = tools.map((t) => t.name);
  eq(
    "tools named for resuming",
    [],
    names.filter((name) => /resum|continue/i.test(name)),
  );
  for (const building of [
    "s3_list_multipart_uploads",
    "s3_list_parts",
    "s3_get_presigned_upload_part_url",
    "s3_complete_multipart_upload",
  ]) {
    check(names.includes(building), `the tool ${building} is not exposed`);
  }

  s.step("an upload is interrupted after two parts");
  const key = "st/resume/big.bin";
  const partOne = payload(PART_SIZE, 111);
  const partTwo = payload(PART_SIZE, 112);
  const partThree = payload(4321, 113);
  const upload = await startUpload(s, bucket, key, { contentType: "application/x-sdkharness" });
  const first = await putParts(s, upload, { 1: partOne, 2: partTwo });
  eq("parts sent before the interruption", 2, first.length);

  s.step("a fresh server process finds the unfinished upload");
  const agent = await startServer("sdkharness-conformance-large.resume-agent");
  s.cleanup(() => agent.close());
  const call = async (name, args) => {
    const out = await agent.callTool({ name, arguments: args });
    const text = out.content.map((part) => part.text ?? "").join("");
    if (out.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text);
  };
  const listed = (
    await call("s3_list_multipart_uploads", { bucket: bucket.name, prefix: "st/resume/" })
  ).uploads;
  eq(
    "unfinished uploads under the prefix",
    [{ Key: key, UploadId: upload.uploadId }],
    listed.map((u) => ({ Key: u.Key, UploadId: u.UploadId })),
  );
  const resumed = { bucket: bucket.name, key, uploadId: listed[0].UploadId };

  s.step("it reads which parts B2 already holds");
  const held = (await call("s3_list_parts", resumed)).parts;
  eq(
    "parts already held",
    [
      { n: 1, size: PART_SIZE, etag: md5Hex(partOne) },
      { n: 2, size: PART_SIZE, etag: md5Hex(partTwo) },
    ],
    held.map((p) => ({ n: p.PartNumber, size: p.Size, etag: bareEtag(p.ETag) })),
  );

  s.step("only the missing part is presigned and sent");
  const missing = [1, 2, 3].filter((n) => !held.some((p) => p.PartNumber === n));
  eq("missing part numbers", [3], missing);
  const minted = await call("s3_get_presigned_upload_part_url", {
    ...resumed,
    partNumbers: missing,
  });
  eq(
    "presigned part numbers",
    missing,
    minted.parts.map((p) => p.partNumber),
  );
  const sentThree = await viaPresignedUrl("PUT", minted.parts[0].url, partThree);
  eq("PUT of part 3", 200, sentThree.status);
  const sent = [{ partNumber: 3, etag: sentThree.headers.etag }];
  eq(
    "parts held after the resume",
    [1, 2, 3],
    (await partsOf(s, upload)).map((p) => p.PartNumber),
  );

  s.step("complete with the ETags B2 listed and the one just returned");
  await call("s3_complete_multipart_upload", {
    ...resumed,
    parts: [
      ...held.map((p) => ({ partNumber: p.PartNumber, etag: p.ETag })),
      { partNumber: 3, etag: sent[0].etag },
    ],
  });
  upload.finished = true;

  s.step("the object is whole and the upload is finished");
  eq("uploads left", [], await uploadsOf(s, bucket));
  const whole = Buffer.concat([partOne, partTwo, partThree]);
  const { versions } = await versionsOf(s, bucket, key);
  eq("versions of the key", 1, versions.length);
  eq("listed size", whole.length, versions[0].Size);
  const head = await s.call("s3_head_object", { bucket: bucket.name, key });
  eq("contentLength", whole.length, head.contentLength);
  eq("contentType", "application/x-sdkharness", head.contentType);
  check(
    (await readWhole(s, bucket, key)).equals(whole),
    "the resumed object's bytes differ from the parts sent",
  );
});
