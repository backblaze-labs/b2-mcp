/**
 * Live request-shape contract tests.
 *
 * These exist because mocked unit tests cannot catch a tool that sends the wrong
 * PAYLOAD SHAPE to B2 — the mock happily accepts whatever the code sends. Two real
 * bugs shipped that way and were only caught by hand:
 *   - b2_set_bucket_notification_rules omitted the required objectNamePrefix.
 *   - b2_update_file_retention / b2_update_file_legal_hold sent the response shape
 *     (isClientAuthorizedToRead/value wrapper) as the request body.
 *
 * Each test below drives the real B2 write API and asserts the contract holds, so a
 * future shape regression fails here instead of in production.
 *
 * Run with:
 *   pnpm run test:live:b2-contract
 *
 * The pnpm script fails fast when B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY
 * are absent. Direct Vitest selection skips this file's cases when credentials
 * are absent so a local editor cannot accidentally call B2.
 */

import { loadConfig, createServer } from "../../src/server";
import type { McpServer } from "../../src/mcp";
import { callTool, parseResult } from "../support/deterministic-fakes";
import {
  contractRuleName,
  createContractBucketTracker,
  type ContractBucketTracker,
  liveErrorText,
  redactedLiveResourceDetail,
  type ContractBucketRef,
} from "./support/contract-buckets";
import { liveB2Evidence } from "../support/live-b2-evidence-types";
import { hasLiveB2Credentials, assertAndSelectLiveB2Test } from "../support/live-b2-test-guard";

const HAS_CREDS = hasLiveB2Credentials();
const liveIt = assertAndSelectLiveB2Test(test);

const isError = (r: any): boolean => r?.isError === true;

let server: McpServer;
let bucketTracker: ContractBucketTracker;

function failContractPrerequisite(message: string, detail?: unknown): never {
  const suffix = detail ? `: ${redactedLiveResourceDetail(detail)}` : "";
  throw new Error(`Live contract prerequisite failed - ${message}${suffix}`);
}

beforeAll(async () => {
  if (!HAS_CREDS) return;
  // Integration tests create AND clean up real resources, so disable the
  // destructive-op gate here (it is unit-tested separately).
  server = createServer({ ...loadConfig(), destructivePolicy: "allow" });
  bucketTracker = createContractBucketTracker(server);
});

afterAll(async () => {
  if (!HAS_CREDS) return;
  await bucketTracker.cleanupAll();
}, 120_000);

// ── Notification rule write-shape contract ────────────────────────────────────
// B2 Event Notifications is a per-bucket entitlement, so this runs against a
// pre-provisioned, notifications-enabled bucket named by B2_LIVE_NOTIFICATION_BUCKET.
// It never creates or deletes the bucket: it sets a rule, asserts the injected
// objectNamePrefix, then clears the rules it added. B2_LIVE_NOTIFICATION_BUCKET is
// required for the live contract suite (no skip), and the running key must hold
// writeBucketNotifications on the account that owns the bucket.
const NOTIFICATION_BUCKET = process.env.B2_LIVE_NOTIFICATION_BUCKET;

describe("Contract: notification rules objectNamePrefix", () => {
  liveIt(
    "b2_set_bucket_notification_rules never fails for a missing objectNamePrefix",
    async () => {
      if (!NOTIFICATION_BUCKET) {
        failContractPrerequisite(
          "B2_LIVE_NOTIFICATION_BUCKET must name a notifications-enabled bucket",
        );
      }
      const listed = await callTool(server, "b2_list_buckets", {
        bucketName: NOTIFICATION_BUCKET,
      });
      if (isError(listed)) {
        failContractPrerequisite(
          "could not list the notification fixture bucket",
          liveErrorText(listed),
        );
      }
      const bucketId = parseResult(listed).buckets?.[0]?.bucketId;
      if (!bucketId) {
        failContractPrerequisite(`notification fixture bucket not found: ${NOTIFICATION_BUCKET}`);
      }
      const ruleName = contractRuleName("notify-rule");
      const existing = await callTool(server, "b2_get_bucket_notification_rules", { bucketId });
      if (isError(existing)) {
        failContractPrerequisite(
          "could not read notification fixture rules",
          liveErrorText(existing),
        );
      }
      const retainedRules = (parseResult(existing).eventNotificationRules ?? []).filter(
        (rule: { name?: string }) => rule.name !== ruleName,
      );
      const runRule = {
        name: ruleName,
        // objectNamePrefix deliberately omitted, so the tool must inject "".
        eventTypes: ["b2:ObjectCreated:*"],
        isEnabled: false,
        targetConfiguration: {
          targetType: "webhook",
          url: "https://example.com/contract",
        },
      };
      try {
        const res = await callTool(server, "b2_set_bucket_notification_rules", {
          bucketId,
          eventNotificationRules: [...retainedRules, runRule],
        });
        if (isError(res)) {
          const detail = liveErrorText(res);
          if (detail.toLowerCase().includes("api not enabled")) {
            failContractPrerequisite("Event Notifications API is unavailable", detail);
          }
          throw new Error(`notification rules shape contract failed: ${detail}`);
        }
        liveB2Evidence.recordLiveResource({
          type: "notification-rule",
          label: "notify-rule",
          name: ruleName,
          id: bucketId,
        });
        const writtenRule = parseResult(res).eventNotificationRules?.find(
          (rule: { name?: string }) => rule.name === ruleName,
        );
        expect(writtenRule?.objectNamePrefix).toBe("");
      } finally {
        // Persistent fixture: restore only the rules that existed before this test.
        const cleanup = await callTool(server, "b2_set_bucket_notification_rules", {
          bucketId,
          eventNotificationRules: retainedRules,
        });
        if (isError(cleanup)) {
          throw new Error(`notification rule cleanup failed: ${liveErrorText(cleanup)}`);
        }
      }
    },
    30_000,
  );
});

// ── b2_update_bucket Object Lock retrofit ─────────────────────────────────────
describe("Contract: b2_update_bucket Object Lock retrofit", () => {
  liveIt(
    "enables Object Lock on an existing bucket and sets defaultRetention via b2_update_bucket",
    async () => {
      const cleanupBucket: ContractBucketRef = { bucketId: "" };
      try {
        const created = await bucketTracker.createBucket("retrofit");
        cleanupBucket.bucketId = created.bucketId;
        cleanupBucket.bucketName = created.bucketName;
        expect(created.fileLockConfiguration?.value?.isFileLockEnabled).toBe(false);

        // Retrofit: enable Object Lock on the EXISTING bucket (native API allows this).
        const enabled = await callTool(server, "b2_update_bucket", {
          bucketId: cleanupBucket.bucketId,
          fileLockEnabled: true,
        });
        expect(isError(enabled)).toBe(false);
        expect(parseResult(enabled).fileLockConfiguration?.value?.isFileLockEnabled).toBe(true);

        // Set the bucket default retention and confirm it took.
        const retained = await callTool(server, "b2_update_bucket", {
          bucketId: cleanupBucket.bucketId,
          defaultRetention: { mode: "governance", period: { duration: 7, unit: "days" } },
        });
        expect(isError(retained)).toBe(false);
        const listed = await callTool(server, "b2_list_buckets", {
          bucketId: cleanupBucket.bucketId,
        });
        if (isError(listed)) {
          failContractPrerequisite(
            "could not list Object Lock retrofit bucket",
            liveErrorText(listed),
          );
        }
        const back = parseResult(listed).buckets[0].fileLockConfiguration?.value?.defaultRetention;
        expect(back?.mode).toBe("governance");
        expect(back?.period).toEqual({ duration: 7, unit: "days" });
      } finally {
        await bucketTracker.cleanupBucket(cleanupBucket);
      }
    },
    90_000,
  );
});

// ── v4 tool-surface alignment ─────────────────────────────────────────────────
describe("Contract: v4 tool-surface alignment", () => {
  liveIt(
    "SSE-B2 default and lifecycle cancel-unfinished field use B2-accepted shapes",
    async () => {
      const cleanupBucket: ContractBucketRef = { bucketId: "" };
      try {
        // (e) SSE-B2 with no algorithm — server must inject algorithm:"AES256"
        //     (regresses to HTTP 400 "Invalid default server-side encryption algorithm" if dropped).
        const created = await bucketTracker.createBucket("pathb", {
          defaultServerSideEncryption: { mode: "SSE-B2" },
        });
        cleanupBucket.bucketId = created.bucketId;
        cleanupBucket.bucketName = created.bucketName;

        // (c) native lifecycle field daysFromStartingToCancelingUnfinishedLargeFiles.
        const life = await callTool(server, "b2_update_bucket", {
          bucketId: cleanupBucket.bucketId,
          lifecycleRules: [
            { fileNamePrefix: "tmp/", daysFromStartingToCancelingUnfinishedLargeFiles: 2 },
          ],
        });
        expect(isError(life)).toBe(false);
      } finally {
        await bucketTracker.cleanupBucket(cleanupBucket);
      }
    },
    90_000,
  );
});
