// files.list (yes). Run by ../run-conformance; see ../../README.md.
//
// s3_list_objects_v2 and s3_list_object_versions are S3 ListObjectsV2 and ListObjectVersions. The
// listing is in key order, honours `prefix`, pages by `maxKeys` with a continuation token that
// reaches every key exactly once, groups keys under a `delimiter` as common prefixes, resumes
// after `startAfter`; the version listing shows every version of a name, newest first, with
// IsLatest on the newest only. https://www.backblaze.com/apidocs/s3-list-objects-v2
// https://www.backblaze.com/apidocs/s3-list-object-versions
import { check, eq, payload, put, runScenario, versionsOf } from "../lib/session.mjs";

const keys = [
  "st/list/a.txt",
  "st/list/b.txt",
  "st/list/c.txt",
  "st/list/dir/e.txt",
  "st/list/dir/f.txt",
];

await runScenario("files.list", async (s) => {
  s.step("bucket");
  const bucket = await s.bucket();

  s.step("upload");
  for (const [i, key] of keys.entries()) await put(s, bucket, key, payload(100 + i, 10 + i));
  await put(s, bucket, "st/other/z.txt", payload(50, 20));
  await put(s, bucket, "st/list/a.txt", payload(333, 21)); // a second version of a name

  const list = (extra) => s.call("s3_list_objects_v2", { bucket: bucket.name, ...extra });
  const names = (page) => page.objects.map((o) => o.Key);

  s.step("prefix, in key order, one entry per name");
  const all = await list({ prefix: "st/list/" });
  eq("keys under the prefix", keys, names(all));
  eq("size of the newest version of a.txt", 333, all.objects[0].Size);
  eq("isTruncated", false, all.isTruncated);

  s.step("paging");
  const seen = [];
  let token;
  let pages = 0;
  do {
    const page = await list({
      prefix: "st/list/",
      maxKeys: 2,
      ...(token ? { continuationToken: token } : {}),
    });
    check(page.objects.length <= 2, `a page of maxKeys 2 held ${page.objects.length} keys`);
    seen.push(...names(page));
    token = page.isTruncated ? page.nextContinuationToken : undefined;
    pages += 1;
    check(pages <= 10, "paging did not end");
  } while (token);
  eq("keys across the pages", keys, seen);
  eq("pages of two for five keys", 3, pages);

  s.step("delimiter");
  const folders = await list({ prefix: "st/list/", delimiter: "/" });
  eq("objects above the folder", keys.slice(0, 3), names(folders));
  eq("common prefixes", [{ Prefix: "st/list/dir/" }], folders.commonPrefixes);

  s.step("startAfter");
  const after = await list({ prefix: "st/list/", startAfter: "st/list/b.txt" });
  eq("keys after b.txt", keys.slice(2), names(after));

  s.step("versions, newest first");
  const { versions, markers } = await versionsOf(s, bucket, "st/list/a.txt");
  eq("versions of a.txt", 2, versions.length);
  eq("delete markers", 0, markers.length);
  eq(
    "newest is IsLatest",
    [true, false],
    versions.map((v) => v.IsLatest),
  );
  eq(
    "newest first by size",
    [333, 100],
    versions.map((v) => v.Size),
  );
});
