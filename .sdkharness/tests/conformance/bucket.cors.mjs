// bucket.cors (yes). Run by ../run-conformance; see ../../README.md.
//
// `corsRules` on b2_create_bucket and b2_update_bucket against what B2 documents: the rules a bucket
// is given are the rules a fresh b2_list_buckets returns, in the same order and with every field;
// an update that names corsRules replaces the whole list, one that leaves it out changes nothing,
// an empty list clears it; a rule name is 6 to 63 letters, digits and hyphens, so a short one is
// refused and leaves the stored rules as they were.
// https://www.backblaze.com/apidocs/b2-update-bucket https://www.backblaze.com/apidocs/b2-create-bucket
// https://www.backblaze.com/docs/cloud-storage-cross-origin-resource-sharing-rules
// Only the stored configuration is asserted; whether the simulator answers a CORS preflight from it
// is not what the server's tool claims.
import { bucketInfo, check, eq, runScenario } from "../lib/session.mjs";

const rule = (name, origin, operations, headers, expose, maxAge) => ({
  corsRuleName: name,
  allowedOrigins: [origin],
  allowedOperations: operations,
  allowedHeaders: headers,
  exposeHeaders: expose,
  maxAgeSeconds: maxAge,
});

await runScenario("bucket.cors", async (s) => {
  const first = rule(
    "downloadFromAnyOrigin",
    "https://example.com",
    ["s3_get", "s3_head"],
    ["range"],
    ["x-amz-version-id"],
    3600,
  );
  const second = rule(
    "uploadFromApp",
    "https://app.example.com",
    ["s3_put"],
    ["content-type", "x-amz-meta-*"],
    [],
    60,
  );

  s.step("create with rules");
  const bucket = await s.bucket({ corsRules: [first] });
  eq("rules in a fresh listing after create", [first], (await bucketInfo(s, bucket)).corsRules);

  s.step("update replaces the list");
  const before = (await bucketInfo(s, bucket)).revision;
  await s.call("b2_update_bucket", { bucketId: bucket.id, corsRules: [second, first] });
  const replaced = await bucketInfo(s, bucket);
  eq("rules after an update, in order", [second, first], replaced.corsRules);
  check(
    replaced.revision > before,
    `the revision did not grow: ${before} then ${replaced.revision}`,
  );

  s.step("an update that leaves corsRules out changes nothing");
  await s.call("b2_update_bucket", {
    bucketId: bucket.id,
    bucketInfo: { "sdkharness-key": "one" },
  });
  const kept = await bucketInfo(s, bucket);
  eq("rules after an update of the info only", [second, first], kept.corsRules);
  eq("the info that update did set", { "sdkharness-key": "one" }, kept.bucketInfo);

  s.step("a rule name under 6 characters is refused and changes nothing");
  const refused = await s.refused("b2_update_bucket", {
    bucketId: bucket.id,
    corsRules: [rule("short", "https://example.com", ["s3_get"], [], [], 60)],
  });
  check(
    /corsRuleName|6-63|6 to 63|name/i.test(refused),
    `the refusal does not name the rule name: ${refused.slice(0, 160)}`,
  );
  eq("rules after the refused update", [second, first], (await bucketInfo(s, bucket)).corsRules);

  s.step("an empty list clears the rules");
  await s.call("b2_update_bucket", { bucketId: bucket.id, corsRules: [] });
  eq("rules after clearing", [], (await bucketInfo(s, bucket)).corsRules);

  s.step("a bucket made without rules has none");
  const plain = await s.bucket();
  eq("rules of a bucket made without any", [], (await bucketInfo(s, plain)).corsRules);
});
