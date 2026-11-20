import { createServer, invalidateAuthManagerCache } from "../../src/server";
import type { McpServer } from "../../src/mcp";
import { circuitBreaker } from "../../src/utils/circuit-breaker";
import type { B2Config } from "../../src/utils/types";
import { callTool, DeterministicB2NativeFake, testConfig } from "../support/deterministic-fakes";
import { installSdkTransport, StaticHttpResponse } from "../support/sdk-test-helpers";
import { restoreB2SdkTransportForTests } from "../support/sdk-factory-hook";

// Pins the exact B2 native request bodies that b2_create_bucket and
// b2_update_bucket put on the wire for CORS rules and replication
// configuration. Everything runs against the deterministic native fake: no
// network and no credentials.

const BUCKET_RESPONSE = {
  accountId: "test-account-123",
  bucketId: "bucket-id-1",
  bucketName: "shape-bucket",
  bucketType: "allPrivate",
  bucketInfo: {},
  options: [],
  revision: 1,
};

function connect(config: B2Config = testConfig): {
  fake: DeterministicB2NativeFake;
  server: McpServer;
} {
  const fake = new DeterministicB2NativeFake({ capabilities: ["writeBuckets", "listBuckets"] });
  fake.respond("b2_create_bucket", new StaticHttpResponse(200, BUCKET_RESPONSE));
  fake.respond("b2_update_bucket", new StaticHttpResponse(200, BUCKET_RESPONSE));
  installSdkTransport(fake);
  return { fake, server: createServer(config) };
}

afterEach(() => {
  restoreB2SdkTransportForTests();
  circuitBreaker.close();
  invalidateAuthManagerCache();
});

const createBase = { bucketName: "shape-bucket", bucketType: "allPrivate" };
const updateBase = { bucketId: "bucket-id-1" };

const fullRule = {
  corsRuleName: "full-rule",
  allowedOrigins: ["https://app.example.com", "https://admin.example.com"],
  allowedHeaders: ["authorization", "range"],
  allowedOperations: ["b2_download_file_by_name", "b2_upload_file"],
  exposeHeaders: ["x-bz-content-sha1"],
  maxAgeSeconds: 3600,
};

describe("b2_create_bucket corsRules request body", () => {
  it("sends every CORS rule field verbatim and in order", async () => {
    const { fake, server } = connect();
    const second = {
      corsRuleName: "second-rule",
      allowedOrigins: ["*"],
      allowedHeaders: [],
      allowedOperations: ["s3_get"],
      exposeHeaders: ["etag"],
      maxAgeSeconds: 86_400,
    };

    const result = await callTool(server, "b2_create_bucket", {
      ...createBase,
      corsRules: [fullRule, second],
    });

    expect(result.isError).toBeFalsy();
    expect(fake.requestsFor("b2_create_bucket").map((r) => r.body)).toEqual([
      {
        accountId: "test-account-123",
        bucketName: "shape-bucket",
        bucketType: "allPrivate",
        corsRules: [fullRule, second],
      },
    ]);
  });

  it("sends null for an omitted exposeHeaders and keeps an empty allowedHeaders array", async () => {
    const { fake, server } = connect();
    const { exposeHeaders: _omitted, ...withoutExpose } = fullRule;

    await callTool(server, "b2_create_bucket", {
      ...createBase,
      corsRules: [{ ...withoutExpose, allowedHeaders: [] }],
    });

    const [request] = fake.requestsFor("b2_create_bucket");
    expect(request?.body.corsRules).toEqual([
      { ...withoutExpose, allowedHeaders: [], exposeHeaders: null },
    ]);
  });

  it("omits the corsRules key entirely when no rules are given", async () => {
    const { fake, server } = connect();

    await callTool(server, "b2_create_bucket", createBase);

    const [request] = fake.requestsFor("b2_create_bucket");
    expect(request?.body).toEqual({
      accountId: "test-account-123",
      bucketName: "shape-bucket",
      bucketType: "allPrivate",
    });
    expect(request?.body).not.toHaveProperty("corsRules");
  });

  it.each([6, 63])(
    "accepts a %i-character rule name at the documented boundary",
    async (length) => {
      const { fake, server } = connect();
      const corsRuleName = "a".repeat(length);

      const result = await callTool(server, "b2_create_bucket", {
        ...createBase,
        corsRules: [{ ...fullRule, corsRuleName }],
      });

      expect(result.isError).toBeFalsy();
      const [request] = fake.requestsFor("b2_create_bucket");
      expect(request?.body.corsRules).toEqual([{ ...fullRule, corsRuleName }]);
    },
  );
});

describe("b2_update_bucket corsRules request body", () => {
  it("sends the replacement CORS rule set with the bucket identifiers", async () => {
    const { fake, server } = connect();

    const result = await callTool(server, "b2_update_bucket", {
      ...updateBase,
      corsRules: [fullRule],
      ifRevisionIs: 4,
    });

    expect(result.isError).toBeFalsy();
    expect(fake.requestsFor("b2_update_bucket").map((r) => r.body)).toEqual([
      {
        accountId: "test-account-123",
        bucketId: "bucket-id-1",
        corsRules: [fullRule],
        ifRevisionIs: 4,
      },
    ]);
  });

  it("sends an empty corsRules array to clear rules, without needing confirmation", async () => {
    const { fake, server } = connect();

    const result = await callTool(server, "b2_update_bucket", { ...updateBase, corsRules: [] });

    expect(result.isError).toBeFalsy();
    const [request] = fake.requestsFor("b2_update_bucket");
    expect(request?.body).toEqual({
      accountId: "test-account-123",
      bucketId: "bucket-id-1",
      corsRules: [],
    });
  });

  it("omits corsRules when the update does not touch them", async () => {
    const { fake, server } = connect();

    await callTool(server, "b2_update_bucket", { ...updateBase, bucketInfo: { team: "qa" } });

    const [request] = fake.requestsFor("b2_update_bucket");
    expect(request?.body).toEqual({
      accountId: "test-account-123",
      bucketId: "bucket-id-1",
      bucketInfo: { team: "qa" },
    });
  });
});

describe("corsRules validation errors never reach the B2 API", () => {
  const rule = (overrides: Record<string, unknown>) => ({ ...fullRule, ...overrides });

  it.each([
    [
      "5-character name",
      [rule({ corsRuleName: "a".repeat(5) })],
      /corsRules\[0\]\.corsRuleName must be 6-63 characters long/,
    ],
    [
      "64-character name",
      [rule({ corsRuleName: "a".repeat(64) })],
      /corsRules\[0\]\.corsRuleName must be 6-63 characters long/,
    ],
    [
      "name outside letters, digits, and hyphens",
      [rule({ corsRuleName: "bad_name" })],
      /corsRuleName may contain only letters, digits, and hyphens/,
    ],
    [
      "reserved b2- prefix",
      [rule({ corsRuleName: "b2-reserved" })],
      /corsRuleName must not start with 'b2-'/,
    ],
    [
      "duplicate names",
      [rule({ corsRuleName: "same-name" }), rule({ corsRuleName: "same-name" })],
      /corsRules\[1\]\.corsRuleName "same-name" must be unique/,
    ],
    [
      "empty allowedOrigins",
      [rule({ allowedOrigins: [] })],
      /corsRules\[0\]\.allowedOrigins must contain at least 1 item/,
    ],
    [
      "empty allowedOperations",
      [rule({ allowedOperations: [] })],
      /corsRules\[0\]\.allowedOperations must contain at least 1 item/,
    ],
  ])("rejects %s", async (_label, corsRules, message) => {
    for (const [tool, base, endpoint] of [
      ["b2_create_bucket", createBase, "b2_create_bucket"],
      ["b2_update_bucket", updateBase, "b2_update_bucket"],
    ] as const) {
      const { fake, server } = connect();

      const result = await callTool(server, tool, { ...base, corsRules });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("B2 Error [bad_request] (HTTP 400)");
      expect(result.content[0].text).toMatch(message);
      expect(fake.requestsFor(endpoint)).toHaveLength(0);
      invalidateAuthManagerCache();
    }
  });
});

describe("b2_update_bucket replicationConfiguration request body", () => {
  const source = {
    sourceApplicationKeyId: "source-key-id",
    replicationRules: [
      {
        replicationRuleName: "copy-logs",
        destinationBucketId: "dest-bucket-id",
        fileNamePrefix: "logs/",
        includeExistingFiles: true,
        isEnabled: true,
        priority: 2,
      },
      {
        replicationRuleName: "copy-rest",
        destinationBucketId: "dest-bucket-id",
        isEnabled: false,
        priority: 1,
      },
    ],
  };

  it("sends the source configuration, defaulting prefix and includeExistingFiles", async () => {
    const { fake, server } = connect();

    const result = await callTool(server, "b2_update_bucket", {
      ...updateBase,
      replicationConfiguration: { asReplicationSource: source },
      confirm: true,
    });

    expect(result.isError).toBeFalsy();
    expect(fake.requestsFor("b2_update_bucket").map((r) => r.body)).toEqual([
      {
        accountId: "test-account-123",
        bucketId: "bucket-id-1",
        replicationConfiguration: {
          asReplicationSource: {
            sourceApplicationKeyId: "source-key-id",
            replicationRules: [
              {
                replicationRuleName: "copy-logs",
                destinationBucketId: "dest-bucket-id",
                fileNamePrefix: "logs/",
                includeExistingFiles: true,
                isEnabled: true,
                priority: 2,
              },
              {
                replicationRuleName: "copy-rest",
                destinationBucketId: "dest-bucket-id",
                fileNamePrefix: "",
                includeExistingFiles: false,
                isEnabled: false,
                priority: 1,
              },
            ],
          },
          asReplicationDestination: null,
        },
      },
    ]);
  });

  it("sends the destination configuration with a null source", async () => {
    const { fake, server } = connect();

    await callTool(server, "b2_update_bucket", {
      ...updateBase,
      replicationConfiguration: {
        asReplicationDestination: {
          sourceToDestinationKeyMapping: { "source-key-id": "destination-key-id" },
        },
      },
      confirm: true,
    });

    const [request] = fake.requestsFor("b2_update_bucket");
    expect(request?.body.replicationConfiguration).toEqual({
      asReplicationSource: null,
      asReplicationDestination: {
        sourceToDestinationKeyMapping: { "source-key-id": "destination-key-id" },
      },
    });
  });

  it("sends source and destination together", async () => {
    const { fake, server } = connect();

    await callTool(server, "b2_update_bucket", {
      ...updateBase,
      replicationConfiguration: {
        asReplicationSource: { ...source, replicationRules: [source.replicationRules[0]] },
        asReplicationDestination: {
          sourceToDestinationKeyMapping: { "source-key-id": "destination-key-id" },
        },
      },
      confirm: true,
    });

    const [request] = fake.requestsFor("b2_update_bucket");
    const config = request?.body.replicationConfiguration as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual(["asReplicationDestination", "asReplicationSource"]);
    expect(config.asReplicationDestination).toEqual({
      sourceToDestinationKeyMapping: { "source-key-id": "destination-key-id" },
    });
    expect(config.asReplicationSource).toMatchObject({ sourceApplicationKeyId: "source-key-id" });
  });

  it("does not forward the confirm flag to B2", async () => {
    const { fake, server } = connect();

    await callTool(server, "b2_update_bucket", {
      ...updateBase,
      replicationConfiguration: { asReplicationSource: source },
      confirm: true,
    });

    const [request] = fake.requestsFor("b2_update_bucket");
    expect(request?.body).not.toHaveProperty("confirm");
  });

  it("omits replicationConfiguration from non-replication updates", async () => {
    const { fake, server } = connect();

    await callTool(server, "b2_update_bucket", { ...updateBase, corsRules: [fullRule] });

    const [request] = fake.requestsFor("b2_update_bucket");
    expect(request?.body).not.toHaveProperty("replicationConfiguration");
  });
});

describe("replication destructive gate at the request level", () => {
  const replicationConfiguration = {
    asReplicationDestination: { sourceToDestinationKeyMapping: { "key-a": "key-b" } },
  };

  it("sends nothing to B2 when confirm is missing under the default policy", async () => {
    const { fake, server } = connect();

    const result = await callTool(server, "b2_update_bucket", {
      ...updateBase,
      replicationConfiguration,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/replication/i);
    expect(fake.requestsFor("b2_update_bucket")).toHaveLength(0);
  });

  it("sends nothing to B2 under the block policy, even with confirm", async () => {
    const { fake, server } = connect({ ...testConfig, destructivePolicy: "block" });

    const result = await callTool(server, "b2_update_bucket", {
      ...updateBase,
      replicationConfiguration,
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/blocked/i);
    expect(fake.requestsFor("b2_update_bucket")).toHaveLength(0);
  });

  it("sends the update under the allow policy without confirm", async () => {
    const { fake, server } = connect({ ...testConfig, destructivePolicy: "allow" });

    const result = await callTool(server, "b2_update_bucket", {
      ...updateBase,
      replicationConfiguration,
    });

    expect(result.isError).toBeFalsy();
    expect(fake.requestsFor("b2_update_bucket")).toHaveLength(1);
  });
});
