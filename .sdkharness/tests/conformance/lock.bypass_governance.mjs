// lock.bypass_governance (yes). Run by ../run-conformance; see ../../README.md.
//
// `bypassGovernance` on b2_update_file_retention and on s3_delete_objects, against what B2 documents:
// a version under governance retention cannot be deleted without the bypass ("attempts to delete the
// file ... before the end of the retention period will fail") and can with it; "bypassGovernance ...
// must be specified and set to true if deleting an existing governance mode retention setting or
// shortening an existing governance mode retention period". The bypass concerns governance retention
// only, so it does not lift a legal hold. The effect is observed on the stored versions: the refused
// delete leaves the version listed and readable, the bypass delete removes it.
// https://www.backblaze.com/apidocs/b2-update-file-retention https://www.backblaze.com/docs/cloud-storage-object-lock
// https://www.backblaze.com/apidocs/s3-delete-objects https://www.backblaze.com/apidocs/s3-delete-object
// real B2 measurement 2026-10-12: B2's S3 API supports GetObjectRetention and GetObjectLegalHold, and
// HEAD and GET of an object carry the lock headers (ObjectLockMode, ObjectLockRetainUntilDate,
// ObjectLockLegalHoldStatus). The server exposes no tool for any of it (no tool in src/ reads a
// retention or a hold; s3_head_object and the listings carry no Object Lock fields), so the read-back
// stays 'observed through the delete'.
// Real B2 measurement 2026-10-12 settles: a delete of a locked version is 403 AccessDenied; shortening
// retention needs the bypass (403 AccessDenied without) and extending does not; the bypass does not lift
// a legal hold (403 AccessDenied with it).
// NOTE the card names exactly these two tools. s3_delete_object (one object) has no bypass input, which
// is asserted too, so a card that grows a third path has to be re-inspected.
// NOTE compliance mode is not exercised: it is not bypassable and would leave a bucket this check
// could not clean up.
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

await runScenario("lock.bypass_governance", async (s) => {
  const HOUR = 3_600_000;
  const stored = async (bucket, key) =>
    (await versionsOf(s, bucket, key)).versions.filter((v) => v.Key === key).length;
  const retain = (fileId, fileName, retainUntilTimestamp) =>
    s.call("b2_update_file_retention", {
      fileId,
      fileName,
      fileRetention: { mode: "governance", retainUntilTimestamp },
      confirm: true,
    });
  const bulkDelete = (bucket, key, versionId, bypassGovernance) =>
    s.call("s3_delete_objects", {
      bucket: bucket.name,
      objects: [{ key, versionId }],
      ...(bypassGovernance === undefined ? {} : { bypassGovernance }),
      quiet: false,
      confirm: true,
    });

  s.step("bucket with Object Lock and a retained upload");
  const bucket = await s.bucket({ fileLockEnabled: true });
  const key = "st/lock/bypass.txt";
  const data = payload(256, 95);
  await put(s, bucket, key, data, { contentType: "text/plain" });
  const fileId = await newestVersionId(s, bucket, key);
  await retain(fileId, key, Date.now() + HOUR);

  s.step("a delete without the bypass is refused and the version still reads");
  const refused = await bulkDelete(bucket, key, fileId);
  eq("deleted without the bypass", [], refused.deleted);
  eq("errors without the bypass", 1, refused.errors.length);
  check(
    /AccessDenied/.test(refused.errors[0].Code),
    `the error was ${JSON.stringify(refused.errors[0])}`,
  );
  const explicit = await bulkDelete(bucket, key, fileId, false);
  eq("deleted with bypassGovernance false", [], explicit.deleted);
  eq("versions stored after the refused deletes", 1, await stored(bucket, key));
  const kept = await readBytes(s, bucket, key, { versionId: fileId });
  check(kept.bytes.equals(data), "the retained version's bytes changed");

  s.step("a delete with the bypass removes the version");
  const done = await bulkDelete(bucket, key, fileId, true);
  eq("errors with the bypass", [], done.errors);
  eq(
    "deleted with the bypass",
    [fileId],
    done.deleted.map((d) => d.VersionId),
  );
  eq("versions stored after the bypass delete", 0, await stored(bucket, key));
  await s.refused("s3_get_object", { bucket: bucket.name, key, versionId: fileId });

  s.step("shortening the retention needs the bypass");
  const second = "st/lock/bypass-shorten.txt";
  await put(s, bucket, second, data);
  const secondId = await newestVersionId(s, bucket, second);
  const far = Date.now() + 2 * HOUR;
  await retain(secondId, second, far);
  const near = Date.now() + HOUR;
  await s.refused("b2_update_file_retention", {
    fileId: secondId,
    fileName: second,
    fileRetention: { mode: "governance", retainUntilTimestamp: near },
    confirm: true,
  });
  const shortened = await s.call("b2_update_file_retention", {
    fileId: secondId,
    fileName: second,
    fileRetention: { mode: "governance", retainUntilTimestamp: near },
    bypassGovernance: true,
    confirm: true,
  });
  eq("retention after the bypass shortening", near, shortened.fileRetention.retainUntilTimestamp);

  s.step("the bypass clears the retention, then the delete needs none");
  await s.call("b2_update_file_retention", {
    fileId: secondId,
    fileName: second,
    fileRetention: { mode: null, retainUntilTimestamp: null },
    bypassGovernance: true,
    confirm: true,
  });
  const plainDelete = await bulkDelete(bucket, second, secondId);
  eq("errors of a delete after the clearing", [], plainDelete.errors);
  eq("versions stored after it", 0, await stored(bucket, second));

  s.step("boundary: the bypass does not lift a legal hold");
  const held = "st/lock/bypass-held.txt";
  await put(s, bucket, held, data);
  const heldId = await newestVersionId(s, bucket, held);
  s.cleanup(() =>
    s
      .call("b2_update_file_legal_hold", {
        fileId: heldId,
        fileName: held,
        legalHold: "off",
        confirm: true,
      })
      .catch((error) => {
        if (!/file_not_present/.test(String(error?.message))) throw error;
      }),
  );
  await s.call("b2_update_file_legal_hold", {
    fileId: heldId,
    fileName: held,
    legalHold: "on",
    confirm: true,
  });
  const heldTry = await bulkDelete(bucket, held, heldId, true);
  eq("deleted by the bypass on a held version", [], heldTry.deleted);
  eq("errors by the bypass on a held version", 1, heldTry.errors.length);
  eq("versions stored after it", 1, await stored(bucket, held));

  s.step("boundary: s3_delete_object has no bypass input");
  const { tools } = await s.client.listTools();
  const single = tools.find((tool) => tool.name === "s3_delete_object");
  check(single, "s3_delete_object is not in the tool catalog");
  eq(
    "bypass inputs of s3_delete_object",
    [],
    Object.keys(single.inputSchema?.properties ?? {}).filter((name) => /bypass/i.test(name)),
  );
});
