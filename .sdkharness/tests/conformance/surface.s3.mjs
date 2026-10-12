// surface.s3 (yes). Run by ../run-conformance; see ../../README.md.
//
// The card claims the server offers 19 `s3_*` tools over B2's S3-compatible endpoint (the generated
// profile docs/generated/tool-profiles.md lists them) and, by the same closed catalog, no native
// upload, download or hide tool and no `bz_*` (computer backup) tool. This turns the claim into what
// a client sees: it asks the running server for its tool list and compares the S3 names with the
// documented ones, name by name, then checks that the tools really reach the S3 endpoint by calling
// one that only the S3 API answers on a bucket the check made.
// https://www.backblaze.com/docs/cloud-storage-s3-compatible-api
// The expected names are copied from docs/generated/tool-profiles.md of this repository (the
// contract the project publishes), not read from the server.
import { check, eq, runScenario } from "../lib/session.mjs";

const S3_TOOLS = [
  "s3_abort_multipart_upload",
  "s3_complete_multipart_upload",
  "s3_copy_object",
  "s3_create_multipart_upload",
  "s3_delete_object",
  "s3_delete_objects",
  "s3_get_bucket_location",
  "s3_get_object",
  "s3_get_presigned_upload_part_url",
  "s3_get_presigned_url",
  "s3_head_bucket",
  "s3_head_object",
  "s3_list_multipart_uploads",
  "s3_list_object_versions",
  "s3_list_objects_v2",
  "s3_list_parts",
  "s3_put_bucket_lifecycle",
  "s3_put_object",
  "s3_upload_part_copy",
];
// The card (urls.native_download no, files.upload partial, files.hide partial) and
// docs/TEST-COVERAGE-MAP.md: native upload and download are "removed from the public surface".
const ABSENT_NATIVE_TOOLS = [
  "b2_upload_file",
  "b2_upload_part",
  "b2_get_upload_url",
  "b2_get_upload_part_url",
  "b2_start_large_file",
  "b2_finish_large_file",
  "b2_download_file_by_id",
  "b2_download_file_by_name",
  "b2_get_download_authorization",
  "b2_hide_file",
];

await runScenario("surface.s3", async (s) => {
  s.step("list the server's tools");
  const names = (await s.client.listTools()).tools.map((tool) => tool.name);
  check(names.length > 0, "the server offered no tools");

  s.step("every documented S3 tool is offered, and no other s3_ tool");
  const s3 = names.filter((name) => name.startsWith("s3_")).sort();
  const missing = S3_TOOLS.filter((name) => !names.includes(name));
  check(missing.length === 0, `S3 tools the contract names are missing: ${missing.join(", ")}`);
  eq("the s3_ tools offered", [...S3_TOOLS].sort(), s3);

  s.step("no native upload, download or hide tool and no bz_ tool");
  const present = ABSENT_NATIVE_TOOLS.filter((name) => names.includes(name));
  check(present.length === 0, `tools the card says are absent are offered: ${present.join(", ")}`);
  const bz = names.filter((name) => name.startsWith("bz_"));
  check(bz.length === 0, `bz_ tools are offered: ${bz.join(", ")}`);

  s.step("the S3 tools reach the S3 endpoint");
  const bucket = await s.bucket();
  const head = await s.call("s3_head_bucket", { bucket: bucket.name });
  check(
    head && !head.text?.startsWith("B2 Error"),
    "s3_head_bucket did not answer for a bucket that exists",
  );
  const listing = await s.call("s3_list_objects_v2", { bucket: bucket.name });
  eq("objects in a new bucket", 0, (listing.objects ?? listing.contents ?? []).length);
  const refused = await s.refused("s3_head_bucket", {
    bucket: `sdkharness-conf-none${bucket.name.slice(-6)}`,
  });
  check(
    /404|NotFound|NoSuchBucket|not.found/i.test(refused),
    `a missing bucket said: ${refused.slice(0, 160)}`,
  );
});
