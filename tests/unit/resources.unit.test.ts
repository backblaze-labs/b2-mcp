import { B2Client, type BucketInfoResult } from "../../src/b2/client";
import type { McpServer } from "../../src/mcp";
import { createServer, getRegisteredResources, invalidateAuthManagerCache } from "../../src/server";
import { logger } from "../../src/utils/logger";
import {
  testConfig as baseTestConfig,
  DeterministicB2NativeFake,
} from "../support/deterministic-fakes";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { installSdkTransport, StaticHttpResponse } from "../support/sdk-test-helpers";

const CANARY = "B2_MCP_CANARY_SECRET_resource_do_not_leak";
const THIRD_PARTY_SECRET = "third-party-secret-value";

const resourceTestConfig = {
  ...baseTestConfig,
  applicationKey: CANARY,
  appKey: `${CANARY}_app`,
  masterKey: `${CANARY}_master`,
  destructivePolicy: "block" as const,
  credentialFingerprint: "credential-fingerprint",
};

function bucketInfoFixture(
  bucketId: string,
  bucketName: string,
  bucketType = "allPrivate",
): BucketInfoResult {
  return {
    accountId: "test-account-123",
    bucketId,
    bucketName,
    bucketType,
    bucketInfo: { owner: "platform", applicationKey: CANARY },
    corsRules: [],
    defaultServerSideEncryption: { mode: "SSE-B2", algorithm: "AES256" },
    fileLockConfiguration: {
      isClientAuthorizedToRead: true,
      value: {
        isFileLockEnabled: true,
        defaultRetention: {
          mode: "governance",
          period: { duration: 7, unit: "days" },
        },
      },
    },
    lifecycleRules: [{ fileNamePrefix: "logs/", daysFromHidingToDeleting: 30 }],
    replicationConfiguration: {
      asReplicationSource: {
        sourceApplicationKeyId: "source-application-key-id",
        replicationRules: [
          {
            replicationRuleName: "copy-logs",
            destinationBucketId: "dest-bucket-id",
            fileNamePrefix: "logs/",
            includeExistingFiles: false,
            isEnabled: true,
            priority: 1,
          },
        ],
      },
      asReplicationDestination: {
        sourceToDestinationKeyMapping: {
          "source-key-id": "destination-key-id",
        },
      },
    },
    revision: 7,
    options: ["s3"],
  };
}

async function readResource(server: McpServer, uri: string, extra: any = {}) {
  const registry = getRegisteredResources(server);
  if (!registry) throw new Error("No resources registered");

  const staticResource = Object.values(registry.resources).find((resource) => resource.uri === uri);
  if (staticResource) return staticResource.read(new URL(uri), extra);

  for (const template of Object.values(registry.resourceTemplates)) {
    const variables = template.resourceTemplate.uriTemplate.match(uri);
    if (variables) return template.read(new URL(uri), variables, extra);
  }
  throw new Error(`Resource not registered in test helper: ${uri}`);
}

function parseResource(result: any): any {
  return JSON.parse(result.contents[0].text);
}

describe("MCP resources", () => {
  afterEach(() => {
    setB2SdkClientFactoryForTests(null);
    invalidateAuthManagerCache();
    vi.restoreAllMocks();
  });

  it("registers resource templates and docs right-sized to B2 capabilities", () => {
    const readOnly = createServer(resourceTestConfig, ["listBuckets", "readFiles"]);
    const readOnlyRegistry = getRegisteredResources(readOnly);
    expect(Object.keys(readOnlyRegistry?.resources ?? {}).sort()).toEqual([
      "b2_capability_summary",
      "b2_destructive_policy",
      "b2_server_configuration",
      "b2_tool_profile",
    ]);
    expect(readOnlyRegistry?.resourceTemplates.b2_bucket_config).toBeDefined();
    expect(readOnlyRegistry?.resourceTemplates.b2_bucket_config.metadata.cacheHint).toEqual({
      ttlMs: 5_000,
      cacheScope: "private",
    });

    const noBucketRead = createServer(resourceTestConfig, ["readFiles"]);
    expect(
      getRegisteredResources(noBucketRead)?.resourceTemplates.b2_bucket_config,
    ).toBeUndefined();
  });

  it("redacts caller-controlled resource URIs in audit logs", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const server = createServer(resourceTestConfig, ["listBuckets"]);
    const registry = getRegisteredResources(server);
    const resource = registry?.resources.b2_capability_summary;
    expect(resource).toBeDefined();

    await resource?.read(new URL(`b2://capabilities/${CANARY}`), {} as any);

    const audit = infoSpy.mock.calls.find(([, message]) => message === "resource.read")?.[0];
    expect(audit).toMatchObject({
      resource: "b2_capability_summary",
      uri: "b2://capabilities/[redacted]",
    });
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(CANARY);
  });

  it("reads bucket control-plane JSON without exposing notification secrets", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const fake = new DeterministicB2NativeFake({
      capabilities: ["listBuckets", "readBucketNotifications"],
    });
    installSdkTransport(fake);
    fake.respond(
      "b2_list_buckets",
      new StaticHttpResponse(200, {
        buckets: [bucketInfoFixture("bucket-1", "resource-bucket")],
      }),
    );
    fake.respond(
      "b2_get_bucket_notification_rules",
      new StaticHttpResponse(200, {
        bucketId: "bucket-1",
        eventNotificationRules: [
          {
            name: "notify",
            eventTypes: ["b2:ObjectCreated:*"],
            isEnabled: true,
            objectNamePrefix: "logs/",
            targetConfiguration: {
              targetType: "webhook",
              url: "https://hooks.example.com/services/path-secret?token=query-secret#frag-secret",
              hmacSha256SigningSecret: CANARY,
              customHeaders: [{ name: "Authorization", value: `Bearer ${CANARY}` }],
            },
          },
        ],
      }),
    );

    const server = createServer(resourceTestConfig, ["listBuckets", "readBucketNotifications"], {
      oauthScopes: ["b2:admin"],
    });
    const payload = parseResource(await readResource(server, "b2://bucket/resource-bucket"));
    const serialized = JSON.stringify(payload);

    expect(payload.bucket).toMatchObject({
      bucketId: "bucket-1",
      bucketName: "resource-bucket",
      visibility: "private",
      bucketInfo: { applicationKey: "[redacted]" },
      encryption: { defaultServerSideEncryption: { mode: "SSE-B2", algorithm: "AES256" } },
    });
    expect(payload.bucket.replicationConfiguration.asReplicationSource).toMatchObject({
      sourceApplicationKeyId: "[redacted]",
    });
    expect(payload.bucket.replicationConfiguration.asReplicationDestination).toEqual({
      sourceToDestinationKeyMapping: { "[redacted:1]": "[redacted]" },
    });
    expect(payload.eventNotifications.available).toBe(true);
    expect(payload.eventNotifications.eventNotificationRules[0].targetConfiguration).toMatchObject({
      url: "https://[redacted]",
      hmacSha256SigningSecret: "[redacted]",
      customHeaders: [{ name: "Authorization", value: "[redacted]" }],
    });
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain("hooks.example.com");
    expect(serialized).not.toContain("path-secret");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("frag-secret");
    expect(serialized).not.toContain("source-application-key-id");
    expect(serialized).not.toContain("destination-key-id");
    expect(
      infoSpy.mock.calls.find(([, message]) => message === "resource.read")?.[0],
    ).toMatchObject({
      resource: "b2_bucket_config",
      uriPattern: "b2://bucket/{bucketName}",
      uri: "b2://bucket/resource-bucket",
      credential: "credential-fingerprint",
      error: false,
    });
  });

  it("keeps resource reads control-plane-only", async () => {
    const fake = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] });
    installSdkTransport(fake);
    fake.respond(
      "b2_list_buckets",
      new StaticHttpResponse(200, {
        buckets: [bucketInfoFixture("bucket-1", "readonly-bucket")],
      }),
    );

    const server = createServer(resourceTestConfig, ["listBuckets"]);
    const payload = parseResource(await readResource(server, "b2://bucket/readonly-bucket"));

    expect(payload.eventNotifications).toMatchObject({
      available: false,
      reason: "not_permitted",
    });
    expect(fake.requests.map((request) => request.endpoint)).toEqual([
      "b2_authorize_account",
      "b2_list_buckets",
    ]);
    expect(fake.requests.map((request) => request.endpoint).join(" ")).not.toMatch(
      /create|delete|set|update|list_file|download|upload/i,
    );
  });

  it("sanitizes unexpected secret-shaped fields returned by resource dependencies", async () => {
    vi.spyOn(B2Client.prototype, "listBuckets").mockResolvedValue({
      buckets: [bucketInfoFixture("bucket-1", "malicious-bucket")],
    });
    vi.spyOn(B2Client.prototype, "getBucketNotificationRules").mockResolvedValue({
      bucketId: "bucket-1",
      eventNotificationRules: [
        {
          name: "notify",
          eventTypes: ["b2:ObjectCreated:*"],
          isEnabled: true,
          targetConfiguration: {
            targetType: "webhook",
            url: "https://internal-alerts.corp.local/services/path-secret",
            hmacSha256SigningSecret: CANARY,
            customHeaders: { Authorization: `Bearer ${CANARY}` },
            extraSecret: THIRD_PARTY_SECRET,
          },
          injectedSecret: THIRD_PARTY_SECRET,
        } as any,
      ],
      injectedSecret: THIRD_PARTY_SECRET,
    } as any);

    const server = createServer(resourceTestConfig, ["listBuckets", "readBucketNotifications"], {
      oauthScopes: ["b2:admin"],
    });
    const payload = parseResource(await readResource(server, "b2://bucket/malicious-bucket"));
    const serialized = JSON.stringify(payload);

    expect(payload.eventNotifications.eventNotificationRules[0].targetConfiguration).toMatchObject({
      url: "https://[redacted]",
      hmacSha256SigningSecret: "[redacted]",
      customHeaders: { Authorization: "[redacted]" },
      extraSecret: "[redacted]",
    });
    expect(payload.eventNotifications.eventNotificationRules[0].injectedSecret).toBe("[redacted]");
    expect(payload.eventNotifications.injectedSecret).toBe("[redacted]");
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain(THIRD_PARTY_SECRET);
    expect(serialized).not.toContain("internal-alerts.corp.local");
    expect(serialized).not.toContain("path-secret");
  });

  it("degrades bucket resources when optional notification rules are unavailable", async () => {
    const fake = new DeterministicB2NativeFake({
      capabilities: ["listBuckets", "readBucketNotifications"],
    });
    installSdkTransport(fake);
    fake.respond(
      "b2_list_buckets",
      new StaticHttpResponse(200, {
        buckets: [bucketInfoFixture("bucket-1", "partial-bucket")],
      }),
    );
    fake.fail("b2_get_bucket_notification_rules", 503, "server_unavailable", "try again later", 6);

    const server = createServer(resourceTestConfig, ["listBuckets", "readBucketNotifications"], {
      oauthScopes: ["b2:admin"],
    });
    const payload = parseResource(await readResource(server, "b2://bucket/partial-bucket"));

    expect(payload.bucket.bucketName).toBe("partial-bucket");
    expect(payload.eventNotifications).toMatchObject({
      available: false,
      reason: "temporarily_unavailable",
      status: 503,
      code: "server_unavailable",
    });
  });

  it("distinguishes runtime notification auth failures from scope denial", async () => {
    const fake = new DeterministicB2NativeFake({
      capabilities: ["listBuckets", "readBucketNotifications"],
    });
    installSdkTransport(fake);
    fake.respond(
      "b2_list_buckets",
      new StaticHttpResponse(200, {
        buckets: [bucketInfoFixture("bucket-1", "auth-blip-bucket")],
      }),
    );
    fake.fail("b2_get_bucket_notification_rules", 403, "forbidden", "token rejected");

    const server = createServer(resourceTestConfig, ["listBuckets", "readBucketNotifications"], {
      oauthScopes: ["b2:admin"],
    });
    const payload = parseResource(await readResource(server, "b2://bucket/auth-blip-bucket"));

    expect(payload.eventNotifications).toMatchObject({
      available: false,
      reason: "runtime_auth_failure",
      status: 403,
      code: "forbidden",
    });
  });

  it("propagates resource request abort signals into B2 calls", async () => {
    const fake = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] });
    installSdkTransport(fake);
    fake.respond(
      "b2_list_buckets",
      new StaticHttpResponse(200, {
        buckets: [bucketInfoFixture("bucket-1", "warmup-bucket")],
      }),
    );
    const server = createServer(resourceTestConfig, ["listBuckets"]);
    await readResource(server, "b2://bucket/warmup-bucket");

    const controller = new AbortController();
    controller.abort(new Error("client disconnected"));

    await expect(
      readResource(server, "b2://bucket/aborted-bucket", { mcpReq: { signal: controller.signal } }),
    ).rejects.toThrow("client disconnected");
    expect(fake.requestsFor("b2_list_buckets")).toHaveLength(1);
  });

  it("propagates notification-rule aborts instead of degrading them", async () => {
    const fake = new DeterministicB2NativeFake({
      capabilities: ["listBuckets", "readBucketNotifications"],
    });
    installSdkTransport(fake);
    fake.respond(
      "b2_list_buckets",
      new StaticHttpResponse(200, {
        buckets: [bucketInfoFixture("bucket-1", "notification-abort-bucket")],
      }),
    );
    const controller = new AbortController();
    fake.respond("b2_get_bucket_notification_rules", () => {
      controller.abort(new Error("client disconnected during notifications"));
      const error = new Error("SDK request aborted");
      error.name = "AbortError";
      throw error;
    });

    const server = createServer(resourceTestConfig, ["listBuckets", "readBucketNotifications"], {
      oauthScopes: ["b2:admin"],
    });

    await expect(
      readResource(server, "b2://bucket/notification-abort-bucket", {
        mcpReq: { signal: controller.signal },
      }),
    ).rejects.toThrow("client disconnected during notifications");
  });

  it("logs failed backend resource reads with resource identity", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const fake = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] });
    installSdkTransport(fake);
    fake.fail("b2_list_buckets", 500, "server_error", "B2_APPLICATION_KEY=backend-secret", 6);
    const server = createServer(resourceTestConfig, ["listBuckets"]);

    await expect(readResource(server, "b2://bucket/logged-failure")).rejects.toThrow(
      "B2_APPLICATION_KEY=[redacted]",
    );
    expect(
      warnSpy.mock.calls.find(([, message]) => message === "resource.error")?.[0],
    ).toMatchObject({
      resource: "b2_bucket_config",
      uriPattern: "b2://bucket/{bucketName}",
      uri: "b2://bucket/logged-failure",
      credential: "credential-fingerprint",
      error: true,
      status: 500,
      code: "server_error",
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("backend-secret");
  });

  it("summarizes capabilities and configuration without secret material", async () => {
    const server = createServer(resourceTestConfig, ["readFiles", "listBuckets"]);

    const capabilitySummary = parseResource(await readResource(server, "b2://capabilities"));
    expect(capabilitySummary).toMatchObject({
      capabilityFilterActive: true,
      capabilities: ["listBuckets", "readFiles"],
      credentialFingerprint: "credential-fingerprint",
    });

    const configSummary = parseResource(await readResource(server, "b2://server/configuration"));
    expect(configSummary.server).toMatchObject({
      destructivePolicy: "block",
      credentialMode: "stdio-env",
    });
    expect(configSummary.server).not.toHaveProperty("localFileAccess");
    expect(configSummary.server).not.toHaveProperty("secretSinkMode");

    const toolProfile = parseResource(await readResource(server, "b2://server/tool-profile"));
    expect(toolProfile.resource).toBe("tool-profile");
    expect(toolProfile.toolCount).toBeGreaterThan(0);
    expect(toolProfile.tools[0]).toMatchObject({
      name: expect.any(String),
      annotations: expect.objectContaining({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
      }),
    });

    const destructivePolicy = parseResource(
      await readResource(server, "b2://server/destructive-policy"),
    );
    expect(destructivePolicy).toMatchObject({
      resource: "destructive-policy",
      destructivePolicy: "block",
    });
    expect(destructivePolicy.destructiveTools).toContain("b2_delete_bucket");

    const allStaticText = (
      await Promise.all(
        Object.values(getRegisteredResources(server)?.resources ?? {}).map((resource) =>
          resource.read(new URL(resource.uri), {} as any),
        ),
      )
    )
      .map((result: any) => result.contents[0].text)
      .join("\n");
    expect(allStaticText).not.toContain(CANARY);
  });
});
