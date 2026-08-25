import type { McpServer } from "../../src/mcp";
import { createServer, getRegisteredResources, invalidateAuthManagerCache } from "../../src/server";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import {
  DeterministicB2NativeFake,
  testConfig as baseTestConfig,
} from "../support/deterministic-fakes";
import { installSdkTransport, StaticHttpResponse } from "../support/sdk-test-helpers";

const CANARY = "B2_MCP_CANARY_SECRET_resource_do_not_leak";

const resourceTestConfig = {
  ...baseTestConfig,
  applicationKey: CANARY,
  appKey: `${CANARY}_app`,
  masterKey: `${CANARY}_master`,
  destructivePolicy: "block" as const,
  credentialFingerprint: "credential-fingerprint",
};

function bucketInfoFixture(bucketId: string, bucketName: string, bucketType = "allPrivate") {
  return {
    accountId: "test-account-123",
    bucketId,
    bucketName,
    bucketType,
    bucketInfo: { owner: "platform" },
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
    revision: 7,
    options: ["s3"],
  };
}

async function readResource(server: McpServer, uri: string) {
  const registry = getRegisteredResources(server);
  if (!registry) throw new Error("No resources registered");

  const staticResource = Object.values(registry.resources).find((resource) => resource.uri === uri);
  if (staticResource) return staticResource.read(new URL(uri), {} as any);

  for (const template of Object.values(registry.resourceTemplates)) {
    const variables = template.resourceTemplate.uriTemplate.match(uri);
    if (variables) return template.read(new URL(uri), variables, {} as any);
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

    const noBucketRead = createServer(resourceTestConfig, ["readFiles"]);
    expect(
      getRegisteredResources(noBucketRead)?.resourceTemplates.b2_bucket_config,
    ).toBeUndefined();
  });

  it("reads bucket control-plane JSON without exposing notification secrets", async () => {
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
      encryption: { defaultServerSideEncryption: { mode: "SSE-B2", algorithm: "AES256" } },
    });
    expect(payload.eventNotifications.available).toBe(true);
    expect(payload.eventNotifications.eventNotificationRules[0].targetConfiguration).toMatchObject({
      url: "https://hooks.example.com/[redacted]",
      hmacSha256SigningSecret: "[redacted]",
      customHeaders: [{ name: "Authorization", value: "[redacted]" }],
    });
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain("path-secret");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("frag-secret");
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

    expect(payload.eventNotifications.available).toBe(false);
    expect(fake.requests.map((request) => request.endpoint)).toEqual([
      "b2_authorize_account",
      "b2_list_buckets",
    ]);
    expect(fake.requests.map((request) => request.endpoint).join(" ")).not.toMatch(
      /create|delete|set|update|list_file|download|upload/i,
    );
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
      secretSinkMode: "off",
    });

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
