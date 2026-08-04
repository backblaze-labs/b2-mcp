/**
 * Covers the error (catch) paths across B2-native tool handlers with SDK
 * transport responses that classify to typed B2 errors.
 */

import { createServer, getRegisteredTools, invalidateAuthManagerCache } from "../../src/server";
import { setB2SdkClientFactoryForTests } from "../../src/auth";
import type { McpServer } from "../../src/mcp";
import { B2Config } from "../../src/utils/types";
import {
  authorizeResponse,
  b2EndpointName,
  installSdkTransport,
  RecordingTransport,
  StaticHttpResponse,
} from "./sdk-test-helpers";

const config: B2Config = {
  applicationKeyId: "k",
  applicationKey: "s",
  appKeyId: "k",
  appKey: "s",
  masterKeyId: "s",
  masterKey: "s",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
};

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  const tool = getRegisteredTools(server)?.[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.execute(args, {} as any);
}

let server: McpServer;

beforeEach(() => {
  invalidateAuthManagerCache();
  installSdkTransport(
    new RecordingTransport((request) => {
      if (b2EndpointName(request) === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["listBuckets"]));
      }
      return new StaticHttpResponse(
        400,
        { status: 400, code: "bad_request", message: "bad" },
        { "X-Bz-Request-Id": "req-native-error" },
      );
    }),
  );
  server = createServer(config);
});

afterEach(() => {
  setB2SdkClientFactoryForTests(null);
  invalidateAuthManagerCache();
});

describe("B2 tool error paths (catch blocks)", () => {
  const args = {
    applicationKeyId: "a",
    bucketId: "b",
    bucketName: "bk",
    bucketType: "allPrivate",
    eventNotificationRules: [
      {
        name: "r",
        eventTypes: ["b2:ObjectCreated:*"],
        isEnabled: true,
        targetConfiguration: { targetType: "webhook", url: "https://example.com/hook" },
      },
    ],
    fileId: "f",
    fileName: "n",
    legalHold: "on",
    fileRetention: { mode: "governance", retainUntilTimestamp: 1 },
    confirm: true,
  };

  const nativeTools = [
    "b2_list_buckets",
    "b2_create_bucket",
    "b2_delete_bucket",
    "b2_update_bucket",
    "b2_get_bucket_notification_rules",
    "b2_set_bucket_notification_rules",
    "b2_list_keys",
    "b2_delete_key",
    "b2_update_file_legal_hold",
    "b2_update_file_retention",
  ];

  it.each(nativeTools)("%s returns a structured SDK error", async (tool) => {
    const result = await callTool(server, tool, args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bad_request");
    expect(result.content[0].text).toContain("req-native-error");
  });

  it.each(["b2_list_groups", "b2_eject_group_member", "b2_list_group_members"])(
    "%s returns an explicit SDK-gap error",
    async (tool) => {
      const result = await callTool(server, tool, {
        adminAccountId: "a",
        groupId: "g",
        memberAccountId: "m",
        confirm: true,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("tool_unavailable");
    },
  );
});
