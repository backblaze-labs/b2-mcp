// keys.crud (partial). Run by ../run-conformance; see ../../README.md.
//
// b2_create_key, b2_list_keys and b2_delete_key against what B2 documents: a created key is listed
// with the name, capabilities, bucket restriction, name prefix and expiry it was given and with no
// secret (B2 returns the applicationKey only in the answer to the create call); a key given a
// validDurationInSeconds carries an expirationTimestamp that far ahead, one without carries null; a
// deleted key is no longer listed and cannot be deleted again.
// https://www.backblaze.com/apidocs/b2-create-key https://www.backblaze.com/apidocs/b2-list-keys
// https://www.backblaze.com/apidocs/b2-delete-key
//
// The cell is `partial`: the card says b2_create_key is registered only when a secret sink is
// configured and is otherwise an unavailable stub. That boundary is asserted both ways. B2 itself
// returns the new key's secret in the create answer; this server sends it to the sink (a file only
// the operator reads) and answers with the marker `[redacted]` plus a pointer, so the secret never
// reaches the agent. That is a documented, intended difference (the tool's own description says
// so), so the check asserts that the secret reached the sink and appears in no answer the agent
// read, and does not expect B2's literal reply. The sink is a temp file of this scenario on the
// loopback simulator with its fixed fake credential, so no real secret exists.
import {
  callRaw,
  check,
  eq,
  runScenario,
  secretSink,
  startServer,
  callRefused,
} from "../lib/session.mjs";

const sink = secretSink();
const DURATION_SECONDS = 3600;

await runScenario(
  "keys.crud",
  async (s) => {
    s.cleanup(async () => sink.remove());
    const read = []; // every answer text the agent saw, scanned for the secret at the end
    const raw = async (name, args) => {
      const out = await callRaw(s.client, name, args);
      read.push(out.text);
      return out.json;
    };
    const listed = async () => (await raw("b2_list_keys", { maxKeyCount: 1000 })).keys;
    const find = async (id) => (await listed()).find((k) => k.applicationKeyId === id);

    s.step("account id");
    const accountId = (await raw("b2_authorize_account", {})).accountId;
    check(typeof accountId === "string" && accountId.length > 0, "authorize returned no accountId");
    const bucket = await s.bucket();

    s.step("create a key restricted to a bucket, a prefix and a lifetime");
    const before = Date.now();
    const created = await raw("b2_create_key", {
      keyName: "sdkharness-keys-crud",
      capabilities: ["listFiles", "readFiles"],
      bucketIds: [bucket.id],
      namePrefix: "docs/",
      validDurationInSeconds: DURATION_SECONDS,
      idempotencyKey: `sdkharness-keys-crud-${bucket.name}`,
      confirm: true,
    });
    const id = created.applicationKeyId;
    check(typeof id === "string" && id.length > 0, "b2_create_key returned no applicationKeyId");
    s.cleanup(async () => {
      if (await find(id)) await s.call("b2_delete_key", { applicationKeyId: id, confirm: true });
    });
    eq("created keyName", "sdkharness-keys-crud", created.keyName);
    eq("created accountId", accountId, created.accountId);

    s.step("the secret went to the sink and not to the agent");
    const record = sink.records().find((r) => r.result?.applicationKeyId === id);
    const secret = record?.result?.applicationKey;
    check(
      typeof secret === "string" && secret.length >= 8,
      `the sink holds no secret for the new key (${JSON.stringify(record ?? null).slice(0, 160)})`,
    );
    check(
      created.applicationKey !== secret,
      "b2_create_key answered the agent with the real secret",
    );
    check(
      created.secretSink?.type === "file",
      `the create answer has no pointer to the sink: ${JSON.stringify(created.secretSink)}`,
    );

    s.step("listed with what it was given and no secret");
    const key = await find(id);
    check(key, "the new key is not in b2_list_keys");
    eq("listed keyName", "sdkharness-keys-crud", key.keyName);
    eq("listed accountId", accountId, key.accountId);
    eq("listed capabilities", ["listFiles", "readFiles"], [...key.capabilities].sort());
    eq("listed bucketIds", [bucket.id], key.bucketIds);
    eq("listed namePrefix", "docs/", key.namePrefix);
    check(!("applicationKey" in key), "b2_list_keys returned an applicationKey field");
    const expected = before + DURATION_SECONDS * 1000;
    check(
      Number.isInteger(key.expirationTimestamp) &&
        Math.abs(key.expirationTimestamp - expected) < 10 * 60 * 1000,
      `expirationTimestamp ${key.expirationTimestamp} is not about ${DURATION_SECONDS} s after creation (${expected})`,
    );

    s.step("a key without prefix or lifetime lists null for both");
    const open = await raw("b2_create_key", {
      keyName: "sdkharness-keys-crud-open",
      capabilities: ["listFiles"],
      bucketIds: [bucket.id],
      idempotencyKey: `sdkharness-keys-crud-open-${bucket.name}`,
      confirm: true,
    });
    s.cleanup(async () => {
      if (await find(open.applicationKeyId)) {
        await s.call("b2_delete_key", { applicationKeyId: open.applicationKeyId, confirm: true });
      }
    });
    const openListed = await find(open.applicationKeyId);
    eq("open key namePrefix", null, openListed?.namePrefix);
    eq("open key expirationTimestamp", null, openListed?.expirationTimestamp);

    s.step("delete");
    await raw("b2_delete_key", { applicationKeyId: id, confirm: true });
    check(!(await find(id)), "the deleted key is still in b2_list_keys");
    check(await find(open.applicationKeyId), "deleting one key removed the other");
    const again = await s.refused("b2_delete_key", { applicationKeyId: id, confirm: true });
    check(/Key not found|bad_request/.test(again), `a second delete said: ${again.slice(0, 160)}`);

    s.step("no answer the agent read holds the secret");
    check(
      !read.some((text) => text.includes(secret)),
      "the secret appears in an answer the agent read",
    );

    s.step("without a sink b2_create_key is an unavailable stub and makes nothing");
    const bare = await startServer("sdkharness-conformance-keys.crud-nosink");
    try {
      const refused = await callRefused(bare, "b2_create_key", {
        keyName: "sdkharness-keys-crud-stub",
        capabilities: ["listFiles"],
        bucketIds: [bucket.id],
        idempotencyKey: `sdkharness-keys-crud-stub-${bucket.name}`,
        confirm: true,
      });
      check(
        /unavailable/.test(refused) && /secret sink/.test(refused),
        `the stub did not say it needs a secret sink: ${refused.slice(0, 200)}`,
      );
    } finally {
      await bare.close().catch(() => undefined);
    }
    check(
      !(await listed()).some((k) => k.keyName === "sdkharness-keys-crud-stub"),
      "the unavailable stub created a key",
    );
  },
  { env: sink.env },
);
