// bucket.crud (yes). Run by ../run-conformance; see ../../README.md.
//
// b2_create_bucket, b2_list_buckets, b2_update_bucket and b2_delete_bucket against what B2 documents:
// a created bucket is listed with the name, type and info it was given; a name already taken is
// refused (`duplicate_bucket_name`); an update changes the type and info and the bucket's revision
// grows; a bucket that still holds files cannot be deleted (`cannot_delete_non_empty_bucket`); an
// emptied one can, and is then no longer listed.
// https://www.backblaze.com/apidocs/b2-create-bucket https://www.backblaze.com/apidocs/b2-list-buckets
// https://www.backblaze.com/apidocs/b2-update-bucket https://www.backblaze.com/apidocs/b2-delete-bucket
import { check, eq, payload, put, runScenario, versionsOf } from "../lib/session.mjs";

await runScenario("bucket.crud", async (s) => {
  const listed = async (bucket) =>
    (await s.call("b2_list_buckets", { bucketName: bucket.name })).buckets;

  s.step("create");
  const bucket = await s.bucket({ bucketInfo: { "sdkharness-key": "one" } });
  eq("created bucketName", bucket.name, bucket.created.bucketName);
  eq("created bucketType", "allPrivate", bucket.created.bucketType);
  eq("created bucketInfo", { "sdkharness-key": "one" }, bucket.created.bucketInfo);
  check(
    typeof bucket.id === "string" && bucket.id.length > 0,
    "the created bucket has no bucketId",
  );

  s.step("list");
  const found = await listed(bucket);
  eq(
    "buckets listed by name",
    [bucket.id],
    found.map((b) => b.bucketId),
  );
  eq("listed bucketType", "allPrivate", found[0].bucketType);
  eq("listed bucketInfo", { "sdkharness-key": "one" }, found[0].bucketInfo);
  const revision = found[0].revision;
  check(Number.isInteger(revision), `the bucket has no integer revision: ${revision}`);

  s.step("a taken name is refused");
  const duplicate = await s.refused("b2_create_bucket", {
    bucketName: bucket.name,
    bucketType: "allPrivate",
  });
  check(
    /duplicate_bucket_name/.test(duplicate),
    `a duplicate name was not duplicate_bucket_name: ${duplicate.slice(0, 160)}`,
  );

  s.step("update");
  await s.call("b2_update_bucket", {
    bucketId: bucket.id,
    bucketType: "allPublic",
    bucketInfo: { "sdkharness-key": "two" },
    confirm: true,
  });
  const updated = (await listed(bucket))[0];
  eq("updated bucketType", "allPublic", updated.bucketType);
  eq("updated bucketInfo", { "sdkharness-key": "two" }, updated.bucketInfo);
  check(
    updated.revision > revision,
    `the revision did not grow: ${revision} then ${updated.revision}`,
  );

  s.step("a non-empty bucket is not deleted");
  await put(s, bucket, "st/bucket/held.txt", payload(64, 50), { contentType: "text/plain" });
  const held = await s.refused("b2_delete_bucket", { bucketId: bucket.id, confirm: true });
  check(
    /cannot_delete_non_empty_bucket/.test(held),
    `deleting a non-empty bucket was not refused as such: ${held.slice(0, 160)}`,
  );
  eq("the bucket is still listed", 1, (await listed(bucket)).length);

  s.step("delete once empty");
  for (const v of (await versionsOf(s, bucket, "")).versions) {
    await s.call("s3_delete_object", {
      bucket: bucket.name,
      key: v.Key,
      versionId: v.VersionId,
      confirm: true,
    });
  }
  await s.call("b2_delete_bucket", { bucketId: bucket.id, confirm: true });
  s.forget(bucket);
  eq("buckets listed after the delete", 0, (await listed(bucket)).length);
});
