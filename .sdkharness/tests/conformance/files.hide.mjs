// files.hide (partial). Run by ../run-conformance; see ../../README.md.
//
// The cell is `partial`: the server has no hide tool, and the card infers that `s3_delete_object`
// without a `versionId` is the S3-API equivalent. That inference is what is asserted. S3 DeleteObject
// without a versionId "a delete marker will be inserted. This delete marker will become the current
// version of the object": the name leaves the listing and a read by key is a 404, the marker is a
// new version listed as a delete marker, and the earlier version is still stored and still reads by
// its id. https://www.backblaze.com/apidocs/s3-delete-object
// https://www.backblaze.com/apidocs/s3-list-object-versions
// The boundary itself (no hide tool in the catalog) is asserted too, so a card that goes from
// `partial` to `yes` has to be re-inspected rather than missed.
import { check, eq, payload, put, readBytes, runScenario, versionsOf } from "../lib/session.mjs";

await runScenario("files.hide", async (s) => {
  s.step("bucket");
  const bucket = await s.bucket();

  s.step("upload");
  const key = "st/hide/visible.txt";
  const data = payload(512, 40);
  await put(s, bucket, key, data, { contentType: "text/plain" });
  const before = await versionsOf(s, bucket, key);
  eq("versions before the hide", 1, before.versions.length);
  const original = before.versions[0];
  eq(
    "listed before the hide",
    [key],
    (await s.call("s3_list_objects_v2", { bucket: bucket.name, prefix: key })).objects.map(
      (o) => o.Key,
    ),
  );

  s.step("hide: delete without a version id");
  await s.call("s3_delete_object", { bucket: bucket.name, key, confirm: true });

  s.step("not in the default listing");
  const listed = await s.call("s3_list_objects_v2", { bucket: bucket.name, prefix: key });
  eq("objects listed after the hide", 0, listed.objects.length);

  s.step("visible as a delete marker");
  const after = await versionsOf(s, bucket, key);
  eq("delete markers after the hide", 1, after.markers.length);
  eq("the marker is the current version", true, after.markers[0].IsLatest);
  check(
    after.markers[0].VersionId !== original.VersionId,
    "the marker reused the uploaded version's id",
  );
  eq(
    "versions after the hide",
    [original.VersionId],
    after.versions.map((v) => v.VersionId),
  );
  eq("the upload is no longer the latest", false, after.versions[0].IsLatest);

  s.step("a read by key is a 404");
  const refused = await s.refused("s3_get_object", { bucket: bucket.name, key });
  check(/HTTP 404/.test(refused), `a hidden key did not read as 404: ${refused.slice(0, 120)}`);

  s.step("the original version is still stored");
  const kept = await readBytes(s, bucket, key, { versionId: original.VersionId });
  check(kept.bytes.equals(data), "the hidden object's original version no longer reads by its id");

  s.step("boundary: no hide tool in the catalog");
  const { tools } = await s.client.listTools();
  const hide = tools.map((tool) => tool.name).filter((name) => /hide/i.test(name));
  eq("tools named for hiding", [], hide);
});
