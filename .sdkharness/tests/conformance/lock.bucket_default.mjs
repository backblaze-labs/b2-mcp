// lock.bucket_default (yes). Run by ../run-conformance; see ../../README.md.
//
// Object Lock on the bucket, through b2_update_bucket `fileLockEnabled` and `defaultRetention` (and
// `fileLockEnabled` on b2_create_bucket), against what B2 documents: a bucket made with Object Lock
// lists it as enabled; Object Lock can be turned on later and, once on, cannot be turned off; default
// retention can only be set on a bucket that has Object Lock; a fresh b2_list_buckets returns the mode
// and period that were set; a file uploaded after that is protected, so deleting its version is
// refused, while a file that was there before is not; clearing the default ({mode: null}) protects
// later uploads no more. The protection is observed where B2 enforces it, on the delete.
// https://www.backblaze.com/apidocs/b2-update-bucket https://www.backblaze.com/docs/cloud-storage-object-lock
// https://www.backblaze.com/apidocs/s3-delete-object
// real B2 measurement 2026-10-12: B2's S3 API supports GetObjectRetention and GetObjectLegalHold, and
// HEAD and GET of an object carry the lock headers (ObjectLockMode, ObjectLockRetainUntilDate,
// ObjectLockLegalHoldStatus). The server exposes no tool for any of it (no tool in src/ reads a
// retention or a hold; s3_head_object and the listings carry no Object Lock fields), so the read-back
// stays 'observed through the delete'.
// A file's protection is read from what a delete does; the per-file tools are checked in lock.per_file_retention.
import {
  bucketInfo,
  check,
  eq,
  newestVersionId,
  payload,
  put,
  runScenario,
  versionsOf,
} from "../lib/session.mjs";

await runScenario("lock.bucket_default", async (s) => {
  const lockOf = async (bucket) => (await bucketInfo(s, bucket)).fileLockConfiguration.value;
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

  s.step("a bucket made with Object Lock lists it as enabled");
  const locked = await s.bucket({ fileLockEnabled: true });
  const created = await lockOf(locked);
  eq("isFileLockEnabled after create", true, created.isFileLockEnabled);
  eq("default retention after create", { mode: null, period: null }, created.defaultRetention);

  s.step("default retention is refused on a bucket without Object Lock");
  const plain = await s.bucket();
  eq("isFileLockEnabled of a plain bucket", false, (await lockOf(plain)).isFileLockEnabled);
  await s.refused("b2_update_bucket", {
    bucketId: plain.id,
    defaultRetention: { mode: "governance", period: { duration: 1, unit: "days" } },
  });
  eq(
    "default retention stored after the refusal",
    { mode: null, period: null },
    (await lockOf(plain)).defaultRetention,
  );

  s.step("Object Lock can be turned on later and not off again");
  await s.call("b2_update_bucket", { bucketId: plain.id, fileLockEnabled: true });
  eq("isFileLockEnabled after turning it on", true, (await lockOf(plain)).isFileLockEnabled);
  await s.refused("b2_update_bucket", {
    bucketId: plain.id,
    fileLockEnabled: false,
    confirm: true,
  });
  eq(
    "isFileLockEnabled after trying to turn it off",
    true,
    (await lockOf(plain)).isFileLockEnabled,
  );

  s.step("a file from before the default is not protected by it");
  const key = "st/lock/default.txt";
  await put(s, locked, "st/lock/before.txt", payload(64, 90));
  const beforeId = await newestVersionId(s, locked, "st/lock/before.txt");

  s.step("set the default retention");
  const revision = (await bucketInfo(s, locked)).revision;
  await s.call("b2_update_bucket", {
    bucketId: locked.id,
    defaultRetention: { mode: "governance", period: { duration: 1, unit: "days" } },
  });
  const set = await bucketInfo(s, locked);
  eq(
    "default retention in a fresh listing",
    { mode: "governance", period: { duration: 1, unit: "days" } },
    set.fileLockConfiguration.value.defaultRetention,
  );
  check(set.revision > revision, `the revision did not grow: ${revision} then ${set.revision}`);

  s.step("an upload after the default is protected");
  await put(s, locked, key, payload(64, 91));
  const protectedId = await newestVersionId(s, locked, key);
  await deleteRefused(locked, key, protectedId);
  eq("versions stored after the refused delete", 1, await stored(locked, key));

  s.step("the file from before the default is deleted without trouble");
  await s.call("s3_delete_object", {
    bucket: locked.name,
    key: "st/lock/before.txt",
    versionId: beforeId,
    confirm: true,
  });
  eq("versions of the earlier file", 0, await stored(locked, "st/lock/before.txt"));

  s.step("the bypass removes a protected version");
  const out = await s.call("s3_delete_objects", {
    bucket: locked.name,
    objects: [{ key, versionId: protectedId }],
    bypassGovernance: true,
    quiet: false,
    confirm: true,
  });
  eq("errors of the bypass delete", [], out.errors);
  eq("versions after the bypass delete", 0, await stored(locked, key));

  s.step("clear the default retention");
  await s.call("b2_update_bucket", {
    bucketId: locked.id,
    defaultRetention: { mode: null, period: null },
    confirm: true,
  });
  eq(
    "default retention after clearing",
    { mode: null, period: null },
    (await lockOf(locked)).defaultRetention,
  );
  await put(s, locked, "st/lock/after-clear.txt", payload(64, 92));
  const clearedId = await newestVersionId(s, locked, "st/lock/after-clear.txt");
  await s.call("s3_delete_object", {
    bucket: locked.name,
    key: "st/lock/after-clear.txt",
    versionId: clearedId,
    confirm: true,
  });
  eq(
    "versions of an upload after the default was cleared",
    0,
    await stored(locked, "st/lock/after-clear.txt"),
  );
});
