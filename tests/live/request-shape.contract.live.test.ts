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
 *   npm run test:contract:live
 *
 * The npm script fails fast when B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY
 * are absent. Direct Jest selection skips this file's cases when credentials
 * are absent so a local editor cannot accidentally call B2.
 */

import { loadConfig, createServer, getRegisteredTools } from "../../src/server";
import type { McpServer } from "../../src/mcp";

const HAS_CREDS = !!(process.env.B2_APPLICATION_KEY_ID && process.env.B2_APPLICATION_KEY);
const liveIt = HAS_CREDS ? test : test.skip;

async function callTool(server: McpServer, toolName: string, args: Record<string, unknown>) {
  const tool = getRegisteredTools(server)?.[toolName];
  if (!tool) throw new Error(`Tool not found: ${toolName}`);
  return tool.execute(args, {} as any);
}
function parseResult(result: any): any {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
const isError = (r: any): boolean => r?.isError === true;
const errText = (r: any): string => r?.content?.[0]?.text ?? "";
const isUserWritableBucket = (n: string) =>
  !n.toLowerCase().includes("snapshot") && !n.toLowerCase().startsWith("b2-");

let server: McpServer;
let writableBucketId = "";

function failContractPrerequisite(message: string, detail?: unknown): never {
  const suffix = detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : "";
  throw new Error(`Live contract prerequisite failed - ${message}${suffix}`);
}

beforeAll(async () => {
  if (!HAS_CREDS) return;
  // Integration tests create AND clean up real resources, so disable the
  // destructive-op gate here (it is unit-tested separately).
  server = createServer({ ...loadConfig(), destructivePolicy: "allow" });
  const buckets = parseResult(await callTool(server, "b2_list_buckets", {}));
  if (isError(buckets)) failContractPrerequisite("could not list buckets", errText(buckets));
  const w = (buckets?.buckets ?? []).find((b: any) => isUserWritableBucket(b.bucketName));
  if (w) writableBucketId = w.bucketId;
  if (!writableBucketId) {
    failContractPrerequisite("no user-writable bucket available for notification contract");
  }
});

// ── Object Lock write-shape contract ──────────────────────────────────────────
describe("Contract: notification rules objectNamePrefix", () => {
  liveIt(
    "b2_set_bucket_notification_rules never fails for a missing objectNamePrefix",
    async () => {
      console.log(`  Contract notification bucketId=${writableBucketId}`);
      // Capture existing rules to restore.
      const before = parseResult(
        await callTool(server, "b2_get_bucket_notification_rules", { bucketId: writableBucketId }),
      );
      const original = before?.eventNotificationRules ?? [];
      try {
        const res = await callTool(server, "b2_set_bucket_notification_rules", {
          bucketId: writableBucketId,
          eventNotificationRules: [
            {
              name: "mcp-contract-rule",
              // objectNamePrefix deliberately omitted — the tool must inject "".
              eventTypes: ["b2:ObjectCreated:*"],
              isEnabled: false,
              targetConfiguration: {
                targetType: "webhook",
                url: "https://example.com/contract",
              },
            },
          ],
        });
        // The account may have Event Notifications disabled ("API not enabled") — that is fine.
        // The CONTRACT is only that we never see the objectNamePrefix-missing rejection again.
        expect(errText(res).toLowerCase()).not.toContain("objectnameprefix");
      } finally {
        // Restore whatever was there before (best-effort).
        await callTool(server, "b2_set_bucket_notification_rules", {
          bucketId: writableBucketId,
          eventNotificationRules: original,
        });
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
      const bucketName = `mcp-contract-retrofit-${Date.now().toString(36)}`;
      let bucketId = "";
      console.log(`  Contract bucketName=${bucketName}`);
      try {
        const created = parseResult(
          await callTool(server, "b2_create_bucket", { bucketName, bucketType: "allPrivate" }),
        );
        if (isError(created)) {
          failContractPrerequisite(
            "could not create Object Lock retrofit bucket",
            errText(created),
          );
        }
        bucketId = created.bucketId;
        expect(created.fileLockConfiguration?.value?.isFileLockEnabled).toBe(false);

        // Retrofit: enable Object Lock on the EXISTING bucket (native API allows this).
        const enabled = await callTool(server, "b2_update_bucket", {
          bucketId,
          fileLockEnabled: true,
        });
        expect(isError(enabled)).toBe(false);
        expect(parseResult(enabled).fileLockConfiguration?.value?.isFileLockEnabled).toBe(true);

        // Set the bucket default retention and confirm it took.
        const retained = await callTool(server, "b2_update_bucket", {
          bucketId,
          defaultRetention: { mode: "governance", period: { duration: 7, unit: "days" } },
        });
        expect(isError(retained)).toBe(false);
        const back = parseResult(await callTool(server, "b2_list_buckets", { bucketId })).buckets[0]
          .fileLockConfiguration?.value?.defaultRetention;
        expect(back?.mode).toBe("governance");
        expect(back?.period).toEqual({ duration: 7, unit: "days" });
      } finally {
        if (bucketId) await callTool(server, "b2_delete_bucket", { bucketId });
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
      const bucketName = `mcp-contract-pathb-${Date.now().toString(36)}`;
      let bucketId = "";
      console.log(`  Contract bucketName=${bucketName}`);
      try {
        // (e) SSE-B2 with no algorithm — server must inject algorithm:"AES256"
        //     (regresses to HTTP 400 "Invalid default server-side encryption algorithm" if dropped).
        const created = parseResult(
          await callTool(server, "b2_create_bucket", {
            bucketName,
            bucketType: "allPrivate",
            defaultServerSideEncryption: { mode: "SSE-B2" },
          }),
        );
        if (isError(created)) {
          failContractPrerequisite(
            "could not create SSE/lifecycle contract bucket",
            errText(created),
          );
        }
        expect(isError(created)).toBe(false);
        bucketId = created.bucketId;

        // (c) native lifecycle field daysFromStartingToCancelingUnfinishedLargeFiles.
        const life = await callTool(server, "b2_update_bucket", {
          bucketId,
          lifecycleRules: [
            { fileNamePrefix: "tmp/", daysFromStartingToCancelingUnfinishedLargeFiles: 2 },
          ],
        });
        expect(isError(life)).toBe(false);
      } finally {
        if (bucketId) await callTool(server, "b2_delete_bucket", { bucketId });
      }
    },
    90_000,
  );
});
