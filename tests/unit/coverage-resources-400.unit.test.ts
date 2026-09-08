// Branch-coverage expansion for src/resources.ts (issue #400, phase 1).
//
// Exercises the HTTP credential-mode env parsing fallbacks, the bucket
// visibility mapping across every bucketType, the bucketPayload `?? []`/`?? null`
// fallbacks (including the two-step defaultRetention derivation), the
// resources/list buckets-not-array guard, and the sanitizer's empty-keyId path.
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { type ReadResourceResult } from "@modelcontextprotocol/server";
import {
  SERVER_CONFIG_RESOURCE_URI,
  type BucketResourcePayload,
  type ServerConfigResourcePayload,
} from "../../src/resources";
import { createServer, invalidateAuthManagerCache } from "../../src/server";
import type { B2Config } from "../../src/utils/types";
import { DeterministicB2NativeFake, testConfig } from "../support/deterministic-fakes";
import { installSdkTransport, StaticHttpResponse } from "../support/sdk-test-helpers";

function minimalBucket(bucketType: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: "account-123",
    bucketId: "bucket-id-1",
    bucketName: "resource-bucket",
    bucketType,
    bucketInfo: {},
    options: [],
    revision: 1,
    ...overrides,
  };
}

async function connect(
  options: {
    capabilities?: string[] | null;
    config?: B2Config;
    fake?: DeterministicB2NativeFake;
  } = {},
) {
  const fake =
    options.fake ?? new DeterministicB2NativeFake({ capabilities: options.capabilities ?? undefined });
  installSdkTransport(fake);
  const server = createServer(options.config ?? testConfig, options.capabilities);
  const client = new Client({ name: "b2-mcp-resource-cov", version: "1.0.0" }, { defaultCacheTtlMs: 0 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

function parseJson<T extends object>(result: ReadResourceResult): T {
  const [content] = result.contents;
  return JSON.parse(String("text" in content ? content.text : "")) as T;
}

const previousEnv = process.env.B2_HTTP_CREDENTIAL_MODE;

afterEach(() => {
  vi.restoreAllMocks();
  invalidateAuthManagerCache();
  if (previousEnv === undefined) delete process.env.B2_HTTP_CREDENTIAL_MODE;
  else process.env.B2_HTTP_CREDENTIAL_MODE = previousEnv;
});

describe("resources HTTP credential mode parsing", () => {
  const httpConfig = { ...testConfig, transport: "http" } as B2Config;

  it("defaults an unset B2_HTTP_CREDENTIAL_MODE to headers", async () => {
    delete process.env.B2_HTTP_CREDENTIAL_MODE;
    const { client, close } = await connect({ config: httpConfig });
    try {
      const payload = parseJson<ServerConfigResourcePayload>(
        await client.readResource({ uri: SERVER_CONFIG_RESOURCE_URI }, { cacheMode: "refresh" }),
      );
      expect(payload.credentialMode).toBe("headers");
    } finally {
      await close();
    }
  });

  it("falls back to headers for an unrecognized B2_HTTP_CREDENTIAL_MODE", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "bogus-mode";
    const { client, close } = await connect({ config: httpConfig });
    try {
      const payload = parseJson<ServerConfigResourcePayload>(
        await client.readResource({ uri: SERVER_CONFIG_RESOURCE_URI }, { cacheMode: "refresh" }),
      );
      expect(payload.credentialMode).toBe("headers");
    } finally {
      await close();
    }
  });

  it("reports stdio credential mode for the stdio transport", async () => {
    const { client, close } = await connect();
    try {
      const payload = parseJson<ServerConfigResourcePayload>(
        await client.readResource({ uri: SERVER_CONFIG_RESOURCE_URI }, { cacheMode: "refresh" }),
      );
      expect(payload.credentialMode).toBe("stdio");
    } finally {
      await close();
    }
  });
});

describe("resources bucket visibility mapping", () => {
  it.each([
    { bucketType: "allPublic", visibility: "public" },
    { bucketType: "restricted", visibility: "restricted" },
    { bucketType: "snapshot", visibility: "snapshot" },
    { bucketType: "somethingElse", visibility: "unknown" },
  ])("maps bucketType $bucketType to $visibility", async ({ bucketType, visibility }) => {
    const fake = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] }).respond(
      "b2_list_buckets",
      new StaticHttpResponse(200, { buckets: [minimalBucket(bucketType)] }),
    );
    const { client, close } = await connect({ capabilities: ["listBuckets"], fake });
    try {
      const payload = parseJson<BucketResourcePayload>(
        await client.readResource({ uri: "b2://bucket/resource-bucket" }, { cacheMode: "refresh" }),
      );
      expect(payload.visibility).toBe(visibility);
    } finally {
      await close();
    }
  });
});

describe("resources bucketPayload fallbacks", () => {
  it("defaults absent optional bucket config to empty arrays and null", async () => {
    const fake = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] }).respond(
      "b2_list_buckets",
      new StaticHttpResponse(200, { buckets: [minimalBucket("allPrivate")] }),
    );
    const { client, close } = await connect({ capabilities: ["listBuckets"], fake });
    try {
      const payload = parseJson<BucketResourcePayload>(
        await client.readResource({ uri: "b2://bucket/resource-bucket" }, { cacheMode: "refresh" }),
      );
      expect(payload.corsRules).toEqual([]);
      expect(payload.lifecycleRules).toEqual([]);
      expect(payload.defaultServerSideEncryption).toBeNull();
      expect(payload.objectLock).toBeNull();
      expect(payload.defaultRetention).toBeNull();
      expect(payload.replicationConfiguration).toBeNull();
    } finally {
      await close();
    }
  });

  it("derives defaultRetention from the Object Lock configuration when not set directly", async () => {
    const bucket = minimalBucket("allPrivate", {
      fileLockConfiguration: {
        isClientAuthorizedToRead: true,
        value: {
          isFileLockEnabled: true,
          defaultRetention: { mode: "compliance", period: { duration: 14, unit: "days" } },
        },
      },
    });
    const fake = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] }).respond(
      "b2_list_buckets",
      new StaticHttpResponse(200, { buckets: [bucket] }),
    );
    const { client, close } = await connect({ capabilities: ["listBuckets"], fake });
    try {
      const payload = parseJson<BucketResourcePayload>(
        await client.readResource({ uri: "b2://bucket/resource-bucket" }, { cacheMode: "refresh" }),
      );
      expect(payload.defaultRetention).toMatchObject({
        mode: "compliance",
        period: { duration: 14, unit: "days" },
      });
    } finally {
      await close();
    }
  });
});

describe("resources list guards", () => {
  it("treats a non-array bucket listing as empty in resources/list", async () => {
    const fake = new DeterministicB2NativeFake({ capabilities: ["listBuckets"] }).respond(
      "b2_list_buckets",
      new StaticHttpResponse(200, { buckets: null }),
    );
    const { client, close } = await connect({ capabilities: ["listBuckets"], fake });
    try {
      const listed = await client.listResources(undefined, { cacheMode: "refresh" });
      const uris = listed.resources.map((resource) => resource.uri);
      expect(uris).toContain(SERVER_CONFIG_RESOURCE_URI);
      expect(uris.some((uri) => uri.startsWith("b2://bucket/"))).toBe(false);
    } finally {
      await close();
    }
  });
});

describe("resources sanitizer key-id handling", () => {
  it("does not leak credential ids that are too short to redact", async () => {
    // Distinctive <8-char ids drive the branch that skips adding them to the
    // redaction set; server-config must still never echo a credential id.
    const shortIdConfig = {
      ...testConfig,
      applicationKeyId: "shortA1",
      appKeyId: "shortB2",
      masterKeyId: "shortC3",
    } as B2Config;
    const { client, close } = await connect({ config: shortIdConfig });
    try {
      const result = await client.readResource(
        { uri: SERVER_CONFIG_RESOURCE_URI },
        { cacheMode: "refresh" },
      );
      const serialized = String("text" in result.contents[0] ? result.contents[0].text : "");
      expect(serialized).not.toContain("shortA1");
      expect(serialized).not.toContain("shortB2");
      expect(serialized).not.toContain("shortC3");

      const payload = JSON.parse(serialized) as ServerConfigResourcePayload;
      expect(payload.uri).toBe(SERVER_CONFIG_RESOURCE_URI);
    } finally {
      await close();
    }
  });
});
