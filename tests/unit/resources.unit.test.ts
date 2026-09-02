import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ReadResourceResult } from "@modelcontextprotocol/server";
import {
  BUCKET_RESOURCE_LIST_LIMIT,
  BUCKET_RESOURCE_TEMPLATE_URI,
  CAPABILITIES_RESOURCE_URI,
  type BucketResourcePayload,
  type CapabilitiesResourcePayload,
  SERVER_CONFIG_RESOURCE_URI,
  type ServerConfigResourcePayload,
} from "../../src/resources";
import {
  createServer,
  invalidateAuthManagerCache,
  type CreateServerOptions,
} from "../../src/server";
import { logger } from "../../src/utils/logger";
import { annotationsForTool } from "../../src/utils/tool-capabilities";
import type { B2Config } from "../../src/utils/types";
import type { MockInstance } from "vitest";
import {
  b2ErrorResponse,
  DeterministicB2NativeFake,
  testConfig,
} from "../support/deterministic-fakes";
import { installSdkTransport, StaticHttpResponse } from "../support/sdk-test-helpers";

const CANARY_SECRET = "B2_MCP_CANARY_SECRET_resource_do_not_leak";

function bucketInfoFixture(bucketId: string, bucketName: string) {
  return {
    accountId: "account-123",
    bucketId,
    bucketName,
    bucketType: "allPrivate",
    bucketInfo: {},
    corsRules: [
      {
        corsRuleName: "browser-read",
        allowedOrigins: ["https://app.example.com"],
        allowedHeaders: ["authorization"],
        allowedOperations: ["s3_get"],
        exposeHeaders: ["x-bz-content-sha1"],
        maxAgeSeconds: 600,
      },
    ],
    defaultServerSideEncryption: {
      isClientAuthorizedToRead: true,
      value: { mode: "SSE-B2", algorithm: "AES256" },
    },
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
    lifecycleRules: [
      {
        fileNamePrefix: "logs/",
        daysFromHidingToDeleting: 30,
      },
    ],
    options: ["s3"],
    revision: 3,
    replicationConfiguration: {
      isClientAuthorizedToRead: true,
      value: {
        asReplicationSource: {
          sourceApplicationKeyId: "replication-key-id",
          replicationRules: [
            {
              replicationRuleName: "replicate-logs",
              destinationBucketId: "dest-bucket-id",
              fileNamePrefix: "logs/",
              includeExistingFiles: false,
              isEnabled: true,
              priority: 1,
            },
          ],
        },
        asReplicationDestination: null,
      },
    },
  };
}

function notificationRulesFixture(bucketId: string) {
  return {
    bucketId,
    eventNotificationRules: [
      {
        name: "object-created",
        eventTypes: ["b2:ObjectCreated:*"],
        isEnabled: true,
        objectNamePrefix: "logs/",
        targetConfiguration: {
          targetType: "webhook",
          url: `https://${CANARY_SECRET}.hooks.example.com/${CANARY_SECRET}`,
          hmacSha256SigningSecret: CANARY_SECRET,
          customHeaders: [{ name: "Authorization", value: CANARY_SECRET }],
        },
      },
    ],
  };
}

async function connectResourceClient(
  options: {
    capabilities?: string[] | null;
    config?: B2Config;
    serverOptions?: CreateServerOptions;
    fake?: DeterministicB2NativeFake;
  } = {},
) {
  const fake =
    options.fake ??
    new DeterministicB2NativeFake({
      capabilities: options.capabilities ?? undefined,
    });
  installSdkTransport(fake);
  const server = createServer(
    options.config ?? testConfig,
    options.capabilities,
    options.serverOptions,
  );
  const client = new Client(
    { name: "b2-mcp-resource-test", version: "1.0.0" },
    { defaultCacheTtlMs: 0 },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    fake,
    async close() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

function resourceText(result: ReadResourceResult): string {
  expect(result.contents).toHaveLength(1);
  const [content] = result.contents;
  expect(content.mimeType).toBe("application/json");
  expect("text" in content).toBe(true);
  return String("text" in content ? content.text : "");
}

function parseJsonResource<T extends object>(result: ReadResourceResult): T {
  return JSON.parse(resourceText(result)) as T;
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

const SERVER_CONFIG_KEYS = [
  "credentialMode",
  "destructivePolicy",
  "publicUrl",
  "schemaVersion",
  "secretSinkMode",
  "transport",
  "uri",
  "version",
] as const;

const CAPABILITIES_KEYS = [
  "activeToolProfile",
  "capabilities",
  "capabilityFiltering",
  "schemaVersion",
  "uri",
] as const;

const ACTIVE_TOOL_PROFILE_KEYS = [
  "destructiveToolCount",
  "mode",
  "readOnlyToolCount",
  "toolCount",
  "toolNames",
] as const;

const BUCKET_RESOURCE_KEYS = [
  "bucketId",
  "bucketName",
  "bucketType",
  "corsRules",
  "defaultRetention",
  "defaultServerSideEncryption",
  "eventNotifications",
  "lifecycleRules",
  "objectLock",
  "replicationConfiguration",
  "schemaVersion",
  "uri",
  "visibility",
] as const;

describe("MCP control-plane resources", () => {
  const previousEnv = {
    B2_HTTP_CREDENTIAL_MODE: process.env.B2_HTTP_CREDENTIAL_MODE,
    B2_MCP_PUBLIC_URL: process.env.B2_MCP_PUBLIC_URL,
    B2_OAUTH_RESOURCE: process.env.B2_OAUTH_RESOURCE,
  };
  let infoSpy: MockInstance;
  let warnSpy: MockInstance;

  beforeEach(() => {
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    invalidateAuthManagerCache();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("lists and reads static server and capability resources without secrets", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "principal";
    process.env.B2_MCP_PUBLIC_URL = "https://mcp.example.com/mcp";
    const config = {
      ...testConfig,
      transport: "http",
      destructivePolicy: "block",
      secretSink: { mode: "off" },
    } satisfies B2Config;
    const { client, close } = await connectResourceClient({ capabilities: [], config });

    try {
      const listed = await client.listResources(undefined, { cacheMode: "refresh" });
      const uris = listed.resources.map((resource) => resource.uri).sort();
      expect(uris).toEqual([CAPABILITIES_RESOURCE_URI, SERVER_CONFIG_RESOURCE_URI]);

      const serverConfig = parseJsonResource<ServerConfigResourcePayload>(
        await client.readResource({ uri: SERVER_CONFIG_RESOURCE_URI }, { cacheMode: "refresh" }),
      );
      expect(sortedKeys(serverConfig)).toEqual([...SERVER_CONFIG_KEYS]);
      expect(serverConfig).toMatchObject({
        schemaVersion: 1,
        uri: SERVER_CONFIG_RESOURCE_URI,
        version: expect.any(String),
        transport: "http",
        credentialMode: "principal",
        destructivePolicy: "block",
        secretSinkMode: "off",
        publicUrl: "https://mcp.example.com/mcp",
      });
      expect(JSON.stringify(serverConfig)).not.toContain(testConfig.applicationKey);

      const capabilities = parseJsonResource<CapabilitiesResourcePayload>(
        await client.readResource({ uri: CAPABILITIES_RESOURCE_URI }, { cacheMode: "refresh" }),
      );
      expect(sortedKeys(capabilities)).toEqual([...CAPABILITIES_KEYS]);
      expect(sortedKeys(capabilities.activeToolProfile)).toEqual([...ACTIVE_TOOL_PROFILE_KEYS]);
      expect(capabilities).toMatchObject({
        schemaVersion: 1,
        uri: CAPABILITIES_RESOURCE_URI,
        capabilityFiltering: "enabled",
        capabilities: [],
        activeToolProfile: {
          mode: "capability-filtered",
          toolCount: expect.any(Number),
          toolNames: expect.arrayContaining(["b2_authorize_account"]),
        },
      });
      const expectedReadOnlyCount = capabilities.activeToolProfile.toolNames.filter(
        (name) => annotationsForTool(name).readOnlyHint,
      ).length;
      const expectedDestructiveCount = capabilities.activeToolProfile.toolNames.filter(
        (name) => annotationsForTool(name).destructiveHint,
      ).length;
      expect(capabilities.activeToolProfile.readOnlyToolCount).toBe(expectedReadOnlyCount);
      expect(capabilities.activeToolProfile.destructiveToolCount).toBe(expectedDestructiveCount);
      expect(JSON.stringify(capabilities)).not.toContain(testConfig.applicationKey);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "b2_server_config",
          uri: SERVER_CONFIG_RESOURCE_URI,
          operation: "resources/read",
          credential: expect.any(String),
          durationMs: expect.any(Number),
          error: false,
        }),
        "resource.call",
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "b2_capabilities",
          uri: CAPABILITIES_RESOURCE_URI,
          operation: "resources/read",
          credential: expect.any(String),
          durationMs: expect.any(Number),
          error: false,
        }),
        "resource.call",
      );
    } finally {
      await close();
    }
  });

  it("lists bucket resources and reads bucket config with notification secrets redacted", async () => {
    const bucket = bucketInfoFixture("bucket-id-1", "resource-bucket");
    bucket.corsRules[0].allowedOrigins = [testConfig.applicationKey];
    const fake = new DeterministicB2NativeFake({
      capabilities: ["listBuckets", "readBucketNotifications"],
    })
      .respond("b2_list_buckets", new StaticHttpResponse(200, { buckets: [bucket] }))
      .respond("b2_list_buckets", new StaticHttpResponse(200, { buckets: [bucket] }))
      .respond(
        "b2_get_bucket_notification_rules",
        new StaticHttpResponse(200, notificationRulesFixture("bucket-id-1")),
      );
    const {
      client,
      fake: transport,
      close,
    } = await connectResourceClient({
      capabilities: ["listBuckets", "readBucketNotifications"],
      fake,
    });

    try {
      const listed = await client.listResources(undefined, { cacheMode: "refresh" });
      expect(listed.resources.map((resource) => resource.uri).sort()).toEqual([
        "b2://bucket/resource-bucket",
        CAPABILITIES_RESOURCE_URI,
        SERVER_CONFIG_RESOURCE_URI,
      ]);

      const templates = await client.listResourceTemplates(undefined, { cacheMode: "refresh" });
      expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toContain(
        BUCKET_RESOURCE_TEMPLATE_URI,
      );

      const raw = await client.readResource(
        { uri: "b2://bucket/resource-bucket" },
        { cacheMode: "refresh" },
      );
      const text = resourceText(raw);
      expect(text).not.toContain(CANARY_SECRET);
      expect(text).not.toContain(testConfig.applicationKey);

      const resource = parseJsonResource<BucketResourcePayload>(raw);
      expect(sortedKeys(resource)).toEqual([...BUCKET_RESOURCE_KEYS]);
      expect(sortedKeys(resource.eventNotifications)).toEqual([
        "isClientAuthorizedToRead",
        "value",
      ]);
      expect(resource).toMatchObject({
        bucketName: "resource-bucket",
        bucketId: "bucket-id-1",
        bucketType: "allPrivate",
        visibility: "private",
        corsRules: [{ allowedOrigins: ["[redacted]"] }],
        defaultServerSideEncryption: { mode: "SSE-B2", algorithm: "AES256" },
        objectLock: {
          isClientAuthorizedToRead: true,
          value: { isFileLockEnabled: true },
        },
        eventNotifications: {
          isClientAuthorizedToRead: true,
          value: {
            eventNotificationRules: [
              {
                targetConfiguration: {
                  url: "https://[redacted]/[redacted]",
                  hmacSha256SigningSecret: "[redacted]",
                  customHeaders: { Authorization: "[redacted]" },
                },
              },
            ],
          },
        },
      });

      const endpoints = transport.requests.map((request) => request.endpoint);
      expect(endpoints).toEqual([
        "b2_authorize_account",
        "b2_list_buckets",
        "b2_list_buckets",
        "b2_get_bucket_notification_rules",
      ]);
      expect(endpoints.some((endpoint) => /create|update|set|delete/i.test(endpoint))).toBe(false);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "b2_bucket",
          uri: BUCKET_RESOURCE_TEMPLATE_URI,
          operation: "resources/list",
          credential: expect.any(String),
          durationMs: expect.any(Number),
          error: false,
        }),
        "resource.call",
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "b2_bucket",
          uri: "b2://bucket/resource-bucket",
          operation: "resources/read",
          credential: expect.any(String),
          durationMs: expect.any(Number),
          error: false,
        }),
        "resource.call",
      );
    } finally {
      await close();
    }
  });

  it("omits notification rules when the credential cannot read them", async () => {
    const bucket = bucketInfoFixture("bucket-id-2", "bucket-without-notification-cap");
    const fake = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] }).respond(
      "b2_list_buckets",
      new StaticHttpResponse(200, { buckets: [bucket] }),
    );
    const {
      client,
      fake: transport,
      close,
    } = await connectResourceClient({
      capabilities: ["listBuckets"],
      fake,
    });

    try {
      const resource = parseJsonResource<BucketResourcePayload>(
        await client.readResource(
          { uri: "b2://bucket/bucket-without-notification-cap" },
          { cacheMode: "refresh" },
        ),
      );
      expect(sortedKeys(resource)).toEqual([...BUCKET_RESOURCE_KEYS]);
      expect(resource.eventNotifications).toEqual({
        isClientAuthorizedToRead: false,
        value: null,
      });
      expect(transport.requests.map((request) => request.endpoint)).toEqual([
        "b2_authorize_account",
        "b2_list_buckets",
      ]);
    } finally {
      await close();
    }
  });

  it("returns bucket config when the secondary notification lookup fails", async () => {
    const bucket = bucketInfoFixture("bucket-id-3", "bucket-with-notification-outage");
    const fake = new DeterministicB2NativeFake({
      capabilities: ["listBuckets", "readBucketNotifications"],
    })
      .respond("b2_list_buckets", new StaticHttpResponse(200, { buckets: [bucket] }))
      .respond(
        "b2_get_bucket_notification_rules",
        b2ErrorResponse(
          503,
          "notification_rules_unavailable",
          `temporary ${testConfig.applicationKey}`,
          { "x-bz-request-id": "notify-req-7" },
        ),
      );
    const { client, close } = await connectResourceClient({
      capabilities: ["listBuckets", "readBucketNotifications"],
      fake,
    });

    try {
      const raw = await client.readResource(
        { uri: "b2://bucket/bucket-with-notification-outage" },
        { cacheMode: "refresh" },
      );
      const text = resourceText(raw);
      expect(text).not.toContain(testConfig.applicationKey);
      const resource = parseJsonResource<BucketResourcePayload>(raw);

      expect(resource.bucketName).toBe("bucket-with-notification-outage");
      expect(resource.eventNotifications).toEqual({
        isClientAuthorizedToRead: true,
        value: null,
        unavailable: true,
        error: {
          code: "notification_rules_unavailable",
          status: 503,
          requestId: "notify-req-7",
        },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "b2_bucket",
          uri: "b2://bucket/bucket-with-notification-outage",
          operation: "b2_get_bucket_notification_rules",
          credential: expect.any(String),
          durationMs: expect.any(Number),
          error: true,
          code: "notification_rules_unavailable",
          status: 503,
          requestId: "notify-req-7",
          err: expect.stringContaining("[redacted]"),
        }),
        "resource.dependency_error",
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "b2_bucket",
          uri: "b2://bucket/bucket-with-notification-outage",
          operation: "resources/read",
          error: false,
        }),
        "resource.call",
      );
    } finally {
      await close();
    }
  });

  it("logs provider metadata when a bucket resource read fails", async () => {
    const fake = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] }).respond(
      "b2_list_buckets",
      b2ErrorResponse(503, "bucket_list_down", `failed ${testConfig.applicationKey}`, {
        "x-bz-request-id": "bucket-read-req-9",
      }),
    );
    const { client, close } = await connectResourceClient({
      capabilities: ["listBuckets"],
      fake,
    });

    try {
      await expect(
        client.readResource({ uri: "b2://bucket/unavailable" }, { cacheMode: "refresh" }),
      ).rejects.toThrow(/failed \[redacted\]/);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "b2_bucket",
          uri: "b2://bucket/unavailable",
          operation: "resources/read",
          credential: expect.any(String),
          durationMs: expect.any(Number),
          error: true,
          code: "bucket_list_down",
          status: 503,
          requestId: "bucket-read-req-9",
          err: expect.stringContaining("[redacted]"),
        }),
        "resource.error",
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(testConfig.applicationKey);
    } finally {
      await close();
    }
  });

  it("caps bucket resources/list for large bucket namespaces", async () => {
    const buckets = Array.from({ length: BUCKET_RESOURCE_LIST_LIMIT + 25 }, (_, index) =>
      bucketInfoFixture(
        `bucket-id-${index}`,
        `resource-bucket-${index.toString().padStart(3, "0")}`,
      ),
    );
    const fake = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] }).respond(
      "b2_list_buckets",
      new StaticHttpResponse(200, { buckets }),
    );
    const { client, close } = await connectResourceClient({
      capabilities: ["listBuckets"],
      fake,
    });

    try {
      const listed = await client.listResources(undefined, { cacheMode: "refresh" });
      const bucketUris = listed.resources
        .map((resource) => resource.uri)
        .filter((uri) => uri.startsWith("b2://bucket/"));

      expect(bucketUris).toHaveLength(BUCKET_RESOURCE_LIST_LIMIT);
      expect(bucketUris).toContain("b2://bucket/resource-bucket-000");
      expect(bucketUris).not.toContain(
        `b2://bucket/resource-bucket-${BUCKET_RESOURCE_LIST_LIMIT.toString().padStart(3, "0")}`,
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "b2_bucket",
          uri: BUCKET_RESOURCE_TEMPLATE_URI,
          operation: "resources/list",
          credential: expect.any(String),
          bucketCount: BUCKET_RESOURCE_LIST_LIMIT + 25,
          returnedBucketCount: BUCKET_RESOURCE_LIST_LIMIT,
          limit: BUCKET_RESOURCE_LIST_LIMIT,
        }),
        "resource.list.truncated",
      );
    } finally {
      await close();
    }
  });

  it("does not list or read bucket resources without bucket-read authorization", async () => {
    const { client, fake, close } = await connectResourceClient({ capabilities: ["readFiles"] });

    try {
      const listed = await client.listResources(undefined, { cacheMode: "refresh" });
      expect(listed.resources.map((resource) => resource.uri).sort()).toEqual([
        CAPABILITIES_RESOURCE_URI,
        SERVER_CONFIG_RESOURCE_URI,
      ]);

      const templates = await client.listResourceTemplates(undefined, { cacheMode: "refresh" });
      expect(templates.resourceTemplates.map((template) => template.uriTemplate)).not.toContain(
        BUCKET_RESOURCE_TEMPLATE_URI,
      );
      await expect(
        client.readResource({ uri: "b2://bucket/not-readable" }, { cacheMode: "refresh" }),
      ).rejects.toThrow(/not.*found/i);
      expect(fake.requests).toEqual([]);
    } finally {
      await close();
    }
  });

  it("keeps non-secret server config visible in credential-less discovery mode", async () => {
    const { client, fake, close } = await connectResourceClient({
      capabilities: null,
      serverOptions: { credentialsMissing: true },
    });

    try {
      const listed = await client.listResources(undefined, { cacheMode: "refresh" });
      expect(listed.resources.map((resource) => resource.uri).sort()).toEqual([
        SERVER_CONFIG_RESOURCE_URI,
      ]);

      const serverConfig = parseJsonResource<ServerConfigResourcePayload>(
        await client.readResource({ uri: SERVER_CONFIG_RESOURCE_URI }, { cacheMode: "refresh" }),
      );
      expect(sortedKeys(serverConfig)).toEqual([...SERVER_CONFIG_KEYS]);
      expect(JSON.stringify(serverConfig)).not.toContain(testConfig.applicationKey);
      expect(fake.requests).toEqual([]);
    } finally {
      await close();
    }
  });
});
