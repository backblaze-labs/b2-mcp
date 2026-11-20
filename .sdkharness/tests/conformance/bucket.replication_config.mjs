// bucket.replication_config (yes). Run by ../run-conformance; see ../../README.md.
//
// `replicationConfiguration` on b2_update_bucket against what B2 documents: a source bucket is given
// rules (a destination bucket id, a prefix, a priority, enabled or not) and the application key B2
// replicates with, a destination bucket is given the mapping from that source key to the key that
// writes into it, and a fresh b2_list_buckets returns exactly what was set on each side. A rule
// naming a source key B2 does not know is refused and changes nothing.
// https://www.backblaze.com/apidocs/b2-update-bucket (replicationConfiguration)
// https://www.backblaze.com/docs/cloud-storage-cloud-replication
// The two application keys are made through the server's own b2_create_key, which needs a secret
// sink; this scenario starts its server with the explicit local `B2_SECRET_SINK=inline`, on the
// loopback simulator with its fixed fake credential, so no real secret exists. Only the stored
// configuration is asserted. Whether files are then copied is B2's replication job (the cloud
// replication page says it runs on its own schedule) and not a tool the server offers.
import { bucketInfo, check, eq, runScenario } from "../lib/session.mjs";

await runScenario(
  "bucket.replication_config",
  async (s) => {
    s.step("source and destination buckets");
    const source = await s.bucket();
    const destination = await s.bucket();

    s.step("application keys through b2_create_key");
    const sourceKey = await s.call("b2_create_key", {
      keyName: "sdkharness-repl-source",
      capabilities: ["listFiles", "readFiles"],
      bucketIds: [source.id],
      idempotencyKey: `sdkharness-source-${source.name}`,
      confirm: true,
    });
    const destinationKey = await s.call("b2_create_key", {
      keyName: "sdkharness-repl-dest",
      capabilities: ["listFiles", "writeFiles"],
      bucketIds: [destination.id],
      idempotencyKey: `sdkharness-dest-${destination.name}`,
      confirm: true,
    });
    for (const key of [sourceKey, destinationKey]) {
      check(
        typeof key.applicationKeyId === "string" && key.applicationKeyId.length > 0,
        `b2_create_key returned no applicationKeyId: ${JSON.stringify(key).slice(0, 160)}`,
      );
    }
    s.cleanup(async () => {
      for (const key of [sourceKey, destinationKey]) {
        await s.call("b2_delete_key", { applicationKeyId: key.applicationKeyId, confirm: true });
      }
    });

    s.step("the destination maps the source key to its own");
    await s.call("b2_update_bucket", {
      bucketId: destination.id,
      replicationConfiguration: {
        asReplicationDestination: {
          sourceToDestinationKeyMapping: {
            [sourceKey.applicationKeyId]: destinationKey.applicationKeyId,
          },
        },
      },
      confirm: true,
    });
    const dest = (await bucketInfo(s, destination)).replicationConfiguration;
    eq(
      "destination mapping in a fresh listing",
      { [sourceKey.applicationKeyId]: destinationKey.applicationKeyId },
      dest?.asReplicationDestination?.sourceToDestinationKeyMapping,
    );
    check(!dest?.asReplicationSource, "the destination bucket was also listed as a source");

    s.step("the source is given a rule");
    const rule = {
      replicationRuleName: "sdkharness-rule",
      destinationBucketId: destination.id,
      fileNamePrefix: "replicate/",
      includeExistingFiles: false,
      isEnabled: true,
      priority: 1,
    };
    const before = (await bucketInfo(s, source)).revision;
    await s.call("b2_update_bucket", {
      bucketId: source.id,
      replicationConfiguration: {
        asReplicationSource: {
          replicationRules: [rule],
          sourceApplicationKeyId: sourceKey.applicationKeyId,
        },
      },
      confirm: true,
    });
    const listed = await bucketInfo(s, source);
    const configured = listed.replicationConfiguration?.asReplicationSource;
    eq(
      "source key in a fresh listing",
      sourceKey.applicationKeyId,
      configured?.sourceApplicationKeyId,
    );
    eq("rules in a fresh listing", [rule], configured?.replicationRules);
    check(listed.revision > before, `the revision did not grow: ${before} then ${listed.revision}`);

    s.step("the rule can be disabled");
    await s.call("b2_update_bucket", {
      bucketId: source.id,
      replicationConfiguration: {
        asReplicationSource: {
          replicationRules: [{ ...rule, isEnabled: false }],
          sourceApplicationKeyId: sourceKey.applicationKeyId,
        },
      },
      confirm: true,
    });
    eq(
      "isEnabled in a fresh listing",
      false,
      (await bucketInfo(s, source)).replicationConfiguration?.asReplicationSource
        ?.replicationRules?.[0]?.isEnabled,
    );

    s.step("an unknown source key is refused and changes nothing");
    const other = await s.bucket();
    const refused = await s.refused("b2_update_bucket", {
      bucketId: other.id,
      replicationConfiguration: {
        asReplicationSource: {
          replicationRules: [{ ...rule, replicationRuleName: "sdkharness-bad" }],
          sourceApplicationKeyId: "005000000000000000000000000",
        },
      },
      confirm: true,
    });
    check(
      /key|bad_request|400/i.test(refused),
      `the refusal does not name the key: ${refused.slice(0, 160)}`,
    );
    const none = (await bucketInfo(s, other)).replicationConfiguration;
    check(
      !none || (!none.asReplicationSource && !none.asReplicationDestination),
      `a refused update stored a configuration: ${JSON.stringify(none)}`,
    );
  },
  { env: { B2_SECRET_SINK: "inline" } },
);
