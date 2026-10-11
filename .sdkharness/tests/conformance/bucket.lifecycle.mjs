// bucket.lifecycle (yes). Run by ../run-conformance; see ../../README.md.
//
// The card claims two paths: `lifecycleRules` on b2_create_bucket and b2_update_bucket, and the S3
// tool s3_put_bucket_lifecycle. Against what B2 documents for the native one: the rules a bucket is
// given are the rules a fresh b2_list_buckets returns; "if specified, the existing lifecycle rules
// will be replaced with this new list", "if not specified, the setting will remain unchanged", and an
// empty list leaves none.
// https://www.backblaze.com/apidocs/b2-update-bucket https://www.backblaze.com/docs/cloud-storage-lifecycle-rules
// The S3 path is asserted last, through the same fresh listing (B2 keeps one set of rules for both
// APIs): a rule put with s3_put_bucket_lifecycle for a prefix is listed with that prefix, and an
// empty rule list clears them. The simulator's S3 layer answers lifecycle calls with 501
// NotImplemented at the pin, so this step fails there, with that reason; the native steps before it
// have passed by then. A property a rule leaves out is "treated as having a null value" (the lifecycle
// page), so the delete-only and hide-only rules leave the other one out.
import { bucketInfo, check, eq, runScenario } from "../lib/session.mjs";

await runScenario("bucket.lifecycle", async (s) => {
  const hideAndDelete = {
    fileNamePrefix: "tmp/",
    daysFromUploadingToHiding: 7,
    daysFromHidingToDeleting: 2,
  };
  const deleteOnly = {
    fileNamePrefix: "logs/",
    daysFromHidingToDeleting: 30,
  };
  const hideOnly = {
    fileNamePrefix: "old/",
    daysFromUploadingToHiding: 90,
  };
  const ruleOf = (info, prefix) => info.lifecycleRules.find((r) => r.fileNamePrefix === prefix);
  const same = (what, expected, actual) => {
    check(actual !== undefined, `${what}: the rule is not listed`);
    const fields = (r) => [
      r.fileNamePrefix,
      r.daysFromUploadingToHiding ?? null,
      r.daysFromHidingToDeleting ?? null,
    ];
    eq(what, fields(expected), fields(actual));
  };
  const prefixes = (info) => info.lifecycleRules.map((r) => r.fileNamePrefix).sort();

  s.step("create with a rule");
  const bucket = await s.bucket({ lifecycleRules: [hideAndDelete] });
  const created = await bucketInfo(s, bucket);
  eq("rules listed after create", 1, created.lifecycleRules.length);
  same("created rule", hideAndDelete, ruleOf(created, "tmp/"));

  s.step("update replaces the list");
  await s.call("b2_update_bucket", {
    bucketId: bucket.id,
    lifecycleRules: [deleteOnly, hideOnly],
    confirm: true,
  });
  const replaced = await bucketInfo(s, bucket);
  eq("prefixes after the update", ["logs/", "old/"], prefixes(replaced));
  same("delete-only rule", deleteOnly, ruleOf(replaced, "logs/"));
  same("hide-only rule", hideOnly, ruleOf(replaced, "old/"));
  check(
    replaced.revision > created.revision,
    `the revision did not grow: ${created.revision} then ${replaced.revision}`,
  );

  s.step("an update that leaves lifecycleRules out changes nothing");
  await s.call("b2_update_bucket", {
    bucketId: bucket.id,
    bucketInfo: { "sdkharness-key": "one" },
  });
  eq(
    "prefixes after an update of the info only",
    ["logs/", "old/"],
    prefixes(await bucketInfo(s, bucket)),
  );

  s.step("an empty list clears the rules");
  await s.call("b2_update_bucket", { bucketId: bucket.id, lifecycleRules: [], confirm: true });
  eq("rules after clearing", [], (await bucketInfo(s, bucket)).lifecycleRules);

  s.step("a bucket made without rules has none");
  const plain = await s.bucket();
  eq("rules of a bucket made without any", [], (await bucketInfo(s, plain)).lifecycleRules);

  s.step("s3_put_bucket_lifecycle sets a rule");
  await s.call("s3_put_bucket_lifecycle", {
    bucket: plain.name,
    rules: [
      {
        id: "expire-tmp",
        status: "Enabled",
        filter: { prefix: "s3tmp/" },
        expiration: { days: 5 },
      },
    ],
    confirm: true,
  });
  const viaS3 = await bucketInfo(s, plain);
  check(
    viaS3.lifecycleRules.some((r) => r.fileNamePrefix === "s3tmp/"),
    `no rule for the prefix s3tmp/ is listed after s3_put_bucket_lifecycle: ${JSON.stringify(viaS3.lifecycleRules)}`,
  );

  s.step("s3_put_bucket_lifecycle with no rules clears them");
  await s.call("s3_put_bucket_lifecycle", { bucket: plain.name, rules: [], confirm: true });
  eq("rules after clearing through S3", [], (await bucketInfo(s, plain)).lifecycleRules);
});
