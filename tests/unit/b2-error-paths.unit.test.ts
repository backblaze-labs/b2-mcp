/**
 * Covers the error (catch) paths across B2-native tool handlers with SDK
 * transport responses that classify to typed B2 errors.
 */

import { createServer, invalidateAuthManagerCache } from "../../src/server";
import { setWebhookDnsLookupForTests } from "../../src/b2/buckets";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import type { McpServer } from "../../src/mcp";
import { callTool, testConfig } from "../support/deterministic-fakes";
import {
  authorizeResponse,
  b2EndpointName,
  installSdkTransport,
  RecordingTransport,
  StaticHttpResponse,
} from "../support/sdk-test-helpers";

let server: McpServer;

const partnerTestConfig = {
  ...testConfig,
  masterKeyId: "master-key-id",
  masterKey: "master-key",
};

function partnerAuthorizeResponse() {
  return {
    accountId: "test-account-123",
    authorizationToken: "partner-token-xyz",
    apiInfo: {
      groupsApi: {
        capabilities: ["all"],
        groupsApiUrl: "http://127.0.0.1/partner",
        infoType: "groupsApi",
      },
    },
    applicationKeyExpirationTimestamp: null,
  };
}

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
  server = createServer(testConfig);
});

afterEach(() => {
  vi.restoreAllMocks();
  setWebhookDnsLookupForTests(null);
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

  it("b2_set_bucket_notification_rules returns a structured SDK error", async () => {
    setWebhookDnsLookupForTests(async () => [{ address: "93.184.216.34" }]);
    const result = await callTool(server, "b2_set_bucket_notification_rules", args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bad_request");
    expect(result.content[0].text).toContain("req-native-error");
  });

  it.each(["b2_list_groups", "b2_eject_group_member", "b2_list_group_members"])(
    "%s returns a structured Partner API error",
    async (tool) => {
      installSdkTransport(
        new RecordingTransport((request) => {
          if (b2EndpointName(request) === "b2_authorize_account") {
            return new StaticHttpResponse(200, partnerAuthorizeResponse());
          }
          return new StaticHttpResponse(
            400,
            { status: 400, code: "bad_request", message: "bad" },
            { "X-Bz-Request-Id": "req-native-error" },
          );
        }),
      );
      server = createServer(partnerTestConfig);
      const result = await callTool(server, tool, {
        adminAccountId: "test-account-123",
        groupId: "g",
        memberAccountId: "m",
        confirm: true,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("bad_request");
      expect(result.content[0].text).toContain("req-native-error");
    },
  );
});
