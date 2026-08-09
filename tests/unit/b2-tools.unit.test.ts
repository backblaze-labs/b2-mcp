import {
  B2Client as SdkB2Client,
  BucketType,
  BufferSource,
  LegalHoldValue,
  RetentionMode,
} from "@backblaze-labs/b2-sdk";
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";
import { createServer, getRegisteredTools, invalidateAuthManagerCache } from "../../src/server";
import { setWebhookDnsLookupForTests } from "../../src/b2/buckets";
import { B2AuthManager } from "../../src/auth";
import { B2Client } from "../../src/b2/client";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import type { McpServer } from "../../src/mcp";
import { callTool, parseResult, testConfig } from "../support/deterministic-fakes";
import {
  authorizeResponse,
  b2EndpointName,
  installSdkTransport,
  RecordingTransport,
  requestJson,
  StaticHttpResponse,
} from "../support/sdk-test-helpers";

let sim: B2Simulator;
let seed: SdkB2Client;
let server: McpServer;

async function seedClient(): Promise<SdkB2Client> {
  const client = new SdkB2Client({
    applicationKeyId: testConfig.applicationKeyId,
    applicationKey: testConfig.applicationKey,
    transport: sim.transport(),
    retry: {
      maxRetries: 0,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    },
  });
  await client.authorize();
  return client;
}

async function createBucket(
  name: string,
  bucketType: BucketType = BucketType.AllPrivate,
  options: Record<string, unknown> = {},
) {
  return seed.createBucket({ bucketName: name, bucketType, ...options } as never);
}

beforeEach(async () => {
  invalidateAuthManagerCache();
  sim = new B2Simulator({ minimumPartSize: 1000, recommendedPartSize: 1000 });
  installSdkTransport(sim.transport());
  seed = await seedClient();
  server = createServer(testConfig);
});

afterEach(() => {
  vi.restoreAllMocks();
  setWebhookDnsLookupForTests(null);
  setB2SdkClientFactoryForTests(null);
  invalidateAuthManagerCache();
});

describe("B2Client S3 version guard", () => {
  it("resolves bulk version checks with one bucket lookup per request", async () => {
    invalidateAuthManagerCache();
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["listBuckets", "listFiles"]));
      }
      if (endpoint === "b2_list_buckets") {
        return new StaticHttpResponse(200, {
          buckets: [
            {
              accountId: "test-account-123",
              bucketId: "bucket-1",
              bucketName: "bulk-bucket",
              bucketType: "allPrivate",
              bucketInfo: {},
              corsRules: [],
              lifecycleRules: [],
              revision: 1,
              options: [],
            },
          ],
        });
      }
      if (endpoint === "b2_get_file_info") {
        const body = requestJson(request);
        const id = String(body.fileId);
        return new StaticHttpResponse(200, {
          accountId: "test-account-123",
          bucketId: "bucket-1",
          fileId: id,
          fileName: id === "version-a" ? "a.txt" : "b.txt",
          action: "upload",
          contentLength: 1,
          contentSha1: "none",
          contentType: "text/plain",
          fileInfo: {},
          uploadTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
        });
      }
      return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
    });
    installSdkTransport(transport);
    const client = new B2Client(new B2AuthManager(testConfig));

    const result = await client.resolveS3FileVersions({
      bucket: "bulk-bucket",
      objects: [
        { key: "a.txt", versionId: "version-a" },
        { key: "b.txt", versionId: "version-b" },
        { key: "latest.txt" },
      ],
    });

    expect(result).toHaveLength(3);
    expect(result[0].version?.fileId).toBe("version-a");
    expect(result[1].version?.fileId).toBe("version-b");
    expect(result[2].version).toBeNull();
    expect(
      transport.requests.filter((request) => b2EndpointName(request) === "b2_list_buckets"),
    ).toHaveLength(1);
    expect(
      transport.requests.filter((request) => b2EndpointName(request) === "b2_get_file_info"),
    ).toHaveLength(2);
  });
});

describe("b2_authorize_account", () => {
  it("returns account metadata and redacts the authorization token", async () => {
    const result = parseResult(await callTool(server, "b2_authorize_account", {}));
    expect(result.accountId).toBe("sim_account_0001");
    expect(result.downloadUrl).toBeTruthy();
    expect(result.authorizationToken).toBeUndefined();
  });
});

describe("SDK 401 re-auth-and-retry", () => {
  it("re-authorizes and retries on an expired auth token", async () => {
    await createBucket("reauth-bucket");
    sim.injectFailure({
      on: "b2_list_buckets",
      status: 401,
      code: "expired_auth_token",
      message: "expired",
      count: 1,
    });

    const result = parseResult(await callTool(server, "b2_list_buckets", {}));
    expect(result.buckets.map((b: any) => b.bucketName)).toContain("reauth-bucket");
  });

  it("re-authorizes and retries raw SDK calls on an expired auth token", async () => {
    const bucket = await createBucket("raw-reauth-bucket");
    await bucket.upload({
      fileName: "large.bin",
      source: new BufferSource(new TextEncoder().encode("x")),
    });
    sim.injectFailure({
      on: "b2_list_file_names",
      status: 401,
      code: "expired_auth_token",
      message: "expired",
      count: 1,
    });

    const result = parseResult(
      await callTool(server, "b2_largest_files", {
        bucket: "raw-reauth-bucket",
        limit: 1,
        max_scan: 1000,
      }),
    );

    expect(result.files[0].name).toBe("large.bin");
  });

  it("syncs cached auth after raw 401 recovery so the next raw call uses the fresh token", async () => {
    invalidateAuthManagerCache();
    let authorizeCalls = 0;
    const listFileAuthHeaders: string[] = [];
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        authorizeCalls++;
        return new StaticHttpResponse(200, {
          ...authorizeResponse(["listBuckets", "listFiles"]),
          authorizationToken: authorizeCalls === 1 ? "expired-token" : "fresh-token",
        });
      }
      if (endpoint === "b2_list_buckets") {
        return new StaticHttpResponse(200, {
          buckets: [
            {
              accountId: "test-account-123",
              bucketId: "bucket-1",
              bucketName: "raw-cache-bucket",
              bucketType: "allPrivate",
              bucketInfo: {},
              corsRules: [],
              lifecycleRules: [],
              revision: 1,
              options: [],
            },
          ],
        });
      }
      if (endpoint === "b2_list_file_names") {
        const authHeader = String(request.headers?.Authorization ?? "");
        listFileAuthHeaders.push(authHeader);
        if (authHeader === "expired-token") {
          return new StaticHttpResponse(401, {
            status: 401,
            code: "expired_auth_token",
            message: "expired",
          });
        }
        return new StaticHttpResponse(200, {
          files: [
            {
              accountId: "test-account-123",
              bucketId: "bucket-1",
              fileId: "file-1",
              fileName: "fresh.bin",
              action: "upload",
              contentLength: 1,
              contentSha1: "none",
              contentType: "b2/x-auto",
              fileInfo: {},
              uploadTimestamp: Date.parse("2021-01-01T00:00:00.000Z"),
            },
          ],
          nextFileName: null,
        });
      }
      return new StaticHttpResponse(200, {});
    });
    installSdkTransport(transport);
    server = createServer(testConfig);

    for (let i = 0; i < 2; i++) {
      const result = parseResult(
        await callTool(server, "b2_largest_files", {
          bucket: "raw-cache-bucket",
          limit: 1,
          max_scan: 1000,
        }),
      );
      expect(result.files[0].name).toBe("fresh.bin");
    }

    expect(authorizeCalls).toBe(2);
    expect(listFileAuthHeaders).toEqual(["expired-token", "fresh-token", "fresh-token"]);
  });

  it("surfaces repeated auth failures as a structured tool error", async () => {
    sim.injectFailure({
      on: "b2_list_buckets",
      status: 401,
      code: "expired_auth_token",
      message: "still expired",
    });

    const result = await callTool(server, "b2_list_buckets", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("expired_auth_token");
  });
});

describe("b2_list_buckets", () => {
  it("returns buckets and supports bucketTypes filtering", async () => {
    await createBucket("private-bucket", BucketType.AllPrivate);
    await createBucket("public-bucket", BucketType.AllPublic);

    const result = parseResult(
      await callTool(server, "b2_list_buckets", { bucketTypes: ["allPrivate"] }),
    );

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].bucketName).toBe("private-bucket");
  });

  it("honors the all bucketTypes wildcard instead of narrowing it away", async () => {
    invalidateAuthManagerCache();
    const bucketTypesByRequest: unknown[] = [];
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["listBuckets"]));
      }
      if (endpoint === "b2_list_buckets") {
        const body = typeof request.body === "string" ? JSON.parse(request.body) : {};
        bucketTypesByRequest.push(body.bucketTypes);
        return new StaticHttpResponse(200, {
          buckets: [
            {
              accountId: "test-account-123",
              bucketId: "bucket-snapshot",
              bucketName: "snapshot-bucket",
              bucketType: "snapshot",
              bucketInfo: {},
              corsRules: [],
              lifecycleRules: [],
              revision: 1,
              options: [],
            },
          ],
        });
      }
      return new StaticHttpResponse(200, {});
    });
    installSdkTransport(transport);
    server = createServer(testConfig);

    const allOnly = parseResult(
      await callTool(server, "b2_list_buckets", { bucketTypes: ["all"] }),
    );
    const mixed = parseResult(
      await callTool(server, "b2_list_buckets", { bucketTypes: ["allPublic", "all"] }),
    );

    expect(allOnly.buckets[0].bucketType).toBe("snapshot");
    expect(mixed.buckets[0].bucketType).toBe("snapshot");
    expect(bucketTypesByRequest).toEqual([["all"], ["all"]]);
  });

  it("caps to the requested limit and reports truncation", async () => {
    for (let i = 0; i < 12; i++) await createBucket(`bucket-${String(i).padStart(2, "0")}`);

    const result = parseResult(await callTool(server, "b2_list_buckets", { limit: 5 }));

    expect(result.buckets).toHaveLength(5);
    expect(result.bucket_count).toBe(5);
    expect(result.total_bucket_count).toBe(12);
    expect(result.truncated).toBe(true);
    expect(result.note).toContain("first 5 of 12");
  });
});

describe("b2_create_bucket", () => {
  it("creates a bucket and defaults SSE-B2 algorithm", async () => {
    const result = parseResult(
      await callTool(server, "b2_create_bucket", {
        bucketName: "created-bucket",
        bucketType: "allPrivate",
        defaultServerSideEncryption: { mode: "SSE-B2" },
      }),
    );

    expect(result.bucketName).toBe("created-bucket");
    expect(result.defaultServerSideEncryption.algorithm).toBe("AES256");
  });

  it("forwards fileLockEnabled at creation", async () => {
    const result = parseResult(
      await callTool(server, "b2_create_bucket", {
        bucketName: "locked-bucket",
        bucketType: "allPrivate",
        fileLockEnabled: true,
      }),
    );

    expect(result.fileLockConfiguration.value.isFileLockEnabled).toBe(true);
  });
});

describe("b2_delete_bucket", () => {
  it("deletes an empty bucket with confirmation", async () => {
    const bucket = await createBucket("delete-me");

    const result = parseResult(
      await callTool(server, "b2_delete_bucket", {
        bucketId: bucket.id,
        confirm: true,
      }),
    );

    expect(result.bucketId).toBe(bucket.id);
  });

  it("is blocked without confirm under the default policy", async () => {
    const bucket = await createBucket("confirm-delete");
    const result = await callTool(server, "b2_delete_bucket", { bucketId: bucket.id });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/confirm/i);
  });
});

describe("durable-secret-producing tools", () => {
  it("keeps stale tool names callable as non-secret unavailable stubs", async () => {
    const tools = getRegisteredTools(server) ?? {};
    for (const name of [
      "b2_create_key",
      "b2_create_group_member",
      "b2_reserve_trial_create_account",
    ]) {
      expect(tools[name]).toBeDefined();
      const result = await callTool(server, name, { keyName: "stale-client" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("tool_unavailable");
      expect(result.content[0].text).not.toContain("mock-token-xyz");
    }
  });
});

describe("b2_list_keys and b2_delete_key", () => {
  it("lists application-key metadata and deletes a key with confirmation", async () => {
    const created = await seed.createKey({
      keyName: "readonly",
      capabilities: ["readFiles", "listBuckets"],
    });

    const listed = parseResult(await callTool(server, "b2_list_keys", {}));
    expect(listed.keys.map((key: any) => key.keyName)).toContain("readonly");
    expect(JSON.stringify(listed)).not.toContain(created.applicationKey);

    const deleted = parseResult(
      await callTool(server, "b2_delete_key", {
        applicationKeyId: created.applicationKeyId,
        confirm: true,
      }),
    );
    expect(deleted.applicationKeyId).toBe(created.applicationKeyId);
  });
});

describe("native SDK DTO boundaries", () => {
  it("drops unreviewed secret-bearing SDK fields before tool serialization", async () => {
    invalidateAuthManagerCache();
    installSdkTransport(
      new RecordingTransport((request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          return new StaticHttpResponse(
            200,
            authorizeResponse(["listBuckets", "listKeys", "listFiles", "writeFileLegalHolds"]),
          );
        }
        if (endpoint === "b2_list_buckets") {
          return new StaticHttpResponse(200, {
            buckets: [
              {
                accountId: "test-account-123",
                bucketId: "bucket-1",
                bucketName: "dto-bucket",
                bucketType: "allPrivate",
                bucketInfo: {},
                corsRules: [],
                lifecycleRules: [],
                options: [],
                revision: 1,
                injectedSecret: "bucket-secret",
              },
            ],
          });
        }
        if (endpoint === "b2_list_keys") {
          return new StaticHttpResponse(200, {
            keys: [
              {
                keyName: "dto-key",
                applicationKeyId: "key-1",
                capabilities: ["readFiles"],
                accountId: "test-account-123",
                expirationTimestamp: null,
                bucketIds: null,
                bucketId: null,
                namePrefix: null,
                options: [],
                applicationKey: "key-secret",
              },
            ],
            nextApplicationKeyId: null,
            injectedSecret: "list-secret",
          });
        }
        if (endpoint === "b2_list_file_names") {
          return new StaticHttpResponse(200, {
            files: [
              {
                accountId: "test-account-123",
                bucketId: "bucket-1",
                fileId: "file-1",
                fileName: "large.bin",
                action: "upload",
                contentLength: 42,
                contentSha1: "none",
                contentType: "b2/x-auto",
                fileInfo: {},
                uploadTimestamp: Date.parse("2021-01-01T00:00:00.000Z"),
                injectedSecret: "file-secret",
              },
            ],
            nextFileName: null,
            injectedSecret: "page-secret",
          });
        }
        if (endpoint === "b2_update_file_legal_hold") {
          return new StaticHttpResponse(200, {
            fileName: "large.bin",
            fileId: "file-1",
            legalHold: "off",
            injectedSecret: "hold-secret",
          });
        }
        return new StaticHttpResponse(200, {});
      }),
    );
    server = createServer(testConfig);

    const outputs = [
      parseResult(await callTool(server, "b2_list_buckets", {})),
      parseResult(await callTool(server, "b2_list_keys", {})),
      parseResult(
        await callTool(server, "b2_largest_files", {
          bucket: "dto-bucket",
          limit: 1,
          max_scan: 1000,
        }),
      ),
      parseResult(
        await callTool(server, "b2_update_file_legal_hold", {
          fileId: "file-1",
          fileName: "large.bin",
          legalHold: "off",
          confirm: true,
        }),
      ),
    ];
    const serialized = JSON.stringify(outputs);

    expect(serialized).not.toContain("bucket-secret");
    expect(serialized).not.toContain("key-secret");
    expect(serialized).not.toContain("list-secret");
    expect(serialized).not.toContain("file-secret");
    expect(serialized).not.toContain("page-secret");
    expect(serialized).not.toContain("hold-secret");
  });
});

describe("Error propagation", () => {
  it("b2_list_keys returns isError for SDK B2 errors", async () => {
    sim.injectFailure({
      on: "b2_list_keys",
      status: 400,
      code: "bad_request",
      message: "Bad request.",
    });

    const result = await callTool(server, "b2_list_keys", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bad_request");
    expect(result.content[0].text).toContain("400");
  });
});

describe("b2_update_bucket", () => {
  const replicationConfiguration = {
    asReplicationSource: {
      replicationRules: [
        {
          replicationRuleName: "copy-all",
          destinationBucketId: "dest-bucket-id",
          isEnabled: true,
          priority: 1,
        },
      ],
      sourceApplicationKeyId: "source-key-id",
    },
  };

  it("updates bucket metadata and Object Lock settings", async () => {
    const bucket = await createBucket("update-bucket", BucketType.AllPrivate, {
      fileLockEnabled: true,
    });
    const defaultRetention = { mode: "governance", period: { duration: 7, unit: "days" } };

    const result = parseResult(
      await callTool(server, "b2_update_bucket", {
        bucketId: bucket.id,
        bucketType: "allPublic",
        fileLockEnabled: true,
        defaultRetention,
        confirm: true,
      }),
    );

    expect(result.bucketId).toBe(bucket.id);
    expect(result.bucketType).toBe("allPublic");
    expect(result.defaultRetention).toEqual(defaultRetention);
    expect(result.fileLockConfiguration.value.isFileLockEnabled).toBe(true);
  });

  it("blocks replication updates without confirmation before SDK update", async () => {
    invalidateAuthManagerCache();
    const transport = new RecordingTransport((request) => {
      throw new Error(`unexpected ${b2EndpointName(request)}`);
    });
    installSdkTransport(transport);
    server = createServer(testConfig);

    const result = await callTool(server, "b2_update_bucket", {
      bucketId: "bucket-1",
      replicationConfiguration,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/confirm/i);
    expect(result.content[0].text).toMatch(/replication/i);
    expect(transport.requests).toHaveLength(0);
  });

  it("blocks replication updates under block policy even with confirmation", async () => {
    invalidateAuthManagerCache();
    const transport = new RecordingTransport((request) => {
      throw new Error(`unexpected ${b2EndpointName(request)}`);
    });
    installSdkTransport(transport);
    server = createServer({ ...testConfig, destructivePolicy: "block" });

    const result = await callTool(server, "b2_update_bucket", {
      bucketId: "bucket-1",
      replicationConfiguration,
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/blocked/i);
    expect(transport.requests).toHaveLength(0);
  });
});

describe("bucket notification rules", () => {
  beforeEach(() => {
    setWebhookDnsLookupForTests(async () => [{ address: "93.184.216.34" }]);
  });

  it("sets, gets, and redacts notification secrets", async () => {
    const bucket = await createBucket("notify-bucket");
    const rules = [
      {
        name: "on-upload",
        eventTypes: ["b2:ObjectCreated:*"],
        isEnabled: true,
        targetConfiguration: {
          targetType: "webhook",
          url: "https://hooks.slack.com/services/T000/B000/slack-path-token?token=query-token#frag-token",
          hmacSha256SigningSecret: "supersecret",
          customHeaders: [{ name: "Authorization", value: "Bearer webhook-token" }],
        },
      },
    ];

    const set = parseResult(
      await callTool(server, "b2_set_bucket_notification_rules", {
        bucketId: bucket.id,
        eventNotificationRules: rules,
        confirm: true,
      }),
    );
    expect(set.eventNotificationRules[0].objectNamePrefix).toBe("");
    expect(set.eventNotificationRules[0].targetConfiguration.url).toBe(
      "https://hooks.slack.com/[redacted]",
    );
    expect(JSON.stringify(set)).not.toContain("webhook-token");
    expect(JSON.stringify(set)).not.toContain("slack-path-token");
    expect(JSON.stringify(set)).not.toContain("query-token");
    expect(JSON.stringify(set)).not.toContain("frag-token");
    expect(set.eventNotificationRules[0].targetConfiguration.customHeaders).toEqual({
      Authorization: "[redacted]",
    });

    const get = parseResult(
      await callTool(server, "b2_get_bucket_notification_rules", { bucketId: bucket.id }),
    );
    const tc = get.eventNotificationRules[0].targetConfiguration;
    expect(tc.hmacSha256SigningSecret).toBe("[redacted]");
    expect(tc.url).toBe("https://hooks.slack.com/[redacted]");
    expect(tc.customHeaders).toEqual({ Authorization: "[redacted]" });
    expect(JSON.stringify(get)).not.toContain("supersecret");
    expect(JSON.stringify(get)).not.toContain("webhook-token");
    expect(JSON.stringify(get)).not.toContain("slack-path-token");
    expect(JSON.stringify(get)).not.toContain("query-token");
    expect(JSON.stringify(get)).not.toContain("frag-token");
  });

  it("scrubs stored webhook URL credentials and record custom headers", async () => {
    invalidateAuthManagerCache();
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["readBucketNotifications"]));
      }
      if (endpoint === "b2_get_bucket_notification_rules") {
        return new StaticHttpResponse(200, {
          bucketId: "bucket-1",
          eventNotificationRules: [
            {
              name: "stored-secret-rule",
              eventTypes: ["b2:ObjectCreated:*"],
              isEnabled: true,
              isSuspended: false,
              objectNamePrefix: "",
              suspensionReason: "",
              targetConfiguration: {
                targetType: "webhook",
                url: "https://ops:pa55w0rd@hooks.example.com/b2/slack-token?token=query-token#fragment-token",
                customHeaders: {
                  Authorization: "Bearer stored-token",
                  "X-Api-Key": "stored-key",
                },
                extraSecret: "target-secret",
              },
              injectedSecret: "rule-secret",
            },
          ],
          injectedSecret: "notification-secret",
        });
      }
      return new StaticHttpResponse(200, {});
    });
    installSdkTransport(transport);
    server = createServer(testConfig);

    const get = parseResult(
      await callTool(server, "b2_get_bucket_notification_rules", { bucketId: "bucket-1" }),
    );

    const json = JSON.stringify(get);
    expect(json).not.toContain("pa55w0rd");
    expect(json).not.toContain("slack-token");
    expect(json).not.toContain("query-token");
    expect(json).not.toContain("fragment-token");
    expect(json).not.toContain("stored-token");
    expect(json).not.toContain("stored-key");
    expect(json).not.toContain("target-secret");
    expect(json).not.toContain("rule-secret");
    expect(json).not.toContain("notification-secret");
    expect(get.eventNotificationRules[0].targetConfiguration.url).toBe(
      "https://hooks.example.com/[redacted]",
    );
    expect(get.eventNotificationRules[0].targetConfiguration.customHeaders).toEqual({
      Authorization: "[redacted]",
      "X-Api-Key": "[redacted]",
    });
  });

  const ruleWith = (url: string) => ({
    name: "r",
    eventTypes: ["b2:ObjectCreated:*"],
    isEnabled: true,
    targetConfiguration: { targetType: "webhook" as const, url },
  });

  it("blocks notification-rule updates without confirmation before SDK update", async () => {
    invalidateAuthManagerCache();
    const transport = new RecordingTransport((request) => {
      throw new Error(`unexpected ${b2EndpointName(request)}`);
    });
    installSdkTransport(transport);
    server = createServer(testConfig);

    const result = await callTool(server, "b2_set_bucket_notification_rules", {
      bucketId: "bucket-1",
      eventNotificationRules: [ruleWith("https://attacker.example.com/hook")],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/confirm/i);
    expect(result.content[0].text).toMatch(/webhook/i);
    expect(transport.requests).toHaveLength(0);
  });

  it("blocks notification-rule updates under block policy even with confirmation", async () => {
    invalidateAuthManagerCache();
    const transport = new RecordingTransport((request) => {
      throw new Error(`unexpected ${b2EndpointName(request)}`);
    });
    installSdkTransport(transport);
    server = createServer({ ...testConfig, destructivePolicy: "block" });

    const result = await callTool(server, "b2_set_bucket_notification_rules", {
      bucketId: "bucket-1",
      eventNotificationRules: [ruleWith("https://attacker.example.com/hook")],
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/blocked/i);
    expect(transport.requests).toHaveLength(0);
  });

  it("rejects a non-HTTPS webhook URL", async () => {
    const bucket = await createBucket("notify-http");
    const res = await callTool(server, "b2_set_bucket_notification_rules", {
      bucketId: bucket.id,
      eventNotificationRules: [ruleWith("http://example.com/hook")],
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/https/i);
  });

  it("rejects internal/SSRF webhook URL forms", async () => {
    const bucket = await createBucket("notify-ssrf");
    for (const url of [
      "https://169.254.169.254/latest/meta-data",
      "https://127.1/hook",
      "https://127.0.1/hook",
      "https://2130706433/hook",
      "https://0x7f000001/hook",
      "https://0177.0.0.1/hook",
      "https://100.64.0.1/hook",
      "https://198.18.0.1/hook",
      "https://224.0.0.1/hook",
      "https://240.0.0.1/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[fec0::1]/hook",
      "https://[fe80::1%25en0]/hook",
      "https://[ff02::1]/hook",
    ]) {
      const res = await callTool(server, "b2_set_bucket_notification_rules", {
        bucketId: bucket.id,
        eventNotificationRules: [ruleWith(url)],
        confirm: true,
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/private|loopback|numeric|IPv6|non-public/i);
    }
  });

  it("rejects webhook hostnames that resolve to private addresses", async () => {
    setWebhookDnsLookupForTests(async () => [{ address: "10.0.0.7" }]);
    const bucket = await createBucket("notify-dns-ssrf");

    const res = await callTool(server, "b2_set_bucket_notification_rules", {
      bucketId: bucket.id,
      eventNotificationRules: [ruleWith("https://customer.example.com/hook")],
      confirm: true,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/resolve|non-public|public IP/i);
  });

  it("rejects webhook URLs with embedded credentials", async () => {
    const bucket = await createBucket("notify-userinfo");
    const res = await callTool(server, "b2_set_bucket_notification_rules", {
      bucketId: bucket.id,
      eventNotificationRules: [
        ruleWith("https://ops:pa55w0rd@example.com/hook/path-token?token=query-token#frag-token"),
      ],
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/credentials/i);
    expect(res.content[0].text).not.toContain("pa55w0rd");
    expect(res.content[0].text).not.toContain("path-token");
    expect(res.content[0].text).not.toContain("query-token");
    expect(res.content[0].text).not.toContain("frag-token");
  });
});

describe("object lock tools", () => {
  async function seedLockedFile(fileName: string) {
    const bucket = await seed.createBucket({
      bucketName: `lock-${fileName.replace(/[^a-z0-9-]/gi, "-")}`,
      bucketType: BucketType.AllPrivate,
      fileLockEnabled: true,
    });
    return bucket.upload({
      fileName,
      source: new BufferSource(new TextEncoder().encode("x")),
      fileRetention: {
        mode: RetentionMode.Governance,
        retainUntilTimestamp: Date.now() + 365 * 24 * 60 * 60 * 1000,
      },
      legalHold: LegalHoldValue.On,
    });
  }

  it("updates legal hold through the SDK raw object-lock endpoint", async () => {
    const file = await seedLockedFile("doc.pdf");

    const result = parseResult(
      await callTool(server, "b2_update_file_legal_hold", {
        fileId: file.fileId,
        fileName: file.fileName,
        legalHold: "off",
        confirm: true,
      }),
    );

    expect(result.legalHold).toBe("off");
  });

  it("updates and clears file retention through the SDK raw object-lock endpoint", async () => {
    const file = await seedLockedFile("audit.log");
    const retentionTimestamp = Date.now() + 400 * 24 * 60 * 60 * 1000;

    const updated = parseResult(
      await callTool(server, "b2_update_file_retention", {
        fileId: file.fileId,
        fileName: file.fileName,
        fileRetention: { mode: "governance", retainUntilTimestamp: retentionTimestamp },
        bypassGovernance: true,
        confirm: true,
      }),
    );
    expect(updated.fileRetention.mode).toBe("governance");

    const cleared = parseResult(
      await callTool(server, "b2_update_file_retention", {
        fileId: file.fileId,
        fileName: file.fileName,
        fileRetention: { mode: null, retainUntilTimestamp: null },
        bypassGovernance: true,
        confirm: true,
      }),
    );
    expect(cleared.fileRetention.mode).toBeNull();
  });
});

describe("Partner API tools", () => {
  function mockPartnerFetch(response: unknown) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  it("lists groups through the Partner API adapter", async () => {
    const fetchSpy = mockPartnerFetch({
      groups: [{ groupId: "254", groupName: "engineering" }],
      nextGroupId: null,
    });
    const tools = getRegisteredTools(server) ?? {};
    expect(tools.b2_list_groups.description).not.toMatch(/Unavailable compatibility stub/);

    const result = parseResult(
      await callTool(server, "b2_list_groups", {
        adminAccountId: "test-account-123",
        groupName: "engineering",
        startGroupId: 10,
        maxGroupCount: 25,
      }),
    );
    const url = new URL(String(fetchSpy.mock.calls[0][0]));

    expect(result.groups[0].groupName).toBe("engineering");
    expect(url.pathname).toBe("/b2api/v3/b2_list_groups");
    expect(url.searchParams.get("adminAccountId")).toBe("test-account-123");
    expect(url.searchParams.get("groupName")).toBe("engineering");
    expect(url.searchParams.get("startGroupId")).toBe("10");
    expect(url.searchParams.get("maxGroupCount")).toBe("25");
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe("GET");
  });

  it("lists group members through the Partner API adapter", async () => {
    const fetchSpy = mockPartnerFetch({
      members: [{ accountId: "member-account-xyz", email: "member@example.com" }],
      nextEmail: null,
    });

    const result = parseResult(
      await callTool(server, "b2_list_group_members", {
        adminAccountId: "test-account-123",
        groupId: "254",
        startEmail: "a@example.com",
        maxMemberCount: 50,
      }),
    );
    const url = new URL(String(fetchSpy.mock.calls[0][0]));

    expect(result.members[0].email).toBe("member@example.com");
    expect(url.pathname).toBe("/b2api/v3/b2_list_group_members");
    expect(url.searchParams.get("adminAccountId")).toBe("test-account-123");
    expect(url.searchParams.get("groupId")).toBe("254");
    expect(url.searchParams.get("startEmail")).toBe("a@example.com");
    expect(url.searchParams.get("maxMemberCount")).toBe("50");
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe("GET");
  });

  it("ejects a group member through the Partner API adapter when confirmed", async () => {
    const fetchSpy = mockPartnerFetch({
      accountId: "member-account-xyz",
      ejected: true,
    });

    const result = parseResult(
      await callTool(server, "b2_eject_group_member", {
        adminAccountId: "test-account-123",
        groupId: "254",
        memberAccountId: "member-account-xyz",
        email: "new@example.com",
        confirm: true,
      }),
    );
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));

    expect(result.ejected).toBe(true);
    expect(new URL(String(fetchSpy.mock.calls[0][0])).pathname).toBe(
      "/b2api/v3/b2_eject_group_member",
    );
    expect(init.method).toBe("POST");
    expect(body).toMatchObject({
      adminAccountId: "test-account-123",
      groupId: "254",
      memberAccountId: "member-account-xyz",
      email: "new@example.com",
    });
  });

  it("blocks unconfirmed group member ejection before the API call", async () => {
    const fetchSpy = mockPartnerFetch({ ejected: true });

    const result = await callTool(server, "b2_eject_group_member", {
      adminAccountId: "test-account-123",
      groupId: "254",
      memberAccountId: "member-account-xyz",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Confirmation required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
