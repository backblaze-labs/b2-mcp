import {
  B2Client as SdkB2Client,
  BucketType,
  BufferSource,
  LegalHoldValue,
  RetentionMode,
} from "@backblaze-labs/b2-sdk";
import { PartnerClient as SdkPartnerClient } from "@backblaze-labs/b2-sdk/partner";
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, getRegisteredTools, invalidateAuthManagerCache } from "../../src/server";
import { setWebhookDnsLookupForTests } from "../../src/b2/buckets";
import { B2AuthManager } from "../../src/auth";
import { B2Client } from "../../src/b2/client";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { logger } from "../../src/utils/logger";
import { secretSinkFileOpsForTests } from "../../src/utils/secret-sink";
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

const partnerTestConfig = {
  ...testConfig,
  masterKeyId: "master-key-id",
  masterKey: "master-key",
};

const sdkTestRetry = {
  maxRetries: 0,
  initialRetryDelayMs: 1,
  maxRetryDelayMs: 1,
  requestTimeoutMs: 30_000,
};

function tempSecretFile(): string {
  return join(mkdtempSync(join(tmpdir(), "b2-mcp-tool-secret-sink-")), "secrets.jsonl");
}

function readSecretLedger(file: string): any {
  const lines = readFileSync(file, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

function failSecretRecordFsyncOnce(): void {
  const fsync = secretSinkFileOpsForTests.fsyncSync;
  let calls = 0;
  vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
    calls++;
    if (calls === 5) throw new Error("simulated sink fsync failure");
    return fsync(fd);
  });
}

async function seedClient(): Promise<SdkB2Client> {
  const client = new SdkB2Client({
    applicationKeyId: testConfig.applicationKeyId,
    applicationKey: testConfig.applicationKey,
    transport: sim.transport(),
    retry: sdkTestRetry,
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

async function usePartnerSimulator() {
  invalidateAuthManagerCache();
  sim = new B2Simulator({
    minimumPartSize: 1000,
    recommendedPartSize: 1000,
    partnerAuthorize: true,
  });
  const simulatorTransport = sim.transport();
  const transport = new RecordingTransport((request) => simulatorTransport.send(request));
  installSdkTransport(transport);
  seed = await seedClient();
  server = createServer(partnerTestConfig);
  const partnerSeed = new SdkPartnerClient({
    masterKeyId: "master-key-id",
    masterKey: "master-key",
    transport,
    retry: sdkTestRetry,
    realm: "http://127.0.0.1",
    allowCustomAuthorizeRealm: true,
  });
  const partnerAuth = await partnerSeed.authorize();
  return { adminAccountId: String(partnerAuth.accountId), transport, partnerSeed };
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
  delete process.env.B2_ALLOW_KEY_MGMT_GRANTS;
  delete process.env.B2_ALLOW_UNSCOPED_KEYS;
  delete process.env.B2_MAX_KEY_DURATION_SECONDS;
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

  it("uses authorize bucket scope for version binding without listBuckets", async () => {
    invalidateAuthManagerCache();
    const auth = authorizeResponse(["readFiles"]) as any;
    auth.apiInfo.storageApi.allowed.buckets = [{ id: "bucket-1", name: "scoped-bucket" }];
    auth.apiInfo.storageApi.allowed.bucketId = "bucket-1";
    auth.apiInfo.storageApi.allowed.bucketName = "scoped-bucket";
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") return new StaticHttpResponse(200, auth);
      if (endpoint === "b2_list_buckets") {
        return new StaticHttpResponse(500, {
          status: 500,
          code: "unexpected",
          message: "listBuckets should not be called",
        });
      }
      if (endpoint === "b2_get_file_info") {
        return new StaticHttpResponse(200, {
          accountId: "test-account-123",
          bucketId: "bucket-1",
          fileId: "version-a",
          fileName: "a.txt",
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

    const result = await client.resolveS3FileVersion({
      bucket: "scoped-bucket",
      key: "a.txt",
      versionId: "version-a",
    });

    expect(result.fileId).toBe("version-a");
    expect(
      transport.requests.filter((request) => b2EndpointName(request) === "b2_list_buckets"),
    ).toHaveLength(0);
  });

  it("does not trust unnamed authorize bucket scope for version binding", async () => {
    invalidateAuthManagerCache();
    const auth = authorizeResponse(["readFiles"]) as any;
    auth.apiInfo.storageApi.allowed.buckets = [{ id: "bucket-1", name: null }];
    auth.apiInfo.storageApi.allowed.bucketId = "bucket-1";
    auth.apiInfo.storageApi.allowed.bucketName = null;
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") return new StaticHttpResponse(200, auth);
      if (endpoint === "b2_list_buckets") {
        return new StaticHttpResponse(403, {
          status: 403,
          code: "unauthorized",
          message: "listBuckets denied",
        });
      }
      if (endpoint === "b2_get_file_info") {
        return new StaticHttpResponse(200, {
          accountId: "test-account-123",
          bucketId: "bucket-1",
          fileId: "version-a",
          fileName: "a.txt",
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

    await expect(
      client.resolveS3FileVersion({
        bucket: "claimed-bucket",
        key: "a.txt",
        versionId: "version-a",
      }),
    ).rejects.toThrow(/listBuckets denied/i);
    expect(
      transport.requests.filter((request) => b2EndpointName(request) === "b2_get_file_info"),
    ).toHaveLength(0);
  });

  it("fails bulk version binding closed when bucket ownership is unknown", async () => {
    invalidateAuthManagerCache();
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["readFiles"]));
      }
      if (endpoint === "b2_list_buckets") {
        return new StaticHttpResponse(403, {
          status: 403,
          code: "unauthorized",
          message: "listBuckets denied",
        });
      }
      if (endpoint === "b2_get_file_info") {
        return new StaticHttpResponse(500, {
          status: 500,
          code: "unexpected",
          message: "getFileInfo should not be called",
        });
      }
      return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
    });
    installSdkTransport(transport);
    const client = new B2Client(new B2AuthManager(testConfig));

    const result = await client.resolveS3FileVersions({
      bucket: "bulk-bucket",
      objects: [{ key: "a.txt", versionId: "version-a" }, { key: "latest.txt" }],
    });

    expect(result[0].error).toBeTruthy();
    expect(result[0].version).toBeNull();
    expect(result[1].version).toBeNull();
    expect(
      transport.requests.filter((request) => b2EndpointName(request) === "b2_get_file_info"),
    ).toHaveLength(0);
  });

  it("fails single version binding closed when bucket ownership is unknown", async () => {
    invalidateAuthManagerCache();
    const transport = new RecordingTransport((request) => {
      const endpoint = b2EndpointName(request);
      if (endpoint === "b2_authorize_account") {
        return new StaticHttpResponse(200, authorizeResponse(["readFiles"]));
      }
      if (endpoint === "b2_list_buckets") {
        return new StaticHttpResponse(403, {
          status: 403,
          code: "unauthorized",
          message: "listBuckets denied",
        });
      }
      if (endpoint === "b2_get_file_info") {
        return new StaticHttpResponse(500, {
          status: 500,
          code: "unexpected",
          message: "getFileInfo should not be called",
        });
      }
      return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
    });
    installSdkTransport(transport);
    const client = new B2Client(new B2AuthManager(testConfig));

    await expect(
      client.resolveS3FileVersion({
        bucket: "bucket",
        key: "a.txt",
        versionId: "version-a",
      }),
    ).rejects.toThrow(/listBuckets denied/i);
    expect(
      transport.requests.filter((request) => b2EndpointName(request) === "b2_get_file_info"),
    ).toHaveLength(0);
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
  async function useRecordingNativeSimulator() {
    invalidateAuthManagerCache();
    const simulatorTransport = sim.transport();
    const transport = new RecordingTransport((request) => simulatorTransport.send(request));
    installSdkTransport(transport);
    seed = await seedClient();
    return transport;
  }

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

  it("creates keys in file mode without returning the key secret to MCP output or logs", async () => {
    const logSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const secretFile = tempSecretFile();
    server = createServer({
      ...testConfig,
      secretSink: { mode: "file", filePath: secretFile },
    });

    const rawResult = await callTool(server, "b2_create_key", {
      keyName: "ci-uploader",
      capabilities: ["listBuckets"],
      idempotencyKey: "create-key-ci-uploader",
      confirm: true,
    });
    const result = parseResult(rawResult);
    const ledger = readSecretLedger(secretFile);
    const secret = ledger.result.applicationKey;

    expect(result.keyName).toBe("ci-uploader");
    expect(result.applicationKey).toBe("[redacted]");
    expect(result.secretSink).toMatchObject({
      type: "file",
      path: secretFile,
      recordId: ledger.recordId,
    });
    expect(ledger).toMatchObject({
      tool: "b2_create_key",
      recordId: result.secretSink.recordId,
      result: {
        keyName: "ci-uploader",
        capabilities: ["listBuckets"],
      },
    });
    expect(typeof secret).toBe("string");
    expect(secret).not.toBe("[redacted]");
    expect(JSON.stringify(rawResult)).not.toContain(secret);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(secret);
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);
  });

  it("reuses the existing file-sink pointer for b2_create_key idempotency retries", async () => {
    const transport = await useRecordingNativeSimulator();
    const secretFile = tempSecretFile();
    server = createServer({
      ...testConfig,
      secretSink: { mode: "file", filePath: secretFile },
    });
    const args = {
      keyName: "ci-retry",
      capabilities: ["listBuckets"],
      idempotencyKey: "create-key-retry",
      confirm: true,
    };

    const first = parseResult(await callTool(server, "b2_create_key", args));
    const createRequestsAfterFirst = transport.requests.filter(
      (request) => b2EndpointName(request) === "b2_create_key",
    ).length;
    const second = parseResult(await callTool(server, "b2_create_key", args));

    expect(second.secretSink).toEqual(first.secretSink);
    expect(second.applicationKey).toBe("[redacted]");
    expect(
      transport.requests.filter((request) => b2EndpointName(request) === "b2_create_key"),
    ).toHaveLength(createRequestsAfterFirst);
    expect(readFileSync(secretFile, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("rejects idempotency key reuse with different b2_create_key input", async () => {
    const transport = await useRecordingNativeSimulator();
    const secretFile = tempSecretFile();
    server = createServer({
      ...testConfig,
      secretSink: { mode: "file", filePath: secretFile },
    });

    await callTool(server, "b2_create_key", {
      keyName: "ci-retry-a",
      capabilities: ["listBuckets"],
      idempotencyKey: "create-key-conflict",
      confirm: true,
    });
    const createRequestsAfterFirst = transport.requests.filter(
      (request) => b2EndpointName(request) === "b2_create_key",
    ).length;
    const conflict = await callTool(server, "b2_create_key", {
      keyName: "ci-retry-b",
      capabilities: ["listBuckets"],
      idempotencyKey: "create-key-conflict",
      confirm: true,
    });

    expect(conflict.isError).toBe(true);
    expect(conflict.content[0].text).toContain("idempotency_key_conflict");
    expect(
      transport.requests.filter((request) => b2EndpointName(request) === "b2_create_key"),
    ).toHaveLength(createRequestsAfterFirst);
  });

  it("returns a created key secret only in explicit inline mode", async () => {
    server = createServer({
      ...testConfig,
      secretSink: { mode: "inline" },
    });

    const rawResult = await callTool(server, "b2_create_key", {
      keyName: "inline-key",
      capabilities: ["listBuckets"],
      idempotencyKey: "create-key-inline",
      confirm: true,
    });
    const result = parseResult(rawResult);

    expect(result.keyName).toBe("inline-key");
    expect(result.applicationKey).toEqual(expect.any(String));
    expect(result.applicationKey).not.toBe("[redacted]");
    expect(result.warning).toContain("B2_SECRET_SINK=inline");
    expect(rawResult.content[0].text).toContain(result.applicationKey);
  });

  it("rejects key-management grants before calling b2_create_key", async () => {
    const transport = await useRecordingNativeSimulator();
    server = createServer({
      ...testConfig,
      secretSink: { mode: "file", filePath: tempSecretFile() },
    });

    const result = await callTool(server, "b2_create_key", {
      keyName: "backdoor",
      capabilities: ["listKeys", "writeKeys", "deleteKeys"],
      idempotencyKey: "create-key-backdoor",
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("B2_ALLOW_KEY_MGMT_GRANTS");
    expect(transport.requests.some((request) => b2EndpointName(request) === "b2_create_key")).toBe(
      false,
    );
  });

  it("rejects unscoped write/delete grants before calling b2_create_key", async () => {
    const transport = await useRecordingNativeSimulator();
    server = createServer({
      ...testConfig,
      secretSink: { mode: "file", filePath: tempSecretFile() },
    });

    const result = await callTool(server, "b2_create_key", {
      keyName: "unscoped-writer",
      capabilities: ["writeFiles"],
      idempotencyKey: "create-key-unscoped",
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("B2_ALLOW_UNSCOPED_KEYS");
    expect(transport.requests.some((request) => b2EndpointName(request) === "b2_create_key")).toBe(
      false,
    );
  });

  it("enforces B2_MAX_KEY_DURATION_SECONDS before calling b2_create_key", async () => {
    const transport = await useRecordingNativeSimulator();
    process.env.B2_MAX_KEY_DURATION_SECONDS = "3600";
    server = createServer({
      ...testConfig,
      secretSink: { mode: "file", filePath: tempSecretFile() },
    });

    const missingDuration = await callTool(server, "b2_create_key", {
      keyName: "non-expiring",
      capabilities: ["listBuckets"],
      idempotencyKey: "create-key-non-expiring",
      confirm: true,
    });
    const tooLong = await callTool(server, "b2_create_key", {
      keyName: "too-long",
      capabilities: ["listBuckets"],
      validDurationInSeconds: 7200,
      idempotencyKey: "create-key-too-long",
      confirm: true,
    });

    expect(missingDuration.isError).toBe(true);
    expect(missingDuration.content[0].text).toContain("validDurationInSeconds");
    expect(tooLong.isError).toBe(true);
    expect(tooLong.content[0].text).toContain("B2_MAX_KEY_DURATION_SECONDS");
    expect(transport.requests.some((request) => b2EndpointName(request) === "b2_create_key")).toBe(
      false,
    );
  });

  it("returns only a sanitized error if the file sink fails after B2 creates a key", async () => {
    const fatalSpy = vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
    const secretFile = tempSecretFile();
    writeFileSync(secretFile, "", { mode: 0o600 });
    failSecretRecordFsyncOnce();
    const transport = await useRecordingNativeSimulator();
    server = createServer({
      ...testConfig,
      secretSink: { mode: "file", filePath: secretFile },
    });

    const rawResult = await callTool(server, "b2_create_key", {
      keyName: "sink-failure",
      capabilities: ["listBuckets"],
      idempotencyKey: "create-key-sink-failure",
      confirm: true,
    });

    expect(rawResult.isError).toBe(true);
    expect(rawResult.content[0].text).toContain("secret_sink_write_failed");
    expect(rawResult.content[0].text).not.toContain("K005");
    expect(JSON.stringify(fatalSpy.mock.calls)).toContain("secret_sink.write_failed");
    expect(transport.requests.some((request) => b2EndpointName(request) === "b2_delete_key")).toBe(
      true,
    );
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

  it("omits key secrets from every paginated b2_list_keys page", async () => {
    invalidateAuthManagerCache();
    const listKeyBodies: Record<string, unknown>[] = [];
    installSdkTransport(
      new RecordingTransport((request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          return new StaticHttpResponse(200, authorizeResponse(["listKeys"]));
        }
        if (endpoint === "b2_list_keys") {
          const body = requestJson(request);
          listKeyBodies.push(body);
          if (!body.startApplicationKeyId) {
            return new StaticHttpResponse(200, {
              keys: [
                {
                  keyName: "page-one",
                  applicationKeyId: "key-page-one",
                  capabilities: ["readFiles"],
                  accountId: "test-account-123",
                  expirationTimestamp: null,
                  bucketIds: null,
                  bucketId: null,
                  namePrefix: null,
                  options: [],
                  applicationKey: "secret-page-one",
                },
              ],
              nextApplicationKeyId: "key-page-two",
            });
          }
          return new StaticHttpResponse(200, {
            keys: [
              {
                keyName: "page-two",
                applicationKeyId: "key-page-two",
                capabilities: ["listFiles"],
                accountId: "test-account-123",
                expirationTimestamp: null,
                bucketIds: ["bucket-1"],
                bucketId: "bucket-1",
                namePrefix: "prefix/",
                options: [],
                applicationKey: "secret-page-two",
              },
            ],
            nextApplicationKeyId: null,
          });
        }
        return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
      }),
    );
    server = createServer(testConfig);

    const firstPage = parseResult(await callTool(server, "b2_list_keys", { maxKeyCount: 1 }));
    const secondPage = parseResult(
      await callTool(server, "b2_list_keys", {
        maxKeyCount: 1,
        startApplicationKeyId: firstPage.nextApplicationKeyId,
      }),
    );

    expect(firstPage.nextApplicationKeyId).toBe("key-page-two");
    expect(secondPage.nextApplicationKeyId).toBeNull();
    expect(listKeyBodies.map((body) => body.startApplicationKeyId ?? null)).toEqual([
      null,
      "key-page-two",
    ]);
    expect(JSON.stringify([firstPage, secondPage])).not.toContain("secret-page");
    for (const key of [...firstPage.keys, ...secondPage.keys]) {
      expect(key).not.toHaveProperty("applicationKey");
      expect(key).not.toHaveProperty("masterApplicationKey");
    }
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
    expect(res.content[0].text).toMatch(/must not resolve to a non-public IP address/i);
  });

  it("rejects webhook hostnames that resolve to mixed public and private addresses", async () => {
    setWebhookDnsLookupForTests(async () => [
      { address: "93.184.216.34" },
      { address: "169.254.169.254" },
    ]);
    const bucket = await createBucket("notify-dns-rebind");

    const res = await callTool(server, "b2_set_bucket_notification_rules", {
      bucketId: bucket.id,
      eventNotificationRules: [ruleWith("https://customer.example.com/hook")],
      confirm: true,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/must not resolve to a non-public IP address/i);
  });

  it("rejects webhook hostnames that do not resolve", async () => {
    setWebhookDnsLookupForTests(async () => {
      throw new Error("ENOTFOUND");
    });
    const bucket = await createBucket("notify-dns-unresolved");

    const res = await callTool(server, "b2_set_bucket_notification_rules", {
      bucketId: bucket.id,
      eventNotificationRules: [ruleWith("https://customer.example.com/hook")],
      confirm: true,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/must resolve to a public IP address/i);
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
  it("lists groups through SDK Partner operations", async () => {
    const { adminAccountId, transport } = await usePartnerSimulator();
    const tools = getRegisteredTools(server) ?? {};
    expect(tools.b2_list_groups.description).not.toMatch(/Unavailable compatibility stub/);

    const result = parseResult(
      await callTool(server, "b2_list_groups", {
        adminAccountId,
        maxGroupCount: 2,
      }),
    );
    const request = transport.requests.find(
      (request) => b2EndpointName(request) === "b2_list_groups",
    );
    if (!request) throw new Error("Expected SDK b2_list_groups request");
    const url = new URL(request.url);

    expect(result.accountId).toBe(adminAccountId);
    expect(result.groups).toHaveLength(2);
    expect(result.nextGroupId).toBeTruthy();
    expect(url.searchParams.get("adminAccountId")).toBe(adminAccountId);
    expect(url.searchParams.get("maxGroupCount")).toBe("2");
    expect(request.method).toBe("GET");
  });

  it("lists group members through SDK Partner operations", async () => {
    const { adminAccountId, transport, partnerSeed } = await usePartnerSimulator();
    const groups = await partnerSeed.listGroups({ pageSize: 1 });
    const group = groups.groups[0];
    if (!group) throw new Error("Expected simulator group");

    const result = parseResult(
      await callTool(server, "b2_list_group_members", {
        adminAccountId,
        groupId: group.groupId,
        startEmail: "a@example.com",
        maxMemberCount: 50,
      }),
    );
    const request = transport.requests.find(
      (request) => b2EndpointName(request) === "b2_list_group_members",
    );
    if (!request) throw new Error("Expected SDK b2_list_group_members request");
    const url = new URL(request.url);

    expect(result[0].groupId).toBe(group.groupId);
    expect(result[0].groupMembers).toEqual([]);
    expect(url.searchParams.get("adminAccountId")).toBe(adminAccountId);
    expect(url.searchParams.get("groupId")).toBe(group.groupId);
    expect(url.searchParams.get("startEmail")).toBe("a@example.com");
    expect(url.searchParams.get("maxMemberCount")).toBe("50");
    expect(request.method).toBe("GET");
  });

  it("ejects a group member through SDK Partner operations when confirmed", async () => {
    const { adminAccountId, transport, partnerSeed } = await usePartnerSimulator();
    const groups = await partnerSeed.listGroups({ pageSize: 1 });
    const group = groups.groups[0];
    if (!group) throw new Error("Expected simulator group");
    const created = await partnerSeed.createGroupMember({
      groupId: group.groupId,
      memberEmail: "member@example.com",
    });
    const member = created[0]?.groupMember;
    if (!member) throw new Error("Expected simulator group member");

    const result = parseResult(
      await callTool(server, "b2_eject_group_member", {
        adminAccountId,
        groupId: group.groupId,
        memberAccountId: member.accountId,
        email: "new@example.com",
        confirm: true,
      }),
    );
    const request = transport.requests.find(
      (request) => b2EndpointName(request) === "b2_eject_group_member",
    );
    if (!request) throw new Error("Expected SDK b2_eject_group_member request");
    const body = requestJson(request);

    expect(result.accountId).toBe(member.accountId);
    expect(result.email).toBe("new@example.com");
    expect(request.method).toBe("POST");
    expect(body).toMatchObject({
      adminAccountId,
      groupId: group.groupId,
      memberAccountId: member.accountId,
      email: "new@example.com",
    });
  });

  it("creates group members in file mode with only a secretSink pointer in MCP output", async () => {
    const secretFile = tempSecretFile();
    const { adminAccountId, transport, partnerSeed } = await usePartnerSimulator();
    server = createServer({
      ...partnerTestConfig,
      secretSink: { mode: "file", filePath: secretFile },
    });
    const groups = await partnerSeed.listGroups({ pageSize: 1 });
    const group = groups.groups[0];
    if (!group) throw new Error("Expected simulator group");

    const rawResult = await callTool(server, "b2_create_group_member", {
      adminAccountId,
      groupId: group.groupId,
      memberEmail: "sink-member@example.com",
      idempotencyKey: "create-group-member-sink",
      confirm: true,
    });
    const result = parseResult(rawResult);
    const ledger = readSecretLedger(secretFile);
    const secret = ledger.result[0].applicationKey;
    const request = transport.requests.find(
      (request) => b2EndpointName(request) === "b2_create_group_member",
    );

    expect(request?.method).toBe("POST");
    expect(result.secretSink).toMatchObject({
      type: "file",
      path: secretFile,
      recordId: ledger.recordId,
    });
    expect(result.results[0].applicationKey).toBe("[redacted]");
    expect(result.results[0].groupMember.email).toBe("sink-member@example.com");
    expect(ledger.tool).toBe("b2_create_group_member");
    expect(secret).toEqual(expect.any(String));
    expect(secret).not.toBe("[redacted]");
    expect(JSON.stringify(rawResult)).not.toContain(secret);
  });

  it("reserves trial accounts in file mode with only a secretSink pointer in MCP output", async () => {
    const secretFile = tempSecretFile();
    const { transport } = await usePartnerSimulator();
    server = createServer({
      ...partnerTestConfig,
      secretSink: { mode: "file", filePath: secretFile },
    });

    const rawResult = await callTool(server, "b2_reserve_trial_create_account", {
      email: "trial-sink@example.com",
      term: 7,
      storage: 1,
      idempotencyKey: "reserve-trial-sink",
      confirm: true,
    });
    const result = parseResult(rawResult);
    const ledger = readSecretLedger(secretFile);
    const secret = ledger.result[0].applicationKey;
    const request = transport.requests.find(
      (request) => b2EndpointName(request) === "b2_reserve_trial_create_account",
    );

    expect(request?.method).toBe("POST");
    expect(result.secretSink).toMatchObject({
      type: "file",
      path: secretFile,
      recordId: ledger.recordId,
    });
    expect(result.results[0].applicationKey).toBe("[redacted]");
    expect(result.results[0].email).toBe("trial-sink@example.com");
    expect(ledger.tool).toBe("b2_reserve_trial_create_account");
    expect(secret).toEqual(expect.any(String));
    expect(secret).not.toBe("[redacted]");
    expect(JSON.stringify(rawResult)).not.toContain(secret);
  });

  it("reuses the existing file-sink pointer for Partner idempotency retries", async () => {
    const secretFile = tempSecretFile();
    const { transport } = await usePartnerSimulator();
    server = createServer({
      ...partnerTestConfig,
      secretSink: { mode: "file", filePath: secretFile },
    });
    const args = {
      email: "trial-retry@example.com",
      term: 7,
      storage: 1,
      idempotencyKey: "reserve-trial-retry",
      confirm: true,
    };

    const first = parseResult(await callTool(server, "b2_reserve_trial_create_account", args));
    const createRequestsAfterFirst = transport.requests.filter(
      (request) => b2EndpointName(request) === "b2_reserve_trial_create_account",
    ).length;
    const second = parseResult(await callTool(server, "b2_reserve_trial_create_account", args));

    expect(second.secretSink).toEqual(first.secretSink);
    expect(second.results[0].applicationKey).toBe("[redacted]");
    expect(
      transport.requests.filter(
        (request) => b2EndpointName(request) === "b2_reserve_trial_create_account",
      ),
    ).toHaveLength(createRequestsAfterFirst);
    expect(readFileSync(secretFile, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("creates group members in inline mode with the raw secret and warning", async () => {
    const { adminAccountId, partnerSeed } = await usePartnerSimulator();
    server = createServer({
      ...partnerTestConfig,
      secretSink: { mode: "inline" },
    });
    const groups = await partnerSeed.listGroups({ pageSize: 1 });
    const group = groups.groups[0];
    if (!group) throw new Error("Expected simulator group");

    const rawResult = await callTool(server, "b2_create_group_member", {
      adminAccountId,
      groupId: group.groupId,
      memberEmail: "inline-member@example.com",
      idempotencyKey: "create-group-member-inline",
      confirm: true,
    });
    const result = parseResult(rawResult);
    const secret = result.results[0].applicationKey;

    expect(secret).toEqual(expect.any(String));
    expect(secret).not.toBe("[redacted]");
    expect(result.warning).toContain("B2_SECRET_SINK=inline");
    expect(rawResult.content[0].text).toContain(secret);
  });

  it("reserves trial accounts in inline mode with the raw secret and warning", async () => {
    await usePartnerSimulator();
    server = createServer({
      ...partnerTestConfig,
      secretSink: { mode: "inline" },
    });

    const rawResult = await callTool(server, "b2_reserve_trial_create_account", {
      email: "trial-inline@example.com",
      term: 7,
      storage: 1,
      idempotencyKey: "reserve-trial-inline",
      confirm: true,
    });
    const result = parseResult(rawResult);
    const secret = result.results[0].applicationKey;

    expect(secret).toEqual(expect.any(String));
    expect(secret).not.toBe("[redacted]");
    expect(result.warning).toContain("B2_SECRET_SINK=inline");
    expect(rawResult.content[0].text).toContain(secret);
  });

  it("ejects a created group member if the file sink fails after account creation", async () => {
    const fatalSpy = vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
    const secretFile = tempSecretFile();
    writeFileSync(secretFile, "", { mode: 0o600 });
    failSecretRecordFsyncOnce();
    const { adminAccountId, transport, partnerSeed } = await usePartnerSimulator();
    server = createServer({
      ...partnerTestConfig,
      secretSink: { mode: "file", filePath: secretFile },
    });
    const groups = await partnerSeed.listGroups({ pageSize: 1 });
    const group = groups.groups[0];
    if (!group) throw new Error("Expected simulator group");

    const rawResult = await callTool(server, "b2_create_group_member", {
      adminAccountId,
      groupId: group.groupId,
      memberEmail: "member-sink-failure@example.com",
      idempotencyKey: "create-group-member-sink-failure",
      confirm: true,
    });

    expect(rawResult.isError).toBe(true);
    expect(rawResult.content[0].text).toContain("secret_sink_write_failed");
    expect(rawResult.content[0].text).not.toContain("K005");
    expect(JSON.stringify(fatalSpy.mock.calls)).not.toContain("K005");
    expect(JSON.stringify(fatalSpy.mock.calls)).toContain("ejected_group_members");
    expect(
      transport.requests.some((request) => b2EndpointName(request) === "b2_eject_group_member"),
    ).toBe(true);
  });

  it("returns only a sanitized error if the file sink fails after Partner account creation", async () => {
    const fatalSpy = vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
    const secretFile = tempSecretFile();
    writeFileSync(secretFile, "", { mode: 0o600 });
    failSecretRecordFsyncOnce();
    await usePartnerSimulator();
    server = createServer({
      ...partnerTestConfig,
      secretSink: { mode: "file", filePath: secretFile },
    });

    const rawResult = await callTool(server, "b2_reserve_trial_create_account", {
      email: "trial-sink-failure@example.com",
      term: 7,
      storage: 1,
      idempotencyKey: "reserve-trial-sink-failure",
      confirm: true,
    });

    expect(rawResult.isError).toBe(true);
    expect(rawResult.content[0].text).toContain("secret_sink_write_failed");
    expect(rawResult.content[0].text).not.toContain("K005");
    expect(JSON.stringify(fatalSpy.mock.calls)).not.toContain("K005");
    expect(JSON.stringify(fatalSpy.mock.calls)).toContain("quarantine_required");
  });

  it.each([
    ["b2_list_groups", "b2_list_groups", {}],
    ["b2_list_group_members", "b2_list_group_members", { groupId: "123" }],
    [
      "b2_eject_group_member",
      "b2_eject_group_member",
      { groupId: "123", memberAccountId: "member-account-xyz", confirm: true },
    ],
  ])(
    "rejects mismatched adminAccountId for %s before the Partner raw request",
    async (tool, endpoint, args) => {
      const { adminAccountId, transport } = await usePartnerSimulator();
      const before = transport.requests.filter(
        (request) => b2EndpointName(request) === endpoint,
      ).length;

      const result = await callTool(server, tool, {
        ...args,
        adminAccountId: `${adminAccountId}-other`,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("adminAccountId");
      expect(
        transport.requests.filter((request) => b2EndpointName(request) === endpoint),
      ).toHaveLength(before);
    },
  );

  it("blocks unconfirmed group member ejection before the API call", async () => {
    const { adminAccountId, transport, partnerSeed } = await usePartnerSimulator();
    const groups = await partnerSeed.listGroups({ pageSize: 1 });
    const group = groups.groups[0];
    if (!group) throw new Error("Expected simulator group");

    const result = await callTool(server, "b2_eject_group_member", {
      adminAccountId,
      groupId: group.groupId,
      memberAccountId: "member-account-xyz",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Confirmation required");
    expect(
      transport.requests.filter((request) => b2EndpointName(request) === "b2_eject_group_member"),
    ).toEqual([]);
  });
});
