// bucket.notification_rules (yes). Run by ../run-conformance; see ../../README.md.
//
// b2_set_bucket_notification_rules and b2_get_bucket_notification_rules against what B2 documents:
// a bucket starts with no rules; a set stores exactly the rules given (name, object name prefix,
// event types, enabled, webhook target) and replaces the whole set, it does not add to it; a read
// returns what was stored; rule names are unique per bucket; an empty set clears them. The server
// also refuses a webhook URL that is not https or that points at a non-public address, before B2 is called.
// https://www.backblaze.com/apidocs/b2-set-bucket-notification-rules
// https://www.backblaze.com/apidocs/b2-get-bucket-notification-rules
// https://www.backblaze.com/docs/cloud-storage-event-notifications
//
// Documented intended difference, NOT a failure: B2 documents returning the webhook target in full,
// the HMAC signing secret and the custom header values included. This server redacts the URL host
// and path, the signing secret and the header values in every answer, so an agent never reads them
// (the tool descriptions say so). The check therefore asserts that the secrets given are absent from
// every answer and that the redaction marker stands in their place, and asserts everything else B2
// returns (name, prefix, event types, enabled, target type) exactly. Nothing is delivered: the
// rules are stored by the simulator and no webhook is called.
import { randomBytes } from "node:crypto";
import { check, eq, runScenario } from "../lib/session.mjs";

await runScenario("bucket.notification_rules", async (s) => {
  const tag = randomBytes(6).toString("hex");
  const secret = randomBytes(16).toString("hex"); // 32 characters, the length B2 documents for a signing secret
  const headerValue = `hv-${tag}`;
  const pathMarker = `hook-${tag}`;
  const host = "93.184.216.34"; // a public address; nothing connects to it
  const seen = []; // every answer text the agent read

  const rulesIn = async (bucket) => {
    const out = await s.client.callTool({
      name: "b2_get_bucket_notification_rules",
      arguments: { bucketId: bucket.id },
    });
    const text = out.content.map((part) => part.text ?? "").join("");
    check(!out.isError, `b2_get_bucket_notification_rules: ${text.slice(0, 200)}`);
    seen.push(text);
    return JSON.parse(text).eventNotificationRules;
  };
  const set = async (bucket, rules) => {
    const out = await s.client.callTool({
      name: "b2_set_bucket_notification_rules",
      arguments: { bucketId: bucket.id, eventNotificationRules: rules, confirm: true },
    });
    const text = out.content.map((part) => part.text ?? "").join("");
    seen.push(text);
    return { isError: out.isError === true, text };
  };
  const rule = (name, options = {}) => ({
    name,
    objectNamePrefix: options.prefix ?? "",
    eventTypes: options.eventTypes ?? ["b2:ObjectCreated:*"],
    isEnabled: options.isEnabled ?? true,
    targetConfiguration: {
      targetType: "webhook",
      url: options.url ?? `https://${host}/${pathMarker}?token=${tag}`,
      ...(options.secret ? { hmacSha256SigningSecret: secret } : {}),
      ...(options.header ? { customHeaders: [{ name: "X-Sdkharness", value: headerValue }] } : {}),
    },
  });

  s.step("a new bucket has no rules");
  const bucket = await s.bucket();
  s.cleanup(async () => {
    await set(bucket, []);
  });
  eq("rules of a new bucket", [], await rulesIn(bucket));

  s.step("set two rules");
  const ruleOne = rule("sdkharness-rule-one", {
    prefix: "in/",
    eventTypes: ["b2:ObjectCreated:*"],
    secret: true,
    header: true,
  });
  const ruleTwo = rule("sdkharness-rule-two", {
    eventTypes: ["b2:ObjectDeleted:*"],
    isEnabled: false,
  });
  const stored = await set(bucket, [ruleOne, ruleTwo]);
  check(!stored.isError, `the set was refused: ${stored.text.slice(0, 200)}`);

  s.step("read back what was stored");
  const byName = async () => Object.fromEntries((await rulesIn(bucket)).map((r) => [r.name, r]));
  const got = await byName();
  eq("rule names", ["sdkharness-rule-one", "sdkharness-rule-two"], Object.keys(got).sort());
  eq("rule one prefix", "in/", got["sdkharness-rule-one"].objectNamePrefix);
  eq("rule one event types", ["b2:ObjectCreated:*"], got["sdkharness-rule-one"].eventTypes);
  eq("rule one enabled", true, got["sdkharness-rule-one"].isEnabled);
  eq("rule one target type", "webhook", got["sdkharness-rule-one"].targetConfiguration.targetType);
  eq("rule two prefix", "", got["sdkharness-rule-two"].objectNamePrefix);
  eq("rule two event types", ["b2:ObjectDeleted:*"], got["sdkharness-rule-two"].eventTypes);
  eq("rule two enabled", false, got["sdkharness-rule-two"].isEnabled);
  eq("rule two target type", "webhook", got["sdkharness-rule-two"].targetConfiguration.targetType);

  s.step("the secrets given are in no answer");
  for (const [what, value] of [
    ["the signing secret", secret],
    ["the header value", headerValue],
    ["the URL path", pathMarker],
    ["the URL query", tag],
    ["the URL host", host],
  ]) {
    check(
      !seen.some((text) => text.includes(value)),
      `${what} appears in an answer the agent read`,
    );
  }
  const target = got["sdkharness-rule-one"].targetConfiguration;
  check(
    target.hmacSha256SigningSecret !== secret,
    "the signing secret field holds the secret itself",
  );

  s.step("a set replaces the whole set");
  const replaced = await set(bucket, [rule("sdkharness-rule-three")]);
  check(!replaced.isError, `the replacing set was refused: ${replaced.text.slice(0, 200)}`);
  eq("rules after a replacing set", ["sdkharness-rule-three"], Object.keys(await byName()));

  s.step("refused sets change nothing");
  const http = await set(bucket, [rule("sdkharness-rule-http", { url: `http://${host}/hook` })]);
  check(
    http.isError && /https/.test(http.text),
    `an http URL was not refused: ${http.text.slice(0, 160)}`,
  );
  const loopback = await set(bucket, [
    rule("sdkharness-rule-local", { url: "https://127.0.0.1/hook" }),
  ]);
  check(
    loopback.isError && /non-public/.test(loopback.text),
    `a loopback URL was not refused: ${loopback.text.slice(0, 160)}`,
  );
  const twice = await set(bucket, [rule("sdkharness-rule-same"), rule("sdkharness-rule-same")]);
  check(
    twice.isError && /unique/.test(twice.text),
    `a repeated rule name was not refused: ${twice.text.slice(0, 160)}`,
  );
  eq("rules after the refused sets", ["sdkharness-rule-three"], Object.keys(await byName()));

  s.step("an empty set clears the rules");
  const cleared = await set(bucket, []);
  check(!cleared.isError, `the clearing set was refused: ${cleared.text.slice(0, 200)}`);
  eq("rules after clearing", [], await rulesIn(bucket));
});
