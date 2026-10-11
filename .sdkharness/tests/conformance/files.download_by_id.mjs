// files.download_by_id (yes). Run by ../run-conformance; see ../../README.md.
//
// The card's claim is that s3_get_object's `versionId` is the native file id. B2 keeps every upload
// of a name as its own version, and GetObject reads "versionId: VersionId to read": two versions of
// one key each download as themselves, the key alone reads the newest, and an id that names no
// version reads nothing. https://www.backblaze.com/apidocs/s3-get-object
// https://www.backblaze.com/apidocs/s3-list-object-versions
import { check, eq, payload, put, readBytes, runScenario, versionsOf } from "../lib/session.mjs";

await runScenario("files.download_by_id", async (s) => {
  s.step("bucket");
  const bucket = await s.bucket();

  s.step("two versions of one key");
  const key = "st/by-id/versioned.bin";
  const first = payload(2048, 4);
  const second = payload(3072, 5);
  await put(s, bucket, key, first, { contentType: "text/plain" });
  await put(s, bucket, key, second, { contentType: "text/plain" });
  const { versions } = await versionsOf(s, bucket, key);
  eq("versions of the key", 2, versions.length);
  const [newest, oldest] = versions;
  eq("newest version is the latest", true, newest.IsLatest);
  check(newest.VersionId !== oldest.VersionId, "both versions carry the same id");

  s.step("each id downloads its own bytes");
  const byOldest = await readBytes(s, bucket, key, { versionId: oldest.VersionId });
  check(byOldest.bytes.equals(first), "the older version's id did not return the first upload");
  eq("older version id echoed", oldest.VersionId, byOldest.versionId);
  const byNewest = await readBytes(s, bucket, key, { versionId: newest.VersionId });
  check(byNewest.bytes.equals(second), "the newer version's id did not return the second upload");

  s.step("by key alone is the newest");
  const byKey = await readBytes(s, bucket, key);
  check(byKey.bytes.equals(second), "reading the key alone did not return the newest version");
  eq("newest version id echoed", newest.VersionId, byKey.versionId);

  s.step("an id that names no version");
  const bogus = oldest.VersionId.replace(/_f[0-9a-z]+_/, "_f0000000000000000_");
  check(bogus !== oldest.VersionId, "could not derive an id that names no version");
  await s.refused("s3_get_object", { bucket: bucket.name, key, versionId: bogus });
});
