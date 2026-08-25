import { B2Client as SdkB2Client } from "@backblaze-labs/b2-sdk";
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer, invalidateAuthManagerCache } from "../../src/server";
import type { McpServer } from "../../src/mcp";
import { invalidateCompletionCache } from "../../src/completions";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { DeterministicB2NativeFake, testConfig } from "../support/deterministic-fakes";
import { installSdkTransport } from "../support/sdk-test-helpers";

const sdkTestRetry = {
  maxRetries: 0,
  initialRetryDelayMs: 1,
  maxRetryDelayMs: 1,
  requestTimeoutMs: 30_000,
};

interface ConnectedServer {
  client: Client;
  server: McpServer;
  close(): Promise<void>;
}

async function seedClient(sim: B2Simulator): Promise<SdkB2Client> {
  const client = new SdkB2Client({
    applicationKeyId: testConfig.applicationKeyId,
    applicationKey: testConfig.applicationKey,
    transport: sim.transport(),
    retry: sdkTestRetry,
  });
  await client.authorize();
  return client;
}

async function connect(server: McpServer): Promise<ConnectedServer> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "b2-mcp-completion-test", version: "1.0.0" },
    {
      versionNegotiation: { mode: "legacy" },
      defaultCacheTtlMs: 0,
    },
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    async close() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

async function completeToolArgument(
  client: Client,
  toolName: string,
  argumentName: string,
  value = "",
) {
  return client.complete({
    ref: { type: "ref/tool", name: toolName } as never,
    argument: { name: argumentName, value },
  });
}

describe("MCP tool argument completion", () => {
  let connected: ConnectedServer | null = null;

  beforeEach(() => {
    invalidateAuthManagerCache();
    invalidateCompletionCache();
  });

  afterEach(async () => {
    await connected?.close();
    connected = null;
    setB2SdkClientFactoryForTests(null);
    invalidateAuthManagerCache();
    invalidateCompletionCache();
  });

  it("completes bucket and application-key identifiers against the simulator", async () => {
    const sim = new B2Simulator({ minimumPartSize: 1000, recommendedPartSize: 1000 });
    installSdkTransport(sim.transport(), sdkTestRetry);
    const seed = await seedClient(sim);
    const alpha = await seed.createBucket({
      bucketName: "completion-alpha",
      bucketType: "allPrivate",
    });
    const beta = await seed.createBucket({
      bucketName: "completion-beta",
      bucketType: "allPrivate",
    });
    const createdKey = await seed.createKey({
      keyName: "completion-reader",
      capabilities: ["listBuckets"],
    });
    connected = await connect(createServer(testConfig));

    const names = await completeToolArgument(
      connected.client,
      "b2_list_buckets",
      "bucketName",
      "completion-",
    );
    const ids = await completeToolArgument(connected.client, "b2_delete_bucket", "bucketId");
    const keyIds = await completeToolArgument(
      connected.client,
      "b2_delete_key",
      "applicationKeyId",
    );
    const newBucketName = await completeToolArgument(
      connected.client,
      "b2_create_bucket",
      "bucketName",
      "completion-",
    );

    expect(names.completion.values).toEqual(["completion-alpha", "completion-beta"]);
    expect(ids.completion.values).toEqual(expect.arrayContaining([alpha.id, beta.id]));
    expect(keyIds.completion.values).toContain(createdKey.applicationKeyId);
    expect(JSON.stringify(keyIds)).not.toContain(createdKey.applicationKey);
    expect(newBucketName.completion.values).toEqual([]);
  });

  it("returns empty sets without live calls when capabilities cannot list resources", async () => {
    const native = new DeterministicB2NativeFake();
    installSdkTransport(native, sdkTestRetry);

    connected = await connect(createServer(testConfig, ["deleteKeys", "readFiles"]));
    const keyIds = await completeToolArgument(
      connected.client,
      "b2_delete_key",
      "applicationKeyId",
    );
    const bucketNames = await completeToolArgument(connected.client, "s3_get_object", "bucket");

    expect(keyIds.completion.values).toEqual([]);
    expect(bucketNames.completion.values).toEqual([]);
    expect(native.requestsFor("b2_list_keys")).toHaveLength(0);
    expect(native.requestsFor("b2_list_buckets")).toHaveLength(0);
  });
});
