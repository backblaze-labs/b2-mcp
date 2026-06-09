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
 * Credentials (same as the integration suite): B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY.
 * Skipped automatically when absent, so this file is safe to run anywhere.
 */

import { loadConfig, createServer } from "../../src/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const HAS_CREDS = !!(process.env.B2_APPLICATION_KEY_ID && process.env.B2_APPLICATION_KEY);
const liveIt = HAS_CREDS ? test : test.skip;

async function callTool(server: McpServer, toolName: string, args: Record<string, unknown>) {
  const tool = (server as any)._registeredTools?.[toolName];
  if (!tool) throw new Error(`Tool not found: ${toolName}`);
  const handler = tool.handler ?? tool.callback ?? tool.execute;
  return handler(args, {} as any);
}
function parseResult(result: any): any {
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

beforeAll(async () => {
  if (!HAS_CREDS) return;
  server = createServer(loadConfig());
  const buckets = parseResult(await callTool(server, "b2_list_buckets", {}));
  const w = (buckets?.buckets ?? []).find((b: any) => isUserWritableBucket(b.bucketName));
  if (w) writableBucketId = w.bucketId;
});

// ── Object Lock write-shape contract ──────────────────────────────────────────
describe("Contract: Object Lock write shapes", () => {
  liveIt(
    "create fileLockEnabled bucket → governance retention → legal hold → immutability, all with B2's request shapes",
    async () => {
      const bucketName = `mcp-contract-lock-${Date.now().toString(36)}`;
      let bucketId = "";
      let fileId = "";
      try {
        // create with fileLockEnabled — the only way to a lock-enabled bucket
        const created = parseResult(
          await callTool(server, "b2_create_bucket", {
            bucketName,
            bucketType: "allPrivate",
            fileLockEnabled: true,
          }),
        );
        if (isError(created)) {
          // Account may not be entitled for Object Lock — skip rather than fail.
          console.log("  Object Lock not available on this account; skipping:", errText(created));
          return;
        }
        bucketId = created.bucketId;
        expect(created.fileLockConfiguration?.value?.isFileLockEnabled).toBe(true);

        const up = parseResult(
          await callTool(server, "b2_upload_file", {
            bucketId,
            fileName: "locked.txt",
            content: Buffer.from("immutable").toString("base64"),
            contentType: "text/plain",
          }),
        );
        expect(isError(up)).toBe(false);
        fileId = up.fileId;

        // CONTRACT: flat fileRetention { mode, retainUntilTimestamp }, no read-only wrapper.
        const setR = await callTool(server, "b2_update_file_retention", {
          fileId,
          fileName: "locked.txt",
          fileRetention: { mode: "governance", retainUntilTimestamp: Date.now() + 120_000 },
        });
        expect(isError(setR)).toBe(false); // would fail with "unknown field isClientAuthorizedToRead" on regression

        const info = parseResult(await callTool(server, "b2_get_file_info", { fileId }));
        expect(info.fileRetention?.value?.mode).toBe("governance");

        // Immutability: delete without bypass must be rejected.
        const delNo = await callTool(server, "b2_delete_file_version", {
          fileName: "locked.txt",
          fileId,
        });
        expect(isError(delNo)).toBe(true);

        // CONTRACT: legalHold is the bare "on"/"off" string.
        const lhOn = await callTool(server, "b2_update_file_legal_hold", {
          fileId,
          fileName: "locked.txt",
          legalHold: "on",
        });
        expect(isError(lhOn)).toBe(false);
        const info2 = parseResult(await callTool(server, "b2_get_file_info", { fileId }));
        expect(info2.legalHold?.value).toBe("on");
        await callTool(server, "b2_update_file_legal_hold", {
          fileId,
          fileName: "locked.txt",
          legalHold: "off",
        });
      } finally {
        // Self-clean: clear governance retention (with bypass), delete the version, delete the bucket.
        if (fileId) {
          await callTool(server, "b2_update_file_retention", {
            fileId,
            fileName: "locked.txt",
            bypassGovernance: true,
            fileRetention: { mode: null, retainUntilTimestamp: null },
          });
          await callTool(server, "b2_delete_file_version", {
            fileName: "locked.txt",
            fileId,
            bypassGovernance: true,
          });
        }
        if (bucketId) await callTool(server, "b2_delete_bucket", { bucketId });
      }
    },
    90_000,
  );
});

// ── Notification rules write-shape contract ───────────────────────────────────
describe("Contract: notification rules objectNamePrefix", () => {
  liveIt(
    "b2_set_bucket_notification_rules never fails for a missing objectNamePrefix",
    async () => {
      if (!writableBucketId) {
        console.log("  No writable bucket; skipping.");
        return;
      }
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
        if (isError(res)) {
          expect(errText(res).toLowerCase()).not.toContain("objectnameprefix");
        }
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

// ── b2_copy_file destination encryption field name ────────────────────────────
describe("Contract: b2_copy_file destination SSE", () => {
  liveIt(
    "copies with destinationServerSideEncryption (B2 rejects the old 'serverSideEncryption' name)",
    async () => {
      if (!writableBucketId) {
        console.log("  No writable bucket; skipping.");
        return;
      }
      let origId = "";
      let copyId = "";
      try {
        const up = parseResult(
          await callTool(server, "b2_upload_file", {
            bucketId: writableBucketId,
            fileName: "__contract/copy-src.txt",
            content: Buffer.from("copy-sse").toString("base64"),
            contentType: "text/plain",
          }),
        );
        expect(isError(up)).toBe(false);
        origId = up.fileId;

        const copy = await callTool(server, "b2_copy_file", {
          sourceFileId: origId,
          fileName: "__contract/copy-dst.txt",
          destinationServerSideEncryption: { mode: "SSE-B2", algorithm: "AES256" },
        });
        // Regression guard: the old 'serverSideEncryption' name returns
        // 400 "unknown field ... B2CopyFileRequest: serverSideEncryption".
        expect(isError(copy)).toBe(false);
        const copied = parseResult(copy);
        copyId = copied.fileId;
        expect(
          copied.serverSideEncryption?.mode ?? copied.serverSideEncryption?.algorithm,
        ).toBeTruthy();
      } finally {
        if (copyId)
          await callTool(server, "b2_delete_file_version", {
            fileName: "__contract/copy-dst.txt",
            fileId: copyId,
          });
        if (origId)
          await callTool(server, "b2_delete_file_version", {
            fileName: "__contract/copy-src.txt",
            fileId: origId,
          });
      }
    },
    60_000,
  );
});

// ── b2_update_bucket Object Lock retrofit + defaultRetention ───────────────────
describe("Contract: b2_update_bucket Object Lock retrofit", () => {
  liveIt(
    "enables Object Lock on an existing bucket and sets defaultRetention via b2_update_bucket",
    async () => {
      const bucketName = `mcp-contract-retrofit-${Date.now().toString(36)}`;
      let bucketId = "";
      try {
        const created = parseResult(
          await callTool(server, "b2_create_bucket", { bucketName, bucketType: "allPrivate" }),
        );
        if (isError(created)) {
          console.log("  Could not create bucket; skipping:", errText(created));
          return;
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

// ── b2_hide_file write shape ──────────────────────────────────────────────────
describe("Contract: b2_hide_file", () => {
  liveIt(
    "hides a file: { bucketId, fileName } is accepted, the name reads as gone, a hide marker appears",
    async () => {
      if (!writableBucketId) {
        console.log("  No writable bucket; skipping.");
        return;
      }
      const fileName = "__contract/hide-me.txt";
      let uploadId = "";
      let hideId = "";
      try {
        const up = parseResult(
          await callTool(server, "b2_upload_file", {
            bucketId: writableBucketId,
            fileName,
            content: Buffer.from("hide-test").toString("base64"),
            contentType: "text/plain",
          }),
        );
        expect(isError(up)).toBe(false);
        uploadId = up.fileId;

        const hidden = await callTool(server, "b2_hide_file", {
          bucketId: writableBucketId,
          fileName,
        });
        expect(isError(hidden)).toBe(false);
        const hideMarker = parseResult(hidden);
        expect(hideMarker.action).toBe("hide");
        hideId = hideMarker.fileId;

        // The visible listing no longer shows the name...
        const names = parseResult(
          await callTool(server, "b2_list_file_names", {
            bucketId: writableBucketId,
            prefix: fileName,
          }),
        );
        expect((names.files ?? []).some((f: any) => f.fileName === fileName)).toBe(false);

        // ...but a hide marker exists in the version history.
        const versions = parseResult(
          await callTool(server, "b2_list_file_versions", {
            bucketId: writableBucketId,
            startFileName: fileName,
            maxFileCount: 5,
          }),
        );
        expect((versions.files ?? []).some((f: any) => f.action === "hide")).toBe(true);
      } finally {
        if (hideId) await callTool(server, "b2_delete_file_version", { fileName, fileId: hideId });
        if (uploadId)
          await callTool(server, "b2_delete_file_version", { fileName, fileId: uploadId });
      }
    },
    60_000,
  );
});
