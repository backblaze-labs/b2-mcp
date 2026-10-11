// lock.per_file_retention (yes). Run by ../run-conformance; see ../../README.md.
//
// b2_update_file_retention against what B2 documents: "after enabling file retention for a file in an
// Object Lock-enabled bucket, any attempts to delete the file ... before the end of the retention
// period will fail"; in governance mode the retention "can be deleted or the retention period
// shortened only by clients with the appropriate application key capability (bypassGovernance)", and
// it can be extended without it; a bucket without Object Lock is refused (400 bad_request). The
// effect is observed where B2 enforces it, on the delete of that version (s3_delete_object by
// versionId), and the version must still read afterwards.
// https://www.backblaze.com/apidocs/b2-update-file-retention https://www.backblaze.com/docs/cloud-storage-object-lock
// https://www.backblaze.com/apidocs/s3-delete-object
// The server has no tool that reads a file's retention back (s3_head_object and the listings carry no
// Object Lock fields), so the stored value is read from what the delete does, and from the answer of
// the update itself as a second witness, never alone.
// NOTE compliance mode is not exercised: a version under compliance retention cannot be removed by
// anyone before its date, so it would leave a bucket this check could not clean up.
import {
  check,
  eq,
  newestVersionId,
  payload,
  put,
  readBytes,
  runScenario,
  versionsOf,
} from "../lib/session.mjs";

await runScenario("lock.per_file_retention", async (s) => {
  const HOUR = 3_600_000;
  const stored = async (bucket, key) =>
    (await versionsOf(s, bucket, key)).versions.filter((v) => v.Key === key).length;
  const deleteRefused = async (bucket, key, versionId) => {
    const text = await s.refused("s3_delete_object", {
      bucket: bucket.name,
      key,
      versionId,
      confirm: true,
    });
    check(
      /AccessDenied|403/.test(text),
      `the delete was refused for another reason: ${text.slice(0, 160)}`,
    );
  };

  s.step("bucket with Object Lock and an upload");
  const bucket = await s.bucket({ fileLockEnabled: true });
  const key = "st/lock/retained.txt";
  const data = payload(256, 93);
  await put(s, bucket, key, data, { contentType: "text/plain" });
  const fileId = await newestVersionId(s, bucket, key);
  eq("versions stored after the upload", 1, await stored(bucket, key));

  s.step("set governance retention");
  const until = Date.now() + HOUR;
  const set = await s.call("b2_update_file_retention", {
    fileId,
    fileName: key,
    fileRetention: { mode: "governance", retainUntilTimestamp: until },
    confirm: true,
  });
  eq(
    "retention in the answer",
    ["governance", until],
    [set.fileRetention.mode, set.fileRetention.retainUntilTimestamp],
  );

  s.step("a delete of that version is refused and the version still reads");
  await deleteRefused(bucket, key, fileId);
  eq("versions stored after the refused delete", 1, await stored(bucket, key));
  const kept = await readBytes(s, bucket, key, { versionId: fileId });
  check(kept.bytes.equals(data), "the retained version's bytes changed");

  s.step("extending the retention needs no bypass");
  const later = until + HOUR;
  const extended = await s.call("b2_update_file_retention", {
    fileId,
    fileName: key,
    fileRetention: { mode: "governance", retainUntilTimestamp: later },
    confirm: true,
  });
  eq("extended retention in the answer", later, extended.fileRetention.retainUntilTimestamp);
  await deleteRefused(bucket, key, fileId);

  s.step("shortening or clearing the retention without the bypass is refused");
  await s.refused("b2_update_file_retention", {
    fileId,
    fileName: key,
    fileRetention: { mode: "governance", retainUntilTimestamp: until },
    confirm: true,
  });
  await s.refused("b2_update_file_retention", {
    fileId,
    fileName: key,
    fileRetention: { mode: null, retainUntilTimestamp: null },
    confirm: true,
  });
  await deleteRefused(bucket, key, fileId);

  s.step("clearing the retention with the bypass lets the version be deleted");
  const cleared = await s.call("b2_update_file_retention", {
    fileId,
    fileName: key,
    fileRetention: { mode: null, retainUntilTimestamp: null },
    bypassGovernance: true,
    confirm: true,
  });
  eq(
    "cleared retention in the answer",
    [null, null],
    [cleared.fileRetention.mode, cleared.fileRetention.retainUntilTimestamp],
  );
  await s.call("s3_delete_object", { bucket: bucket.name, key, versionId: fileId, confirm: true });
  eq("versions stored after the delete", 0, await stored(bucket, key));

  s.step("a bucket without Object Lock refuses retention");
  const plain = await s.bucket();
  await put(s, plain, key, data);
  const plainId = await newestVersionId(s, plain, key);
  await s.refused("b2_update_file_retention", {
    fileId: plainId,
    fileName: key,
    fileRetention: { mode: "governance", retainUntilTimestamp: Date.now() + HOUR },
    confirm: true,
  });
  await s.call("s3_delete_object", { bucket: plain.name, key, versionId: plainId, confirm: true });
  eq("versions stored in the plain bucket after its delete", 0, await stored(plain, key));
});
