import { B2Client as SdkB2Client } from "@backblaze-labs/b2-sdk";
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer, getRegisteredTools, invalidateAuthManagerCache } from "../../src/server";
import type { McpServer } from "../../src/mcp";
import { completionContractForTests, invalidateCompletionCache } from "../../src/completions";
import { logger } from "../../src/utils/logger";
import { abortError } from "../../src/utils/named-error";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { DeterministicB2NativeFake, testConfig } from "../support/deterministic-fakes";
import { installSdkTransport, StaticHttpResponse } from "../support/sdk-test-helpers";

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

type ToolReference = { type: "ref/tool"; name: string };

interface CompletionRequestOptions {
  signal?: AbortSignal;
}

function applicationKeyFixture(applicationKeyId: string) {
  return {
    keyName: `key-${applicationKeyId}`,
    applicationKeyId,
    capabilities: ["listBuckets"],
    accountId: "test-account-123",
    expirationTimestamp: null,
    bucketIds: null,
    bucketId: null,
    namePrefix: null,
    options: [],
  };
}

function bucketFixture(bucketName: string, bucketId = `id-${bucketName}`) {
  return {
    bucketId,
    bucketName,
    bucketType: "allPrivate",
    bucketInfo: {},
    corsRules: [],
    lifecycleRules: [],
    revision: 1,
    defaultServerSideEncryption: { mode: "none" },
    fileLockConfiguration: { isFileLockEnabled: false },
    replicationConfiguration: null,
  };
}

async function waitForRequestDispatch(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
  options?: CompletionRequestOptions,
) {
  // The MCP SDK 2.0 client typings only model prompt/resource completion refs.
  // b2-mcp implements the MCP tool-argument ref shape while the shared type catches up.
  const ref = { type: "ref/tool", name: toolName } as ToolReference;
  return client.complete(
    {
      ref: ref as never,
      argument: { name: argumentName, value },
    },
    options,
  );
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
    vi.restoreAllMocks();
    invalidateAuthManagerCache();
    invalidateCompletionCache();
  });

  it("keeps the tool completion surface explicit", () => {
    const contract = completionContractForTests();
    const server = createServer({ ...testConfig, secretSink: { mode: "inline" } });
    const tools = getRegisteredTools(server);

    expect(contract).not.toHaveProperty("b2_create_bucket");
    for (const [toolName, args] of Object.entries(contract)) {
      const tool = tools?.[toolName];
      expect(tool, `${toolName} should be registered`).toBeDefined();
      if (!tool) throw new Error(`${toolName} should be registered`);
      expect(tool.inputSchema, `${toolName} should have an input schema`).toBeDefined();
      if (!tool.inputSchema) throw new Error(`${toolName} should have an input schema`);
      for (const argumentName of Object.keys(args)) {
        expect(
          Object.prototype.hasOwnProperty.call(tool.inputSchema.shape, argumentName),
          `${toolName}.${argumentName} should be a declared input`,
        ).toBe(true);
      }
    }
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

  it("paginates application-key identifier completions beyond the first page", async () => {
    const native = new DeterministicB2NativeFake({
      capabilities: ["listKeys", "deleteKeys"],
    });
    native.paginate("b2_list_keys", [
      {
        keys: Array.from({ length: 1000 }, (_, i) => applicationKeyFixture(`page-one-${i}`)),
        nextApplicationKeyId: "after-page-one",
      },
      {
        keys: [applicationKeyFixture("target-second-page")],
        nextApplicationKeyId: null,
      },
    ]);
    installSdkTransport(native, sdkTestRetry);

    connected = await connect(createServer(testConfig, ["listKeys", "deleteKeys"]));
    const result = await completeToolArgument(
      connected.client,
      "b2_delete_key",
      "applicationKeyId",
      "target-",
    );

    expect(result.completion.values).toEqual(["target-second-page"]);
    expect(native.requestsFor("b2_list_keys").map((request) => request.body)).toEqual([
      { accountId: "test-account-123", maxKeyCount: 1000 },
      {
        accountId: "test-account-123",
        maxKeyCount: 1000,
        startApplicationKeyId: "after-page-one",
      },
    ]);
  });

  it("caches only bounded prefix matches for application-key completions", async () => {
    const native = new DeterministicB2NativeFake({
      capabilities: ["listKeys", "deleteKeys"],
    });
    native.paginate("b2_list_keys", [
      {
        keys: Array.from({ length: 150 }, (_, i) =>
          applicationKeyFixture(`match-${String(i).padStart(3, "0")}`),
        ),
        nextApplicationKeyId: "after-page-one",
      },
      {
        keys: [applicationKeyFixture("match-second-page")],
        nextApplicationKeyId: null,
      },
    ]);
    installSdkTransport(native, sdkTestRetry);

    connected = await connect(createServer(testConfig, ["listKeys", "deleteKeys"]));
    const first = await completeToolArgument(
      connected.client,
      "b2_delete_key",
      "applicationKeyId",
      "match-",
    );
    const second = await completeToolArgument(
      connected.client,
      "b2_delete_key",
      "applicationKeyId",
      "match-",
    );

    expect(first.completion.values).toHaveLength(100);
    expect(first.completion.values[0]).toBe("match-000");
    expect(first.completion.values).not.toContain("match-100");
    expect(first.completion.hasMore).toBe(true);
    expect(first.completion.total).toBeUndefined();
    expect(second.completion.values).toEqual(first.completion.values);
    expect(native.requestsFor("b2_list_keys").map((request) => request.body)).toEqual([
      { accountId: "test-account-123", maxKeyCount: 1000 },
    ]);
  });

  it("audits bucket and key completions without logging completion values", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const native = new DeterministicB2NativeFake({
      capabilities: ["listBuckets", "listKeys", "deleteKeys"],
    });
    native.respond(
      "b2_list_buckets",
      new StaticHttpResponse(200, {
        buckets: [bucketFixture("audit-secret-bucket", "audit-secret-bucket-id")],
      }),
    );
    native.respond(
      "b2_list_keys",
      new StaticHttpResponse(200, {
        keys: [applicationKeyFixture("audit-secret-key-id")],
        nextApplicationKeyId: null,
      }),
    );
    installSdkTransport(native, sdkTestRetry);

    connected = await connect(createServer(testConfig));
    await completeToolArgument(connected.client, "b2_list_buckets", "bucketName", "audit-");
    await completeToolArgument(connected.client, "b2_delete_key", "applicationKeyId", "audit-");

    const completionCalls = info.mock.calls.filter(([, message]) => message === "completion.call");
    expect(completionCalls).toHaveLength(2);
    expect(completionCalls[0][0]).toEqual(
      expect.objectContaining({
        tool: "b2_list_buckets",
        argument: "bucketName",
        completionKind: "bucket-name",
        error: false,
        values: 1,
        total: 1,
      }),
    );
    expect(completionCalls[1][0]).toEqual(
      expect.objectContaining({
        tool: "b2_delete_key",
        argument: "applicationKeyId",
        completionKind: "application-key-id",
        error: false,
        values: 1,
        total: 1,
      }),
    );

    const logs = JSON.stringify(completionCalls);
    expect(logs).not.toContain("audit-secret-bucket");
    expect(logs).not.toContain("audit-secret-bucket-id");
    expect(logs).not.toContain("audit-secret-key-id");
    expect(logs).not.toContain(testConfig.applicationKey);
  });

  it("logs degraded lookup failures before returning empty completions", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const native = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] });
    native.fail("b2_list_buckets", 429, "too_many_requests", "Slow down");
    installSdkTransport(native, sdkTestRetry);

    connected = await connect(createServer(testConfig, ["listBuckets", "readFiles"]));
    const result = await completeToolArgument(connected.client, "s3_get_object", "bucket", "any");

    expect(result.completion.values).toEqual([]);
    const degraded = warn.mock.calls.find(
      ([, message]) => message === "completion.lookup.degraded",
    );
    expect(degraded?.[0]).toEqual(
      expect.objectContaining({
        completionKind: "bucket-name",
        status: 429,
        code: "too_many_requests",
        degraded: true,
        degradeReason: "upstream_error",
      }),
    );
  });

  it("does not let the first caller abort a shared completion fetch", async () => {
    const native = new DeterministicB2NativeFake({ capabilities: ["listBuckets", "readFiles"] });
    let releaseFetch!: () => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    native.respond("b2_list_buckets", async () => {
      markFetchStarted();
      await release;
      return new StaticHttpResponse(200, {
        buckets: [bucketFixture("abort-shared-bucket", "abort-shared-bucket-id")],
      });
    });
    installSdkTransport(native, sdkTestRetry);

    connected = await connect(createServer(testConfig, ["listBuckets", "readFiles"]));
    const controller = new AbortController();
    const first = completeToolArgument(connected.client, "s3_get_object", "bucket", "abort-", {
      signal: controller.signal,
    });
    await fetchStarted;
    const second = completeToolArgument(connected.client, "s3_get_object", "bucket", "abort-");
    await waitForRequestDispatch();

    controller.abort();
    releaseFetch();

    const secondResult = await second;
    await expect(first).rejects.toThrow();
    expect(secondResult.completion.values).toEqual(["abort-shared-bucket"]);
    expect(native.requestsFor("b2_list_buckets")).toHaveLength(1);
    expect(native.requestsFor("b2_list_buckets")[0].aborted).toBe(false);
  });

  it("cancels a shared completion fetch after all waiters abort", async () => {
    const native = new DeterministicB2NativeFake({ capabilities: ["listBuckets", "readFiles"] });
    let releaseAbortedFetch!: () => void;
    let markFetchStarted!: () => void;
    let sharedSignal: AbortSignal | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const releaseOldFetch = new Promise<void>((resolve) => {
      releaseAbortedFetch = resolve;
    });
    const sharedAborted = new Promise<void>((resolve) => {
      native.respond("b2_list_buckets", async (captured) => {
        sharedSignal = captured.request.signal;
        markFetchStarted();
        if (!sharedSignal) throw new Error("Expected completion lookup signal");
        if (!sharedSignal.aborted) {
          await new Promise<void>((abortResolve) =>
            sharedSignal?.addEventListener("abort", () => abortResolve(), { once: true }),
          );
        }
        resolve();
        await releaseOldFetch;
        throw sharedSignal.reason ?? abortError();
      });
    });
    native.respond(
      "b2_list_buckets",
      new StaticHttpResponse(200, {
        buckets: [bucketFixture("fresh-after-abort", "fresh-after-abort-id")],
      }),
    );
    installSdkTransport(native, sdkTestRetry);

    connected = await connect(createServer(testConfig, ["listBuckets", "readFiles"]));
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = completeToolArgument(connected.client, "s3_get_object", "bucket", "abort-", {
      signal: firstController.signal,
    }).catch((err) => err);
    await fetchStarted;
    const second = completeToolArgument(connected.client, "s3_get_object", "bucket", "abort-", {
      signal: secondController.signal,
    }).catch((err) => err);
    await waitForRequestDispatch();

    firstController.abort(abortError("first caller left"));
    const firstErr = await first;
    expect(String(firstErr)).toContain("first caller left");
    expect(sharedSignal?.aborted).toBe(false);

    secondController.abort(abortError("second caller left"));
    const [secondErr] = await Promise.all([second, sharedAborted]);

    expect(String(secondErr)).toContain("second caller left");
    expect(sharedSignal?.aborted).toBe(true);

    const fresh = await completeToolArgument(connected.client, "s3_get_object", "bucket", "fresh-");
    releaseAbortedFetch();

    expect(fresh.completion.values).toEqual(["fresh-after-abort"]);
    expect(native.requestsFor("b2_list_buckets")).toHaveLength(2);
  });
});
