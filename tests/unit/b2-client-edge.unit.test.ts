import { B2Client as SdkB2Client } from "@backblaze-labs/b2-sdk";
import type { PartnerClient as SdkPartnerClient } from "@backblaze-labs/b2-sdk/partner";
import { B2AuthManager } from "../../src/auth";
import { B2Client, setB2PartnerClientFactoryForTests, validateB2ApiUrl } from "../../src/b2/client";
import { runWithMcpRequestSignal } from "../../src/request-context";
import { circuitBreaker } from "../../src/utils/circuit-breaker";
import { _consumeRetryToken, _resetRetryBudget } from "../../src/utils/retry";
import type { B2AuthResponse } from "../../src/utils/types";
import { testConfig } from "../support/deterministic-fakes";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import {
  authorizeResponse,
  b2EndpointName,
  installSdkTransport,
  RecordingTransport,
  requestJson,
  StaticHttpResponse,
} from "../support/sdk-test-helpers";

function authResponseWithToken(token: string) {
  return {
    ...authorizeResponse(["listBuckets", "listFiles"]),
    authorizationToken: token,
  };
}

function partnerAuthorizeResponse(
  authorizationToken = "partner-token-xyz",
  accountId = "test-account-123",
  groupsApiUrl = "http://127.0.0.1/partner",
) {
  return {
    accountId,
    authorizationToken,
    apiInfo: {
      groupsApi: {
        capabilities: ["all"],
        groupsApiUrl,
        infoType: "groupsApi",
      },
    },
    applicationKeyExpirationTimestamp: null,
  };
}

function bucketListResponse(bucketName = "edge-bucket") {
  return {
    buckets: [bucketInfo({ bucketName })],
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

function fileVersion(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "test-account-123",
    bucketId: "bucket-1",
    fileId: "version-1",
    fileName: "file.txt",
    action: "upload",
    contentLength: 1,
    contentSha1: "none",
    contentType: "text/plain",
    fileInfo: {},
    uploadTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
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

type NativeRawFixture = Partial<
  Record<
    | "getBucketNotificationRules"
    | "getFileInfo"
    | "listBuckets"
    | "listFileNames"
    | "listFileVersions"
    | "listParts"
    | "listUnfinishedLargeFiles"
    | "setBucketNotificationRules"
    | "updateBucket",
    (
      apiUrl: string,
      authorizationToken: string,
      request: object,
      options?: object,
    ) => Promise<object>
  >
>;

interface NativeSdkFixture {
  createBucket?: (options: object) => Promise<object>;
  createKey?: (options: object) => Promise<object>;
  getBucket?: (bucketName: string) => Promise<{ id: string } | null>;
  raw?: NativeRawFixture;
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

  if (fixture.createBucket) {
    vi.spyOn(client, "createBucket").mockImplementation(
      fixture.createBucket as SdkB2Client["createBucket"],
    );
  }
  if (fixture.createKey) {
    vi.spyOn(client, "createKey").mockImplementation(fixture.createKey as SdkB2Client["createKey"]);
  }
  if (fixture.getBucket) {
    vi.spyOn(client, "getBucket").mockImplementation(fixture.getBucket as SdkB2Client["getBucket"]);
  }

  if (fixture.raw?.getBucketNotificationRules) {
    vi.spyOn(client.raw, "getBucketNotificationRules").mockImplementation(
      fixture.raw.getBucketNotificationRules as SdkB2Client["raw"]["getBucketNotificationRules"],
    );
  }
  if (fixture.raw?.getFileInfo) {
    vi.spyOn(client.raw, "getFileInfo").mockImplementation(
      fixture.raw.getFileInfo as SdkB2Client["raw"]["getFileInfo"],
    );
  }
  if (fixture.raw?.listBuckets) {
    vi.spyOn(client.raw, "listBuckets").mockImplementation(
      fixture.raw.listBuckets as SdkB2Client["raw"]["listBuckets"],
    );
  }
  if (fixture.raw?.listFileNames) {
    vi.spyOn(client.raw, "listFileNames").mockImplementation(
      fixture.raw.listFileNames as SdkB2Client["raw"]["listFileNames"],
    );
  }
  if (fixture.raw?.listFileVersions) {
    vi.spyOn(client.raw, "listFileVersions").mockImplementation(
      fixture.raw.listFileVersions as SdkB2Client["raw"]["listFileVersions"],
    );
  }
  if (fixture.raw?.listParts) {
    vi.spyOn(client.raw, "listParts").mockImplementation(
      fixture.raw.listParts as SdkB2Client["raw"]["listParts"],
    );
  }
  if (fixture.raw?.listUnfinishedLargeFiles) {
    vi.spyOn(client.raw, "listUnfinishedLargeFiles").mockImplementation(
      fixture.raw.listUnfinishedLargeFiles as SdkB2Client["raw"]["listUnfinishedLargeFiles"],
    );
  }
  if (fixture.raw?.setBucketNotificationRules) {
    vi.spyOn(client.raw, "setBucketNotificationRules").mockImplementation(
      fixture.raw.setBucketNotificationRules as SdkB2Client["raw"]["setBucketNotificationRules"],
    );
  }
  if (fixture.raw?.updateBucket) {
    vi.spyOn(client.raw, "updateBucket").mockImplementation(
      fixture.raw.updateBucket as SdkB2Client["raw"]["updateBucket"],
    );
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
  const getAuthorizedSdk = vi
    .spyOn(authManager, "getAuthorizedSdk")
    .mockImplementation(async () => {
      const auth = authResponses[Math.min(authIndex, authResponses.length - 1)];
      authIndex += 1;
      return { client: sdkClient, auth };
    });
  const syncCachedAuthFromSdk = vi
    .spyOn(authManager, "syncCachedAuthFromSdk")
    .mockImplementation(() => undefined);
  const invalidate = vi.spyOn(authManager, "invalidate").mockImplementation(() => undefined);

  return {
    authManager,
    spies: {
      getAuthorizedSdk,
      invalidate,
      syncCachedAuthFromSdk,
    },
    client: new B2Client(authManager),
  };
}

function clientWithTransport(transport: RecordingTransport): B2Client {
  installSdkTransport(transport);
  return new B2Client(new B2AuthManager(testConfig));
}

describe("B2Client native edge branches", () => {
  afterEach(() => {
    circuitBreaker.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    _resetRetryBudget();
    setB2SdkClientFactoryForTests(null);
    setB2PartnerClientFactoryForTests(null);
  });

  describe("native auth and circuit", () => {
    it("rejects immediately without authorizing when the native circuit is open", async () => {
      const transport = new RecordingTransport(() => new StaticHttpResponse(200, {}));
      const client = clientWithTransport(transport);
      circuitBreaker.open();

      await expect(client.listBuckets()).rejects.toMatchObject({ code: "EOPENBREAKER" });

      expect(transport.requests).toHaveLength(0);
    });

    it("does not ask auth for an SDK when the native circuit fast-fails", async () => {
      const sdk = {
        raw: {
          listBuckets: vi.fn(async () => bucketListResponse()),
        },
      };
      const { client, spies } = clientWithMockedNativeSdk(sdk);
      circuitBreaker.open();

      await expect(client.listBuckets()).rejects.toMatchObject({ code: "EOPENBREAKER" });

      expect(spies.getAuthorizedSdk).not.toHaveBeenCalled();
      expect(sdk.raw.listBuckets).not.toHaveBeenCalled();
    });

    it("allows the half-open probe and closes again after a successful native call", async () => {
      vi.useFakeTimers();
      const transport = new RecordingTransport((request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          return new StaticHttpResponse(200, authResponseWithToken("probe-token"));
        }
        if (endpoint === "b2_list_buckets") {
          return new StaticHttpResponse(200, bucketListResponse("half-open-bucket"));
        }
        return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
      });
      const client = clientWithTransport(transport);
      circuitBreaker.open();

      await expect(client.listBuckets()).rejects.toMatchObject({ code: "EOPENBREAKER" });
      expect(transport.requests).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(30_000);

      await expect(client.listBuckets()).resolves.toMatchObject({
        buckets: [{ bucketName: "half-open-bucket" }],
      });
      await expect(client.listBuckets()).resolves.toMatchObject({
        buckets: [{ bucketName: "half-open-bucket" }],
      });
      expect(
        transport.requests.filter((request) => b2EndpointName(request) === "b2_list_buckets"),
      ).toHaveLength(2);
    });

    it("invalidates cached native auth and retries once after a 401", async () => {
      const listTokens: string[] = [];
      const sdk = {
        raw: {
          listBuckets: vi.fn(async (_apiUrl: string, authorizationToken: string) => {
            listTokens.push(authorizationToken);
            if (authorizationToken === "stale-token") {
              throw Object.assign(new Error("expired"), {
                response: { status: 401 },
                code: "expired_auth_token",
              });
            }
            return bucketListResponse("fresh-bucket");
          }),
        },
      };
      const { client, spies } = clientWithMockedNativeSdk(sdk, [
        nativeAuthResponse({ token: "stale-token" }),
        nativeAuthResponse({ token: "fresh-token" }),
      ]);

      await expect(client.listBuckets()).resolves.toMatchObject({
        buckets: [{ bucketName: "fresh-bucket" }],
      });

      expect(spies.invalidate).toHaveBeenCalledTimes(1);
      expect(spies.getAuthorizedSdk).toHaveBeenCalledTimes(2);
      expect(spies.syncCachedAuthFromSdk).toHaveBeenCalledTimes(2);
      expect(listTokens).toEqual(["stale-token", "fresh-token"]);
    });

    it("surfaces the second native 401 after a single invalidation", async () => {
      const sdk = {
        raw: {
          listBuckets: vi.fn(async () => {
            throw Object.assign(new Error("still expired"), {
              status: 401,
              code: "expired_auth_token",
            });
          }),
        },
      };
      const { client, spies } = clientWithMockedNativeSdk(sdk, [
        nativeAuthResponse({ token: "stale-token" }),
        nativeAuthResponse({ token: "still-stale-token" }),
      ]);

      await expect(client.listBuckets()).rejects.toMatchObject({
        status: 401,
        code: "expired_auth_token",
      });

      expect(spies.invalidate).toHaveBeenCalledTimes(1);
      expect(spies.getAuthorizedSdk).toHaveBeenCalledTimes(2);
      expect(sdk.raw.listBuckets).toHaveBeenCalledTimes(2);
    });

    it("does not retry a native 401 after the caller has aborted", async () => {
      const controller = new AbortController();
      const unauthorized = Object.assign(new Error("expired after abort"), {
        status: 401,
        code: "expired_auth_token",
      });
      const sdk = {
        raw: {
          listBuckets: vi.fn(async () => {
            controller.abort(new Error("caller aborted"));
            throw unauthorized;
          }),
        },
      };
      const { client, spies } = clientWithMockedNativeSdk(sdk);

      await expect(
        runWithMcpRequestSignal(controller.signal, () => client.listBuckets()),
      ).rejects.toBe(unauthorized);

      expect(spies.invalidate).not.toHaveBeenCalled();
      expect(spies.getAuthorizedSdk).toHaveBeenCalledTimes(1);
      expect(sdk.raw.listBuckets).toHaveBeenCalledTimes(1);
    });
  });

  describe("native API URL validation", () => {
    it.each([
      "not a url",
      "http://api005.backblazeb2.com",
      "https://user:pass@api005.backblazeb2.com",
      "https://api005.backblazeb2.com:8443",
      "https://api005.backblazeb2.com/path",
      "https://api005.backblazeb2.com?x=1",
      "https://evil.example.com",
      "https://evilbackblazeb2.com",
      "https://api005backblazeb2.com",
      "https://api005.backblazeb2.com.attacker.tld",
    ])("rejects invalid authorized native API URL %s", (raw) => {
      expect(validateB2ApiUrl(raw)).toEqual(expect.any(String));
    });

    it.each(["https://backblazeb2.com", "https://api005.backblazeb2.com"])(
      "accepts trusted authorized native API URL %s",
      (raw) => {
        expect(validateB2ApiUrl(raw)).toBeNull();
      },
    );

    it("rejects native operations before SDK calls when the authorized API URL is unsafe", async () => {
      const sdk = {
        raw: {
          listBuckets: vi.fn(async () => bucketListResponse()),
        },
      };
      const { client } = clientWithMockedNativeSdk(sdk, [
        nativeAuthResponse({ apiUrl: "https://api005.backblazeb2.com/path" }),
      ]);

      await expect(client.listBuckets()).rejects.toThrow(/Authorized B2 API endpoint/);

      expect(sdk.raw.listBuckets).not.toHaveBeenCalled();
    });
  });

  describe("native DTO normalization", () => {
    it("serializes optional native bucket DTO fields without leaking SDK extras", async () => {
      const sdk = {
        raw: {
          listBuckets: vi.fn(async () => ({
            buckets: [
              bucketInfo({
                bucketName: "replicated-bucket",
                sdkOnlyField: "bucket-secret",
                options: undefined,
                defaultServerSideEncryption: { mode: "future-mode", algorithm: "future-algorithm" },
                defaultRetention: { mode: null, period: null },
                fileLockConfiguration: {
                  isClientAuthorizedToRead: false,
                  value: null,
                },
                replicationConfiguration: {
                  asReplicationSource: {
                    sourceApplicationKeyId: "source-key-id",
                    replicationRules: [
                      {
                        replicationRuleName: "copy-all",
                        destinationBucketId: "dest-bucket-id",
                        fileNamePrefix: "",
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
              }),
              bucketInfo({
                bucketId: "bucket-2",
                bucketName: "locked-bucket",
                sdkOnlyField: "lock-secret",
                defaultServerSideEncryption: { mode: null, algorithm: null },
                fileLockConfiguration: {
                  isClientAuthorizedToRead: true,
                  value: {
                    isFileLockEnabled: true,
                    defaultRetention: null,
                  },
                },
                replicationConfiguration: {
                  asReplicationSource: null,
                  asReplicationDestination: null,
                },
              }),
            ],
          })),
        },
      };
      const { client } = clientWithMockedNativeSdk(sdk);

      const result = await client.listBuckets();

      expect(result.buckets).toStrictEqual([
        {
          accountId: "test-account-123",
          bucketId: "bucket-1",
          bucketName: "replicated-bucket",
          bucketType: "allPrivate",
          bucketInfo: {},
          corsRules: [],
          options: [],
          defaultServerSideEncryption: { mode: null },
          defaultRetention: { mode: null, period: null },
          fileLockConfiguration: {
            isClientAuthorizedToRead: false,
            value: null,
          },
          replicationConfiguration: {
            asReplicationSource: {
              sourceApplicationKeyId: "source-key-id",
              replicationRules: [
                {
                  replicationRuleName: "copy-all",
                  destinationBucketId: "dest-bucket-id",
                  fileNamePrefix: "",
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
          lifecycleRules: [],
          revision: 1,
        },
        {
          accountId: "test-account-123",
          bucketId: "bucket-2",
          bucketName: "locked-bucket",
          bucketType: "allPrivate",
          bucketInfo: {},
          corsRules: [],
          defaultServerSideEncryption: { mode: null, algorithm: null },
          defaultRetention: undefined,
          fileLockConfiguration: {
            isClientAuthorizedToRead: true,
            value: {
              isFileLockEnabled: true,
              defaultRetention: { mode: "none", period: null },
            },
          },
          replicationConfiguration: {
            asReplicationSource: null,
            asReplicationDestination: null,
          },
          lifecycleRules: [],
          options: [],
          revision: 1,
        },
      ]);
    });

    it("normalizes optional native create and update bucket payload fields", async () => {
      const createBucket = vi.fn(async () => ({
        info: bucketInfo({ bucketName: "created-bucket" }),
      }));
      const updateBucket = vi.fn(async () => bucketInfo({ bucketName: "updated-bucket" }));
      const sdk = {
        createBucket,
        raw: { updateBucket },
      };
      const { client } = clientWithMockedNativeSdk(sdk);
      const fullBucketOptions = {
        bucketInfo: { env: "test" },
        corsRules: [
          {
            corsRuleName: "rule-one",
            allowedOrigins: ["https://example.com"],
            allowedOperations: ["b2_download_file_by_name"],
            maxAgeSeconds: 3600,
          },
          {
            corsRuleName: "rule-two",
            allowedOrigins: ["https://ops.example.com"],
            allowedHeaders: ["authorization"],
            allowedOperations: ["b2_upload_file"],
            exposeHeaders: ["x-bz-file-id"],
            maxAgeSeconds: 60,
          },
        ],
        defaultServerSideEncryption: { mode: "none" as const },
        defaultRetention: { mode: null, period: null },
        fileLockEnabled: false,
        lifecycleRules: [
          {
            fileNamePrefix: "tmp/",
            daysFromUploadingToHiding: 3,
            daysFromStartingToCancelingUnfinishedLargeFiles: null,
          },
        ],
        replicationConfiguration: {
          asReplicationSource: {
            sourceApplicationKeyId: "source-key-id",
            replicationRules: [
              {
                replicationRuleName: "copy-all",
                destinationBucketId: "dest-bucket-id",
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
      };
      const normalizedBucketOptions = {
        bucketInfo: { env: "test" },
        corsRules: [
          {
            corsRuleName: "rule-one",
            allowedOrigins: ["https://example.com"],
            allowedHeaders: null,
            allowedOperations: ["b2_download_file_by_name"],
            exposeHeaders: null,
            maxAgeSeconds: 3600,
          },
          {
            corsRuleName: "rule-two",
            allowedOrigins: ["https://ops.example.com"],
            allowedHeaders: ["authorization"],
            allowedOperations: ["b2_upload_file"],
            exposeHeaders: ["x-bz-file-id"],
            maxAgeSeconds: 60,
          },
        ],
        defaultServerSideEncryption: { mode: "none" },
        defaultRetention: { mode: "none", period: null },
        fileLockEnabled: false,
        lifecycleRules: [
          {
            fileNamePrefix: "tmp/",
            daysFromHidingToDeleting: null,
            daysFromUploadingToHiding: 3,
            daysFromStartingToCancelingUnfinishedLargeFiles: null,
          },
        ],
        replicationConfiguration: {
          asReplicationSource: {
            sourceApplicationKeyId: "source-key-id",
            replicationRules: [
              {
                replicationRuleName: "copy-all",
                destinationBucketId: "dest-bucket-id",
                fileNamePrefix: "",
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
      };

      await expect(
        client.createBucket({
          bucketName: "created-bucket",
          bucketType: "allPrivate",
          ...fullBucketOptions,
        }),
      ).resolves.toMatchObject({ bucketName: "created-bucket" });
      await expect(
        client.updateBucket({
          bucketId: "bucket-1",
          bucketType: "allPublic",
          ifRevisionIs: 7,
          ...fullBucketOptions,
        }),
      ).resolves.toMatchObject({ bucketName: "updated-bucket" });

      expect(createBucket).toHaveBeenCalledWith({
        bucketName: "created-bucket",
        bucketType: "allPrivate",
        ...normalizedBucketOptions,
      });
      expect(updateBucket).toHaveBeenCalledWith("https://api005.backblazeb2.com", "native-token", {
        accountId: "test-account-123",
        bucketId: "bucket-1",
        bucketType: "allPublic",
        ...normalizedBucketOptions,
        ifRevisionIs: 7,
      });
    });

    it("normalizes nullable multi-bucket key scopes", async () => {
      const createKey = vi.fn(async (options: object) => {
        const request = options as Record<string, unknown>;
        const keyName = String(request.keyName);
        return {
          keyName,
          applicationKeyId: `key-${keyName}`,
          applicationKey: `secret-${keyName}`,
          capabilities: ["listFiles"],
          accountId: "test-account-123",
          expirationTimestamp: null,
          bucketIds: request.bucketIds ?? null,
          bucketId: request.bucketId ?? null,
          namePrefix: null,
          options: [],
        };
      });
      const sdk = { createKey };
      const { client } = clientWithMockedNativeSdk(sdk);

      await expect(
        client.createKey({
          keyName: "all-buckets",
          capabilities: ["listFiles"],
          validDurationInSeconds: 60,
          namePrefix: "logs/",
          bucketIds: null,
        }),
      ).resolves.toMatchObject({ keyName: "all-buckets", bucketIds: null });
      await expect(
        client.createKey({
          keyName: "some-buckets",
          capabilities: ["listFiles"],
          bucketIds: ["bucket-1", "bucket-2"],
        }),
      ).resolves.toMatchObject({ keyName: "some-buckets", bucketIds: ["bucket-1", "bucket-2"] });

      expect(createKey).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          keyName: "all-buckets",
          validDurationInSeconds: 60,
          namePrefix: "logs/",
          bucketIds: null,
        }),
      );
      expect(createKey).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ keyName: "some-buckets", bucketIds: ["bucket-1", "bucket-2"] }),
      );
    });

    it("normalizes notification-rule defaults and object-form custom headers", async () => {
      const setBucketNotificationRules = vi.fn(
        async (_apiUrl: string, _authorizationToken: string, request: object) => {
          const body = request as Record<string, unknown>;
          return {
            bucketId: body.bucketId,
            eventNotificationRules: body.eventNotificationRules,
          };
        },
      );
      const sdk = {
        raw: { setBucketNotificationRules },
      };
      const { client } = clientWithMockedNativeSdk(sdk);

      await expect(
        client.setBucketNotificationRules("bucket-1", [
          {
            name: "rule-one",
            eventTypes: ["b2:ObjectCreated:*"],
            isEnabled: true,
            targetConfiguration: {
              targetType: "webhook",
              url: "https://hooks.example.com/b2",
              customHeaders: { "X-Trace": "trace-id" },
            },
          },
        ]),
      ).resolves.toEqual({
        bucketId: "bucket-1",
        eventNotificationRules: [
          {
            name: "rule-one",
            eventTypes: ["b2:ObjectCreated:*"],
            isEnabled: true,
            isSuspended: false,
            objectNamePrefix: "",
            suspensionReason: "",
            targetConfiguration: {
              targetType: "webhook",
              url: "https://hooks.example.com/b2",
              customHeaders: { "X-Trace": "trace-id" },
            },
          },
        ],
      });
      expect(setBucketNotificationRules).toHaveBeenCalledWith(
        "https://api005.backblazeb2.com",
        "native-token",
        expect.objectContaining({
          bucketId: "bucket-1",
          eventNotificationRules: [
            expect.objectContaining({
              isSuspended: false,
              objectNamePrefix: "",
              suspensionReason: "",
              targetConfiguration: expect.objectContaining({
                customHeaders: { "X-Trace": "trace-id" },
              }),
            }),
          ],
        }),
      );
    });
  });

  describe("S3 version resolution", () => {
    it("rejects S3 version IDs that resolve to a different key in the same bucket", async () => {
      const transport = new RecordingTransport((request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          return new StaticHttpResponse(200, authResponseWithToken("version-token"));
        }
        if (endpoint === "b2_list_buckets") {
          return new StaticHttpResponse(200, bucketListResponse("versioned-bucket"));
        }
        if (endpoint === "b2_get_file_info") {
          return new StaticHttpResponse(200, {
            accountId: "test-account-123",
            bucketId: "bucket-1",
            fileId: "version-a",
            fileName: "other-key.txt",
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
      const client = clientWithTransport(transport);

      await expect(
        client.resolveS3FileVersion({
          bucket: "versioned-bucket",
          key: "expected-key.txt",
          versionId: "version-a",
        }),
      ).rejects.toMatchObject({ status: 404, code: "not_found" });
    });

    it("rejects S3 version IDs that resolve to another bucket", async () => {
      const sdk = {
        getBucket: vi.fn(async () => ({ id: "bucket-1" })),
        raw: {
          getFileInfo: vi.fn(async () =>
            fileVersion({
              fileId: "version-a",
              fileName: "expected-key.txt",
              bucketId: "bucket-2",
            }),
          ),
        },
      };
      const { client } = clientWithMockedNativeSdk(sdk);

      await expect(
        client.resolveS3FileVersion({
          bucket: "versioned-bucket",
          key: "expected-key.txt",
          versionId: "version-a",
        }),
      ).rejects.toMatchObject({ status: 404, code: "not_found" });
    });

    it("returns unversioned bulk S3 targets without native lookups", async () => {
      const sdk = {
        getBucket: vi.fn(async () => ({ id: "bucket-1" })),
        raw: {
          getFileInfo: vi.fn(async () => fileVersion()),
        },
      };
      const { authManager, client } = clientWithMockedNativeSdk(sdk);

      await expect(
        client.resolveS3FileVersions({ bucket: "bucket", objects: [] }),
      ).resolves.toEqual([]);
      await expect(
        client.resolveS3FileVersions({
          bucket: "bucket",
          objects: [{ key: "latest-a.txt" }, { key: "latest-b.txt" }],
        }),
      ).resolves.toEqual([
        { object: { key: "latest-a.txt" }, version: null },
        { object: { key: "latest-b.txt" }, version: null },
      ]);

      expect(authManager.getAuthorizedSdk).not.toHaveBeenCalled();
      expect(sdk.getBucket).not.toHaveBeenCalled();
      expect(sdk.raw.getFileInfo).not.toHaveBeenCalled();
    });

    it("records per-object bulk S3 version binding errors", async () => {
      const sdk = {
        getBucket: vi.fn(async () => ({ id: "bucket-1" })),
        raw: {
          getFileInfo: vi.fn(
            async (_apiUrl: string, _authorizationToken: string, request: object) => {
              const body = request as Record<string, unknown>;
              if (body.fileId === "version-a") {
                return fileVersion({
                  fileId: "version-a",
                  fileName: "a.txt",
                  bucketId: "bucket-1",
                });
              }
              return fileVersion({
                fileId: "version-b",
                fileName: "other.txt",
                bucketId: "bucket-1",
              });
            },
          ),
        },
      };
      const { client } = clientWithMockedNativeSdk(sdk);

      const result = await client.resolveS3FileVersions({
        bucket: "bucket",
        objects: [
          { key: "a.txt", versionId: "version-a" },
          { key: "b.txt", versionId: "version-b" },
          { key: "latest.txt" },
        ],
      });

      expect(result[0]).toMatchObject({
        object: { key: "a.txt" },
        version: { fileId: "version-a" },
      });
      expect(result[1]).toMatchObject({
        object: { key: "b.txt" },
        version: null,
        error: { status: 404, code: "not_found" },
      });
      expect(result[2]).toEqual({ object: { key: "latest.txt" }, version: null });
    });

    it("fails version binding closed when the bucket lookup returns no bucket", async () => {
      const sdk = {
        getBucket: vi.fn(async () => null),
        raw: {
          getFileInfo: vi.fn(async () => fileVersion()),
        },
      };
      const { client } = clientWithMockedNativeSdk(sdk);

      await expect(
        client.resolveS3FileVersion({ bucket: "missing-bucket", key: "a.txt", versionId: "v1" }),
      ).rejects.toMatchObject({ status: 404, code: "not_found" });
      await expect(
        client.getCurrentS3FileVersion({ bucket: "missing-bucket", key: "a.txt" }),
      ).rejects.toMatchObject({ status: 404, code: "not_found" });

      expect(sdk.raw.getFileInfo).not.toHaveBeenCalled();
    });

    it("resolves the current native hide marker for S3 delete-marker synthesis", async () => {
      const uploadTimestamp = Date.parse("2026-01-02T03:04:05.000Z");
      const transport = new RecordingTransport((request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          return new StaticHttpResponse(200, authResponseWithToken("current-version-token"));
        }
        if (endpoint === "b2_list_buckets") {
          return new StaticHttpResponse(200, bucketListResponse("versioned-bucket"));
        }
        if (endpoint === "b2_list_file_versions") {
          const body = requestJson(request);
          expect(body).toMatchObject({
            bucketId: "bucket-1",
            prefix: "deleted.txt",
            maxFileCount: 1,
          });
          return new StaticHttpResponse(200, {
            files: [
              {
                accountId: "test-account-123",
                bucketId: "bucket-1",
                fileId: "hide-version-1",
                fileName: "deleted.txt",
                action: "hide",
                contentLength: 0,
                contentSha1: "none",
                contentType: "application/octet-stream",
                fileInfo: { src_last_modified_millis: String(uploadTimestamp) },
                uploadTimestamp,
                serverSideEncryption: { mode: "SSE-B2", algorithm: "AES256" },
              },
            ],
            nextFileName: null,
            nextFileId: null,
          });
        }
        return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
      });
      const client = clientWithTransport(transport);

      await expect(
        client.getCurrentS3FileVersion({ bucket: "versioned-bucket", key: "deleted.txt" }),
      ).resolves.toEqual({
        fileName: "deleted.txt",
        fileId: "hide-version-1",
        bucketId: "bucket-1",
        contentLength: 0,
        contentType: "application/octet-stream",
        uploadTimestamp,
        fileInfo: { src_last_modified_millis: String(uploadTimestamp) },
        action: "hide",
        serverSideEncryption: "AES256",
      });
    });

    it("returns null when the current native version page does not match the requested key", async () => {
      const sdk = {
        getBucket: vi.fn(async () => ({ id: "bucket-1" })),
        raw: {
          listFileVersions: vi.fn(async () => ({
            files: [fileVersion({ fileName: "prefix-neighbor.txt" })],
            nextFileName: null,
            nextFileId: null,
          })),
        },
      };
      const { client } = clientWithMockedNativeSdk(sdk);

      await expect(
        client.getCurrentS3FileVersion({ bucket: "versioned-bucket", key: "prefix.txt" }),
      ).resolves.toBeNull();
    });
  });

  describe("native raw lookup requests", () => {
    it("passes optional native listing request fields through raw lookup calls", async () => {
      const listFileNames = vi.fn(async () => ({
        files: [fileVersion({ fileName: "prefix/a.txt", contentLength: 42 })],
        nextFileName: "prefix/b.txt",
      }));
      const listUnfinishedLargeFiles = vi.fn(async () => ({
        files: [
          {
            fileId: "large-1",
            fileName: "prefix/large.bin",
            uploadTimestamp: Date.parse("2026-01-01T00:00:00.000Z"),
          },
        ],
        nextFileId: "large-2",
      }));
      const listParts = vi.fn(async () => ({
        parts: [{ partNumber: 1, contentLength: 1024 }],
        nextPartNumber: 2,
      }));
      const sdk = {
        raw: {
          listFileNames,
          listUnfinishedLargeFiles,
          listParts,
        },
      };
      const { client } = clientWithMockedNativeSdk(sdk);

      await expect(
        client.listFileNames({
          bucketId: "bucket-1",
          startFileName: "prefix/a.txt",
          maxFileCount: 1,
          prefix: "prefix/",
          delimiter: "/",
        }),
      ).resolves.toMatchObject({ nextFileName: "prefix/b.txt" });
      await expect(
        client.listUnfinishedLargeFiles({
          bucketId: "bucket-1",
          namePrefix: "prefix/",
          startFileId: "large-start",
          maxFileCount: 1,
        }),
      ).resolves.toMatchObject({ nextFileId: "large-2" });
      await expect(
        client.listParts({ fileId: "large-1", startPartNumber: 1, maxPartCount: 1 }),
      ).resolves.toMatchObject({ nextPartNumber: 2 });

      expect(listFileNames).toHaveBeenCalledWith(
        "https://api005.backblazeb2.com",
        "native-token",
        expect.objectContaining({
          bucketId: "bucket-1",
          startFileName: "prefix/a.txt",
          maxFileCount: 1,
          prefix: "prefix/",
          delimiter: "/",
        }),
        expect.any(Object),
      );
      expect(listUnfinishedLargeFiles).toHaveBeenCalledWith(
        "https://api005.backblazeb2.com",
        "native-token",
        expect.objectContaining({
          bucketId: "bucket-1",
          namePrefix: "prefix/",
          startFileId: "large-start",
          maxFileCount: 1,
        }),
        expect.any(Object),
      );
      expect(listParts).toHaveBeenCalledWith(
        "https://api005.backblazeb2.com",
        "native-token",
        expect.objectContaining({
          fileId: "large-1",
          startPartNumber: 1,
          maxPartCount: 1,
        }),
        expect.any(Object),
      );
    });
  });

  describe("Partner authorization", () => {
    it("refreshes stale cached Partner authorization before sending another read", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      let authorizeCount = 0;
      const listTokens: string[] = [];
      const transport = new RecordingTransport((request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          authorizeCount += 1;
          return new StaticHttpResponse(
            200,
            partnerAuthorizeResponse(`partner-token-${authorizeCount}`),
          );
        }
        if (endpoint === "b2_list_groups") {
          listTokens.push(new Headers(request.headers).get("Authorization") ?? "");
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
        client.listGroups({ adminAccountId: "test-account-123" }),
      ).resolves.toMatchObject({
        groups: [],
      });
      await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000 + 1);
      await expect(
        client.listGroups({ adminAccountId: "test-account-123" }),
      ).resolves.toMatchObject({
        groups: [],
      });

      expect(authorizeCount).toBe(2);
      expect(listTokens).toEqual(["partner-token-1", "partner-token-2"]);
    });

    it("refreshes stale cached Partner authorization before sending a mutation", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      let authorizeCount = 0;
      const ejectTokens: string[] = [];
      const transport = new RecordingTransport((request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          authorizeCount += 1;
          return new StaticHttpResponse(
            200,
            partnerAuthorizeResponse(`partner-token-${authorizeCount}`),
          );
        }
        if (endpoint === "b2_list_groups") {
          return new StaticHttpResponse(200, {
            accountId: "test-account-123",
            groups: [],
            nextGroupId: null,
          });
        }
        if (endpoint === "b2_eject_group_member") {
          ejectTokens.push(new Headers(request.headers).get("Authorization") ?? "");
          return new StaticHttpResponse(200, {
            accountId: "member-account-1",
            email: "member@example.com",
          });
        }
        return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
      });
      const client = clientWithTransport(transport);

      await expect(
        client.listGroups({ adminAccountId: "test-account-123" }),
      ).resolves.toMatchObject({
        groups: [],
      });
      await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000 + 1);
      await expect(
        client.ejectGroupMember({
          adminAccountId: "test-account-123",
          groupId: "123",
          memberAccountId: "member-account-1",
        }),
      ).resolves.toMatchObject({ accountId: "member-account-1" });

      expect(authorizeCount).toBe(2);
      expect(ejectTokens).toEqual(["partner-token-2"]);
      expect(
        transport.requests.filter((request) => b2EndpointName(request) === "b2_eject_group_member"),
      ).toHaveLength(1);
    });

    it("rejects Partner calls when authorize omits the Groups endpoint", async () => {
      const auth = partnerAuthorizeResponse();
      auth.apiInfo.groupsApi.groupsApiUrl = "";
      const raw = { listGroups: vi.fn() };
      setB2PartnerClientFactoryForTests(
        () =>
          ({
            authorize: vi.fn(async () => auth),
            partnerAccountInfo: {
              clear: vi.fn(),
              getAuth: vi.fn(() => null),
            },
            raw,
          }) as unknown as SdkPartnerClient,
      );
      const client = new B2Client(new B2AuthManager(testConfig));

      await expect(client.listGroups({ adminAccountId: "test-account-123" })).rejects.toThrow(
        /Partner API is not available/,
      );
      expect(raw.listGroups).not.toHaveBeenCalled();
    });

    it("keeps a successful Partner authorization after the starting caller aborts", async () => {
      const controller = new AbortController();
      controller.abort(new Error("caller stopped"));
      let authorizeCount = 0;
      const transport = new RecordingTransport((request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          authorizeCount += 1;
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
        runWithMcpRequestSignal(controller.signal, () =>
          client.listGroups({ adminAccountId: "test-account-123" }),
        ),
      ).rejects.toThrow("caller stopped");
      expect(
        transport.requests.filter((request) => b2EndpointName(request) === "b2_authorize_account"),
      ).toHaveLength(1);

      await expect(
        client.listGroups({ adminAccountId: "test-account-123" }),
      ).resolves.toMatchObject({
        groups: [],
      });
      expect(authorizeCount).toBe(1);
    });

    it("aborts a caller waiting on in-flight Partner authorization", async () => {
      const controller = new AbortController();
      let releaseAuthorize: (() => void) | undefined;
      const authorizeGate = new Promise<void>((resolve) => {
        releaseAuthorize = resolve;
      });
      const transport = new RecordingTransport(async (request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          await authorizeGate;
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

      const result = runWithMcpRequestSignal(controller.signal, () =>
        client.listGroups({ adminAccountId: "test-account-123" }),
      ).then(
        () => {
          throw new Error("Expected Partner list_groups to abort");
        },
        (err: unknown) => err,
      );

      await vi.waitFor(() =>
        expect(
          transport.requests.filter(
            (request) => b2EndpointName(request) === "b2_authorize_account",
          ),
        ).toHaveLength(1),
      );
      controller.abort(new Error("caller aborted in flight"));

      const error = await result;
      expect(error).toMatchObject({ message: "caller aborted in flight" });
      releaseAuthorize?.();
    });

    it("reauthorizes and retries a Partner read once after expired auth", async () => {
      let authorizeCount = 0;
      let listCount = 0;
      const transport = new RecordingTransport((request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          authorizeCount += 1;
          return new StaticHttpResponse(
            200,
            partnerAuthorizeResponse(`partner-token-${authorizeCount}`),
          );
        }
        if (endpoint === "b2_list_groups") {
          listCount += 1;
          if (listCount === 1) {
            return new StaticHttpResponse(401, {
              status: 401,
              code: "expired_auth_token",
              message: "expired",
            });
          }
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
        client.listGroups({ adminAccountId: "test-account-123" }),
      ).resolves.toMatchObject({
        groups: [],
      });

      expect(authorizeCount).toBe(2);
      expect(listCount).toBe(2);
    });

    it("invalidates Partner auth after a mutation 401 without reauthorizing or replaying", async () => {
      let authorizeCount = 0;
      const transport = new RecordingTransport((request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          authorizeCount += 1;
          return new StaticHttpResponse(
            200,
            partnerAuthorizeResponse(`partner-token-${authorizeCount}`),
          );
        }
        if (endpoint === "b2_eject_group_member") {
          return new StaticHttpResponse(401, {
            status: 401,
            code: "expired_auth_token",
            message: "expired",
          });
        }
        return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
      });
      const client = clientWithTransport(transport);

      await expect(
        client.ejectGroupMember({
          adminAccountId: "test-account-123",
          groupId: "123",
          memberAccountId: "member-account-1",
        }),
      ).rejects.toMatchObject({ status: 401, code: "expired_auth_token" });

      expect(authorizeCount).toBe(1);
      expect(
        transport.requests.filter((request) => b2EndpointName(request) === "b2_eject_group_member"),
      ).toHaveLength(1);
    });

    it("authorizes before the next Partner mutation after a mutation 401", async () => {
      let authorizeCount = 0;
      let ejectCount = 0;
      const ejectTokens: string[] = [];
      const transport = new RecordingTransport((request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          authorizeCount += 1;
          return new StaticHttpResponse(
            200,
            partnerAuthorizeResponse(`partner-token-${authorizeCount}`),
          );
        }
        if (endpoint === "b2_eject_group_member") {
          ejectCount += 1;
          ejectTokens.push(new Headers(request.headers).get("Authorization") ?? "");
          if (ejectCount === 1) {
            return new StaticHttpResponse(401, {
              status: 401,
              code: "expired_auth_token",
              message: "expired",
            });
          }
          return new StaticHttpResponse(200, {
            accountId: "member-account-1",
            email: "member@example.com",
          });
        }
        return new StaticHttpResponse(500, { status: 500, code: "unexpected", message: endpoint });
      });
      const client = clientWithTransport(transport);

      await expect(
        client.ejectGroupMember({
          adminAccountId: "test-account-123",
          groupId: "123",
          memberAccountId: "member-account-1",
        }),
      ).rejects.toMatchObject({ status: 401, code: "expired_auth_token" });
      await expect(
        client.ejectGroupMember({
          adminAccountId: "test-account-123",
          groupId: "123",
          memberAccountId: "member-account-1",
        }),
      ).resolves.toMatchObject({ accountId: "member-account-1" });

      expect(authorizeCount).toBe(2);
      expect(ejectTokens).toEqual(["partner-token-1", "partner-token-2"]);
      expect(ejectCount).toBe(2);
    });

    it("shares one in-flight Partner authorization for concurrent cold reads", async () => {
      let releaseAuthorize: (() => void) | undefined;
      const authorizeGate = new Promise<void>((resolve) => {
        releaseAuthorize = resolve;
      });
      const transport = new RecordingTransport(async (request) => {
        const endpoint = b2EndpointName(request);
        if (endpoint === "b2_authorize_account") {
          await authorizeGate;
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

      const first = client.listGroups({ adminAccountId: "test-account-123" });
      const second = client.listGroups({ adminAccountId: "test-account-123" });

      await vi.waitFor(() =>
        expect(
          transport.requests.filter(
            (request) => b2EndpointName(request) === "b2_authorize_account",
          ),
        ).toHaveLength(1),
      );
      releaseAuthorize?.();

      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(
        transport.requests.filter((request) => b2EndpointName(request) === "b2_list_groups"),
      ).toHaveLength(2);
    });

    it("limits default Partner SDK retries with the shared retry budget", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      _resetRetryBudget();
      for (let i = 0; i < 100; i++) _consumeRetryToken();
      expect(_consumeRetryToken()).toBe(false);

      let listCount = 0;
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const endpoint = url.pathname.split("/").pop();
        if (endpoint === "b2_authorize_account") {
          return new Response(
            JSON.stringify(
              partnerAuthorizeResponse(
                "partner-token-1",
                "test-account-123",
                "https://partner.backblaze.com",
              ),
            ),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (endpoint === "b2_list_groups") {
          listCount += 1;
          return new Response(
            JSON.stringify({ status: 500, code: "server_error", message: "bad" }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({ status: 500, code: "unexpected", message: endpoint }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new B2Client(new B2AuthManager(testConfig));

      const result = client.listGroups({ adminAccountId: "test-account-123" }).then(
        () => {
          throw new Error("Expected Partner list_groups to fail");
        },
        (err: unknown) => err,
      );
      await vi.waitFor(() => expect(listCount).toBe(1));
      while (_consumeRetryToken()) {
        // Drain any tokens that refill while the request reaches its first failure.
      }
      await vi.runAllTimersAsync();

      const error = await result;
      expect(String(error)).toMatch(/retry budget exhausted/i);
      expect(listCount).toBe(1);
    });

    it("limits default Partner authorize retries with the shared retry budget", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      _resetRetryBudget();
      for (let i = 0; i < 100; i++) _consumeRetryToken();
      expect(_consumeRetryToken()).toBe(false);

      let authorizeCount = 0;
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const endpoint = url.pathname.split("/").pop();
        if (endpoint === "b2_authorize_account") {
          authorizeCount += 1;
          return new Response(
            JSON.stringify({ status: 500, code: "server_error", message: "bad" }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({ status: 500, code: "unexpected", message: endpoint }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new B2Client(new B2AuthManager(testConfig));

      const result = client.listGroups({ adminAccountId: "test-account-123" }).then(
        () => {
          throw new Error("Expected Partner authorize to fail");
        },
        (err: unknown) => err,
      );
      await vi.waitFor(() => expect(authorizeCount).toBe(1));
      while (_consumeRetryToken()) {
        // Drain any tokens that refill while the first authorize request fails.
      }
      await vi.runAllTimersAsync();

      const error = await result;
      expect(String(error)).toMatch(/retry budget exhausted/i);
      expect(authorizeCount).toBe(1);
    });
  });
});
