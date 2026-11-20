// keys.multi_bucket (yes). Run by ../run-conformance; see ../../README.md.
//
// `bucketIds` on b2_create_key: B2 lets one application key be limited to several buckets, and
// b2_list_keys reports exactly the buckets the key was given. A key made for two buckets is listed
// with both ids and with no third bucket; a key made for the third alone is listed with that one;
// deleting the two-bucket key removes it and leaves the other. The check does not sign in with the
// new key: the server writes its secret to a sink file for the operator (see keys.crud), so the
// scope is asserted from the listing, not from what the key can do.
// https://www.backblaze.com/apidocs/b2-create-key (bucketIds) https://www.backblaze.com/apidocs/b2-list-keys
// https://www.backblaze.com/docs/cloud-storage-application-keys
import { check, eq, runScenario, secretSink } from "../lib/session.mjs";

const sink = secretSink();

await runScenario(
  "keys.multi_bucket",
  async (s) => {
    s.cleanup(async () => sink.remove());
    const listed = async () => (await s.call("b2_list_keys", { maxKeyCount: 1000 })).keys;
    const find = async (id) => (await listed()).find((k) => k.applicationKeyId === id);

    s.step("three buckets");
    const first = await s.bucket();
    const second = await s.bucket();
    const third = await s.bucket();

    s.step("a key for two buckets");
    const both = await s.call("b2_create_key", {
      keyName: "sdkharness-multi-two",
      capabilities: ["listFiles", "readFiles"],
      bucketIds: [first.id, second.id],
      idempotencyKey: `sdkharness-multi-two-${first.name}`,
      confirm: true,
    });
    const single = await s.call("b2_create_key", {
      keyName: "sdkharness-multi-one",
      capabilities: ["listFiles", "readFiles"],
      bucketIds: [third.id],
      idempotencyKey: `sdkharness-multi-one-${first.name}`,
      confirm: true,
    });
    for (const key of [both, single]) {
      check(
        typeof key.applicationKeyId === "string" && key.applicationKeyId.length > 0,
        `b2_create_key returned no applicationKeyId: ${JSON.stringify(key).slice(0, 160)}`,
      );
    }
    s.cleanup(async () => {
      for (const key of [both, single]) {
        if (await find(key.applicationKeyId)) {
          await s.call("b2_delete_key", { applicationKeyId: key.applicationKeyId, confirm: true });
        }
      }
    });

    s.step("listed with both buckets and not the third");
    const listedBoth = await find(both.applicationKeyId);
    check(listedBoth, "the two-bucket key is not in b2_list_keys");
    eq("two-bucket key bucketIds", [first.id, second.id].sort(), [...listedBoth.bucketIds].sort());
    check(
      !listedBoth.bucketIds.includes(third.id),
      "the two-bucket key lists the third bucket too",
    );

    s.step("the key for the third bucket alone lists only it");
    const listedSingle = await find(single.applicationKeyId);
    eq("one-bucket key bucketIds", [third.id], listedSingle?.bucketIds);

    s.step("deleting the two-bucket key leaves the other");
    await s.call("b2_delete_key", { applicationKeyId: both.applicationKeyId, confirm: true });
    check(!(await find(both.applicationKeyId)), "the deleted key is still listed");
    eq("one-bucket key survives", [third.id], (await find(single.applicationKeyId))?.bucketIds);
  },
  { env: sink.env },
);
