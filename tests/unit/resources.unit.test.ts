import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ReadResourceResult } from "@modelcontextprotocol/server";
import {
  BUCKET_RESOURCE_TEMPLATE_URI,
  CAPABILITIES_RESOURCE_URI,
  SERVER_CONFIG_RESOURCE_URI,
} from "../../src/resources";
import {
  createServer,
  invalidateAuthManagerCache,
  type CreateServerOptions,
} from "../../src/server";
import type { B2Config } from "../../src/utils/types";
import { DeterministicB2NativeFake, testConfig } from "../support/deterministic-fakes";
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
          url: `https://hooks.example.com/${CANARY_SECRET}`,
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

function parseJsonResource(result: ReadResourceResult): any {
  expect(result.contents).toHaveLength(1);
  const [content] = result.contents;
  expect(content.mimeType).toBe("application/json");
  expect("text" in content).toBe(true);
  return JSON.parse(String("text" in content ? content.text : ""));
}

describe("MCP control-plane resources", () => {
  const previousEnv = {
    B2_HTTP_CREDENTIAL_MODE: process.env.B2_HTTP_CREDENTIAL_MODE,
    B2_MCP_PUBLIC_URL: process.env.B2_MCP_PUBLIC_URL,
    B2_OAUTH_RESOURCE: process.env.B2_OAUTH_RESOURCE,
  };

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

      const serverConfig = parseJsonResource(
        await client.readResource({ uri: SERVER_CONFIG_RESOURCE_URI }, { cacheMode: "refresh" }),
      );
      expect(serverConfig).toMatchObject({
        version: expect.any(String),
        transport: "http",
        credentialMode: "principal",
        destructivePolicy: "block",
        secretSinkMode: "off",
        publicUrl: "https://mcp.example.com/mcp",
      });
      expect(JSON.stringify(serverConfig)).not.toContain(testConfig.applicationKey);

      const capabilities = parseJsonResource(
        await client.readResource({ uri: CAPABILITIES_RESOURCE_URI }, { cacheMode: "refresh" }),
      );
      expect(capabilities).toMatchObject({
        capabilityFiltering: "enabled",
        capabilities: [],
        activeToolProfile: {
          mode: "capability-filtered",
          toolCount: expect.any(Number),
          toolNames: expect.arrayContaining(["b2_authorize_account"]),
        },
      });
      expect(JSON.stringify(capabilities)).not.toContain(testConfig.applicationKey);
    } finally {
      await close();
    }
  });

  it("lists bucket resources and reads bucket config with notification secrets redacted", async () => {
    const bucket = bucketInfoFixture("bucket-id-1", "resource-bucket");
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
      const content = raw.contents[0];
      const text = content && "text" in content ? content.text : "";
      expect(text).not.toContain(CANARY_SECRET);

      const resource = parseJsonResource(raw);
      expect(resource).toMatchObject({
        bucketName: "resource-bucket",
        bucketId: "bucket-id-1",
        bucketType: "allPrivate",
        visibility: "private",
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
                  url: "https://hooks.example.com/[redacted]",
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
      const resource = parseJsonResource(
        await client.readResource(
          { uri: "b2://bucket/bucket-without-notification-cap" },
          { cacheMode: "refresh" },
        ),
      );
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
});
