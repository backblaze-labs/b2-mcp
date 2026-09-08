import { B2Client as SdkB2Client } from "@backblaze-labs/b2-sdk";
import type { PartnerClient as SdkPartnerClient } from "@backblaze-labs/b2-sdk/partner";
import { B2AuthManager } from "../../src/auth";
import { B2Client, setB2PartnerClientFactoryForTests } from "../../src/b2/client";
import { runWithMcpRequestSignal } from "../../src/request-context";
import { circuitBreaker } from "../../src/utils/circuit-breaker";
import { logger } from "../../src/utils/logger";
import { _resetRetryBudget } from "../../src/utils/retry";
import type { B2AuthResponse } from "../../src/utils/types";
import { testConfig } from "../support/deterministic-fakes";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import {
  b2EndpointName,
  RecordingTransport,
  StaticHttpResponse,
  installSdkTransport,
} from "../support/sdk-test-helpers";

function partnerAuthorizeResponse(authorizationToken = "partner-token-xyz") {
  return {
    accountId: "test-account-123",
    authorizationToken,
    apiInfo: {
      groupsApi: {
        capabilities: ["all"],
        groupsApiUrl: "http://127.0.0.1/partner",
        infoType: "groupsApi",
      },
    },
    applicationKeyExpirationTimestamp: null,
  };
}

function bucketInfo(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "test-account-123",
    bucketId: "bucket-1",
    bucketName: "edge-bucket",
    bucketType: "allPrivate",
    bucketInfo: {},
    corsRules: [],
    lifecycleRules: [],
    revision: 1,
    options: [],
    ...overrides,
  };
}

function nativeAuthResponse(
  options: {
    token?: string;
    apiUrl?: string;
    allowedBuckets?: B2AuthResponse["allowedBuckets"];
  } = {},
): B2AuthResponse {
  return {
    accountId: "test-account-123",
    authorizationToken: options.token ?? "native-token",
    apiUrl: options.apiUrl ?? "https://api005.backblazeb2.com",
    downloadUrl: "https://f005.backblazeb2.com",
    recommendedPartSize: 100 * 1024 * 1024,
    absoluteMinimumPartSize: 5 * 1024 * 1024,
    s3ApiUrl: "https://s3.us-west-004.backblazeb2.com",
    capabilities: ["listBuckets", "listFiles", "readFiles", "writeFiles"],
    allowedBuckets: options.allowedBuckets ?? null,
  };
}

interface NativeSdkFixture {
  createBucket?: (options: object) => Promise<object>;
  createKey?: (options: object) => Promise<object>;
  getBucket?: (bucketName: string) => Promise<{ id: string } | null>;
  raw?: Record<string, (...args: never[]) => Promise<object>>;
}

function sdkClientFromFixture(fixture: NativeSdkFixture): SdkB2Client {
  const client = new SdkB2Client({
    applicationKeyId: testConfig.applicationKeyId,
    applicationKey: testConfig.applicationKey,
    transport: {
      async send() {
        throw new Error("Unexpected SDK transport request");
      },
    },
  });

  for (const method of ["createBucket", "createKey", "getBucket"] as const) {
    const impl = fixture[method];
    if (impl) {
      vi.spyOn(client, method).mockImplementation(impl as never);
    }
  }
  if (fixture.raw) {
    for (const [method, impl] of Object.entries(fixture.raw)) {
      vi.spyOn(client.raw, method as keyof SdkB2Client["raw"]).mockImplementation(impl as never);
    }
  }
  return client;
}

function clientWithMockedNativeSdk(
  sdk: NativeSdkFixture,
  authResponses: B2AuthResponse[] = [nativeAuthResponse()],
) {
  let authIndex = 0;
  const authManager = new B2AuthManager(testConfig);
  const sdkClient = sdkClientFromFixture(sdk);
  vi.spyOn(authManager, "getAuthorizedSdk").mockImplementation(async () => {
    const auth = authResponses[Math.min(authIndex, authResponses.length - 1)];
    authIndex += 1;
    return { client: sdkClient, auth };
  });
  vi.spyOn(authManager, "syncCachedAuthFromSdk").mockImplementation(() => undefined);
  vi.spyOn(authManager, "invalidate").mockImplementation(() => undefined);
  return { authManager, client: new B2Client(authManager) };
}

function clientWithTransport(transport: RecordingTransport): B2Client {
  installSdkTransport(transport);
  return new B2Client(new B2AuthManager(testConfig));
}

function partnerClientWithCreateFacades(options: {
  createGroupMember?: ReturnType<typeof vi.fn>;
}): SdkPartnerClient {
  const partnerAuth = partnerAuthorizeResponse();
  return {
    authorize: vi.fn(async () => partnerAuth),
    partnerAccountInfo: {
      clear: vi.fn(),
      getAuth: vi.fn(() => null),
    },
    createGroupMember: options.createGroupMember ?? vi.fn(),
    reserveTrialAccount: vi.fn(),
    raw: {},
  } as unknown as SdkPartnerClient;
}

describe("B2Client coverage branches", () => {
  afterEach(() => {
    circuitBreaker.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    _resetRetryBudget();
    setB2SdkClientFactoryForTests(null);
    setB2PartnerClientFactoryForTests(null);
  });

  describe("test-runtime guard", () => {
    it("rejects the Partner factory override outside the test runtime", () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalWorker = process.env.VITEST_WORKER_ID;
      try {
        delete process.env.NODE_ENV;
        delete process.env.VITEST_WORKER_ID;
        expect(() => setB2PartnerClientFactoryForTests(null)).toThrow(/only available in tests/);
      } finally {
        if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
        if (originalWorker !== undefined) process.env.VITEST_WORKER_ID = originalWorker;
      }
    });
  });

  describe("Partner response validation", () => {
    it("rejects a create-group-member response with a non-object groupMember", async () => {
      const createGroupMember = vi.fn(async () => ({
        applicationKeyId: "group-member-key-id",
        applicationKey: "B2_MCP_CANARY_SECRET_group_member_bad_nested",
        groupMember: "not-an-object",
      }));
      setB2PartnerClientFactoryForTests(() =>
        partnerClientWithCreateFacades({ createGroupMember }),
      );
      const client = new B2Client(new B2AuthManager(testConfig));

      await expect(
        client.createGroupMember({
          adminAccountId: "test-account-123",
          groupId: "group-1",
          memberEmail: "member@example.com",
        }),
      ).rejects.toMatchObject({ status: 502, code: "unexpected_partner_response" });
    });
  });

  describe("notification rule custom headers", () => {
    it("normalizes array-form and object-form custom headers and preserves the hmac secret", async () => {
      const sdk = {
        raw: {
          getBucketNotificationRules: async () => ({
            bucketId: "bucket-1",
            eventNotificationRules: [
              {
                name: "array-headers",
                eventTypes: ["b2:ObjectCreated:*"],
                isEnabled: true,
                isSuspended: false,
                objectNamePrefix: "",
                suspensionReason: "",
                targetConfiguration: {
                  targetType: "webhook",
                  url: "https://hooks.example.com/a",
                  hmacSha256SigningSecret: "top-secret",
                  customHeaders: [{ name: "X-A", value: "1" }],
                },
              },
              {
                name: "object-headers",
                eventTypes: ["b2:ObjectDeleted:*"],
                isEnabled: true,
                isSuspended: false,
                objectNamePrefix: "",
                suspensionReason: "",
                targetConfiguration: {
                  targetType: "webhook",
                  url: "https://hooks.example.com/b",
                  customHeaders: { "X-B": "2" },
                },
              },
            ],
          }),
        },
      };
      const { client } = clientWithMockedNativeSdk(sdk);

      const result = await client.getBucketNotificationRules("bucket-1");

      expect(result.eventNotificationRules[0]?.targetConfiguration).toMatchObject({
        hmacSha256SigningSecret: "top-secret",
        customHeaders: { "X-A": "1" },
      });
      expect(result.eventNotificationRules[1]?.targetConfiguration.customHeaders).toEqual({
        "X-B": "2",
      });
    });
  });

  describe("bucket scope resolution", () => {
    it("rejects conflicting bucketId and bucketName filters in the authorized scope", async () => {
      const sdk = { raw: { listBuckets: vi.fn(async () => ({ buckets: [] })) } };
      const { client } = clientWithMockedNativeSdk(sdk, [
        nativeAuthResponse({
          allowedBuckets: [
            { id: "bucket-1", name: "bucket-one" },
            { id: "bucket-2", name: "other-bucket" },
          ],
        }),
      ]);

      await expect(
        client.listBuckets({ bucketId: "bucket-1", bucketName: "other-bucket" }),
      ).rejects.toMatchObject({ status: 403, code: "forbidden" });
      expect(sdk.raw.listBuckets).not.toHaveBeenCalled();
    });

    it("auto-scopes an unfiltered list to the authorized bucket set and logs it", async () => {
      const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
      const listBuckets = vi.fn(
        async (_apiUrl: string, _token: string, request: { bucketId?: string }) => ({
          buckets: [bucketInfo({ bucketId: request.bucketId ?? "bucket-1" })],
        }),
      );
      const { client } = clientWithMockedNativeSdk({ raw: { listBuckets } }, [
        nativeAuthResponse({
          allowedBuckets: [
            { id: "bucket-1", name: "bucket-one" },
            { id: "bucket-2", name: "bucket-two" },
          ],
        }),
      ]);

      const result = await client.listBuckets();

      expect(result.buckets).toHaveLength(2);
      expect(listBuckets).toHaveBeenCalledTimes(2);
      expect(
        debug.mock.calls.find(([, message]) => message === "b2.list_buckets.auto_scoped")?.[0],
      ).toMatchObject({ bucketCount: 2, tool: "b2_list_buckets" });
    });

    it("throws the caller abort reason when the signal aborts before results resolve", async () => {
      const controller = new AbortController();
      const abortReason = new Error("caller aborted before list");
      controller.abort(abortReason);
      const listBuckets = vi.fn(async () => ({ buckets: [bucketInfo()] }));
      const { client } = clientWithMockedNativeSdk({ raw: { listBuckets } }, [
        nativeAuthResponse({
          allowedBuckets: [{ id: "bucket-1", name: "bucket-one" }],
        }),
      ]);

      await expect(
        runWithMcpRequestSignal(controller.signal, () => client.listBuckets()),
      ).rejects.toBe(abortReason);
      expect(listBuckets).not.toHaveBeenCalled();
    });
  });

  describe("native option normalization branches", () => {
    it("normalizes lifecycle, encryption, retention, and cleared replication on create", async () => {
      const createBucket = vi.fn(async () => ({ info: bucketInfo({ bucketName: "created" }) }));
      const { client } = clientWithMockedNativeSdk({ createBucket });

      await client.createBucket({
        bucketName: "created",
        bucketType: "allPrivate",
        defaultServerSideEncryption: { mode: "SSE-B2" },
        defaultRetention: { mode: "governance", period: { duration: 7, unit: "days" } },
        lifecycleRules: [{ fileNamePrefix: "logs/", daysFromHidingToDeleting: 5 }],
        replicationConfiguration: {
          asReplicationSource: null,
          asReplicationDestination: null,
        },
      });

      expect(createBucket).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultServerSideEncryption: { mode: "SSE-B2", algorithm: "AES256" },
          defaultRetention: { mode: "governance", period: { duration: 7, unit: "days" } },
          lifecycleRules: [
            {
              fileNamePrefix: "logs/",
              daysFromHidingToDeleting: 5,
              daysFromUploadingToHiding: null,
            },
          ],
          replicationConfiguration: {
            asReplicationSource: null,
            asReplicationDestination: null,
          },
        }),
      );
    });

    it("omits an absent bucketType from the native update request", async () => {
      const updateBucket = vi.fn(async (_apiUrl: string, _token: string, _request: object) =>
        bucketInfo({ bucketName: "updated" }),
      );
      const { client } = clientWithMockedNativeSdk({ raw: { updateBucket } });

      await client.updateBucket({ bucketId: "bucket-1", bucketInfo: { env: "prod" } });

      const request = updateBucket.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(request).not.toHaveProperty("bucketType");
      expect(request).toMatchObject({ bucketId: "bucket-1", bucketInfo: { env: "prod" } });
    });
  });

  describe("non-object native errors", () => {
    it("surfaces a non-object native error without treating it as unauthorized", async () => {
      const sdk = {
        getBucket: vi.fn(async () => ({ id: "bucket-1" })),
        raw: {
          getFileInfo: vi.fn(async () => {
            throw "native-string-failure";
          }),
        },
      };
      const { client, authManager } = clientWithMockedNativeSdk(sdk);

      await expect(
        client.resolveS3FileVersion({
          bucket: "bucket",
          key: "file.txt",
          versionId: "version-1",
        }),
      ).rejects.toBe("native-string-failure");
      expect(authManager.invalidate).not.toHaveBeenCalled();
    });
  });

  describe("Partner optional request fields", () => {
    it("passes optional list-groups filters through the Partner request", async () => {
      const transport = new RecordingTransport((request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          return new StaticHttpResponse(200, partnerAuthorizeResponse());
        }
        if (endpoint === "b2_list_groups") {
          return new StaticHttpResponse(200, {
            accountId: "test-account-123",
            groups: [],
            nextGroupId: null,
          });
        }
        return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
      });
      const client = clientWithTransport(transport);

      await expect(
        client.listGroups({
          adminAccountId: "test-account-123",
          groupName: "team",
          startGroupId: 5,
          maxGroupCount: 10,
        }),
      ).resolves.toMatchObject({ groups: [] });

      expect(
        transport.requests.filter((request) => b2EndpointName(request) === "b2_list_groups"),
      ).toHaveLength(1);
    });

    it("passes optional list-group-members filters and wraps a singleton response", async () => {
      const transport = new RecordingTransport((request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          return new StaticHttpResponse(200, partnerAuthorizeResponse());
        }
        if (endpoint === "b2_list_group_members") {
          return new StaticHttpResponse(200, {
            accountId: "test-account-123",
            groupMembers: [],
            nextEmail: null,
          });
        }
        return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
      });
      const client = clientWithTransport(transport);

      const result = await client.listGroupMembers({
        adminAccountId: "test-account-123",
        groupId: "123",
        startEmail: "cursor@example.com",
        maxMemberCount: 25,
      });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(
        transport.requests.filter((request) => b2EndpointName(request) === "b2_list_group_members"),
      ).toHaveLength(1);
    });

    it("omits an absent region from the create-group-member request", async () => {
      const createGroupMember = vi.fn(async (_options: Record<string, unknown>) => ({
        applicationKeyId: "group-member-key-id",
        applicationKey: "B2_MCP_CANARY_SECRET_group_member_no_region",
        groupMember: {
          accountId: "member-account-id",
          email: "member@example.com",
          groupId: "group-1",
          groupName: "Group 1",
          region: "us-west",
          s3Endpoint: "s3.us-west-001.backblazeb2.com",
        },
      }));
      setB2PartnerClientFactoryForTests(() =>
        partnerClientWithCreateFacades({ createGroupMember }),
      );
      const client = new B2Client(new B2AuthManager(testConfig));

      await client.createGroupMember({
        adminAccountId: "test-account-123",
        groupId: "group-1",
        memberEmail: "member@example.com",
      });

      const callArg = createGroupMember.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg).toMatchObject({ groupId: "group-1", memberEmail: "member@example.com" });
      expect(callArg).not.toHaveProperty("region");
    });
  });

  describe("Partner caller-abort race", () => {
    it("rejects a signalled Partner read when authorization fails", async () => {
      const controller = new AbortController();
      const transport = new RecordingTransport((request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          return new StaticHttpResponse(500, {
            status: 500,
            code: "server_error",
            message: "authorize failed",
          });
        }
        return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
      });
      const client = clientWithTransport(transport);

      await expect(
        runWithMcpRequestSignal(controller.signal, () =>
          client.listGroups({ adminAccountId: "test-account-123" }),
        ),
      ).rejects.toBeTruthy();
    });
  });
});
