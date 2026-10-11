// files.delete_version (yes). Run by ../run-conformance; see ../../README.md.
//
// s3_delete_object with a `versionId` is S3 DeleteObject by version: "If a versionId is included in
// the request, an object will be permanently deleted", and no delete marker is inserted. So the one
// version is gone from the listing and from a read by its id, the other version of the name stays
// and becomes the current one, and deleting the last version leaves the key with nothing at all.
// https://www.backblaze.com/apidocs/s3-delete-object
import { check, eq, payload, put, readBytes, runScenario, versionsOf } from "../lib/session.mjs";

await runScenario("files.delete_version", async (s) => {
  s.step("bucket");
  const bucket = await s.bucket();

  s.step("two versions");
  const key = "st/delete/versioned.bin";
  const first = payload(1024, 30);
  const second = payload(2048, 31);
  await put(s, bucket, key, first);
  await put(s, bucket, key, second);
  const before = await versionsOf(s, bucket, key);
  eq("versions before", 2, before.versions.length);
  const [newest, oldest] = before.versions;

  s.step("delete the newest version by id");
  await s.call("s3_delete_object", {
    bucket: bucket.name,
    key,
    versionId: newest.VersionId,
    confirm: true,
  });
  const after = await versionsOf(s, bucket, key);
  eq(
    "versions after",
    [oldest.VersionId],
    after.versions.map((v) => v.VersionId),
  );
  eq("delete markers after (a version delete inserts none)", 0, after.markers.length);
  eq("the survivor is now the current version", true, after.versions[0].IsLatest);

  s.step("the deleted id reads nothing");
  await s.refused("s3_get_object", { bucket: bucket.name, key, versionId: newest.VersionId });

  s.step("the other version survives");
  const current = await readBytes(s, bucket, key);
  check(current.bytes.equals(first), "the surviving version's bytes are not the first upload");

  s.step("delete the last version");
  await s.call("s3_delete_object", {
    bucket: bucket.name,
    key,
    versionId: oldest.VersionId,
    confirm: true,
  });
  const gone = await versionsOf(s, bucket, key);
  eq("versions at the end", 0, gone.versions.length);
  eq("delete markers at the end", 0, gone.markers.length);
  const listed = await s.call("s3_list_objects_v2", { bucket: bucket.name, prefix: key });
  eq("objects listed at the end", 0, listed.objects.length);
});
