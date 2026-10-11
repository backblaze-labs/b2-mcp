// lock.legal_hold (yes). Run by ../run-conformance; see ../../README.md.
//
// b2_update_file_legal_hold against what B2 documents: "enable legal hold for a file in an Object
// Lock-enabled bucket, preventing it from being deleted, or ... disable legal hold protections for a
// file"; legal hold and retention "function independently": if either, or both, are active the file
// is protected from deletion, and the governance bypass (which only concerns governance retention)
// does not lift a hold. The effect is observed where B2 enforces it, on the delete of that version
// (s3_delete_object by versionId, and s3_delete_objects with bypassGovernance), and the version must
// still read afterwards. A bucket without Object Lock refuses a hold.
// https://www.backblaze.com/apidocs/b2-update-file-legal-hold https://www.backblaze.com/docs/cloud-storage-object-lock
// https://www.backblaze.com/apidocs/s3-delete-object https://www.backblaze.com/apidocs/s3-delete-objects
// The server has no tool that reads a hold back, so it is read from what the delete does, and from the
// answer of the update itself as a second witness, never alone.
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

await runScenario("lock.legal_hold", async (s) => {
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
  const hold = (fileId, fileName, legalHold) =>
    s.call("b2_update_file_legal_hold", { fileId, fileName, legalHold, confirm: true });

  s.step("bucket with Object Lock and an upload");
  const bucket = await s.bucket({ fileLockEnabled: true });
  const key = "st/lock/held.txt";
  const data = payload(256, 94);
  await put(s, bucket, key, data, { contentType: "text/plain" });
  const fileId = await newestVersionId(s, bucket, key);
  // A hold blocks the removal of the bucket's contents at the end, so lift it first, failure or not.
  // (A version the scenario already deleted is gone, which is the state the cleanup wants.)
  s.cleanup(() =>
    hold(fileId, key, "off").catch((error) => {
      if (!/file_not_present/.test(String(error?.message))) throw error;
    }),
  );

  s.step("turn the hold on");
  const on = await hold(fileId, key, "on");
  eq("legalHold in the answer", "on", on.legalHold);

  s.step("a delete of that version is refused and the version still reads");
  await deleteRefused(bucket, key, fileId);
  eq("versions stored after the refused delete", 1, await stored(bucket, key));
  const kept = await readBytes(s, bucket, key, { versionId: fileId });
  check(kept.bytes.equals(data), "the held version's bytes changed");

  s.step("the governance bypass does not lift a hold");
  const bypass = await s.call("s3_delete_objects", {
    bucket: bucket.name,
    objects: [{ key, versionId: fileId }],
    bypassGovernance: true,
    quiet: false,
    confirm: true,
  });
  eq("deleted by the bypass delete", [], bypass.deleted);
  eq("errors of the bypass delete", 1, bypass.errors.length);
  check(
    /AccessDenied/.test(bypass.errors[0].Code),
    `the bypass delete error was ${JSON.stringify(bypass.errors[0])}`,
  );
  eq("versions stored after the bypass delete", 1, await stored(bucket, key));

  s.step("a hold and a retention are independent");
  const until = Date.now() + 3_600_000;
  await s.call("b2_update_file_retention", {
    fileId,
    fileName: key,
    fileRetention: { mode: "governance", retainUntilTimestamp: until },
    confirm: true,
  });
  const off = await hold(fileId, key, "off");
  eq("legalHold in the answer", "off", off.legalHold);
  await deleteRefused(bucket, key, fileId);
  eq("versions stored with the hold off and the retention on", 1, await stored(bucket, key));

  s.step("with the hold off and the retention cleared the version can be deleted");
  await s.call("b2_update_file_retention", {
    fileId,
    fileName: key,
    fileRetention: { mode: null, retainUntilTimestamp: null },
    bypassGovernance: true,
    confirm: true,
  });
  await s.call("s3_delete_object", { bucket: bucket.name, key, versionId: fileId, confirm: true });
  eq("versions stored after the delete", 0, await stored(bucket, key));

  s.step("turning the hold on and off again leaves the file deletable");
  const again = "st/lock/held-twice.txt";
  await put(s, bucket, again, data);
  const againId = await newestVersionId(s, bucket, again);
  await hold(againId, again, "on");
  await deleteRefused(bucket, again, againId);
  await hold(againId, again, "off");
  await s.call("s3_delete_object", {
    bucket: bucket.name,
    key: again,
    versionId: againId,
    confirm: true,
  });
  eq("versions stored after the second delete", 0, await stored(bucket, again));

  s.step("a bucket without Object Lock refuses a hold");
  const plain = await s.bucket();
  await put(s, plain, key, data);
  const plainId = await newestVersionId(s, plain, key);
  await s.refused("b2_update_file_legal_hold", {
    fileId: plainId,
    fileName: key,
    legalHold: "on",
    confirm: true,
  });
  await s.call("s3_delete_object", { bucket: plain.name, key, versionId: plainId, confirm: true });
  eq("versions stored in the plain bucket after its delete", 0, await stored(plain, key));
});
