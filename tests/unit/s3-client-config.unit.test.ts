interface CapturedEndpointAccountInfo {
  setAuth(auth: unknown): void;
  getAuth(): unknown;
  clear(): void;
  getS3ApiUrl(): string;
  getAllowedBucketId(): unknown;
  getAllowedBucketIds(): readonly unknown[] | null;
  checkoutUploadUrl(bucketId: string): unknown;
  returnUploadUrl(bucketId: string, entry: unknown): void;
  evictUploadUrl(bucketId: string, entry: unknown): void;
  checkoutPartUploadUrl(fileId: string): unknown;
  returnPartUploadUrl(fileId: string, entry: unknown): void;
  evictPartUploadUrl(fileId: string, entry: unknown): void;
  getApiUrl(): string;
  getDownloadUrl(): string;
  getAuthToken(): string;
  getAccountId(): string;
  getRecommendedPartSize(): number;
  getAbsoluteMinimumPartSize(): number;
}

const capturedS3ConfigInputs = vi.hoisted(
  () =>
    [] as Array<{
      accountInfo: CapturedEndpointAccountInfo;
      applicationKeyId: string;
      applicationKey: string;
      region: string;
    }>,
);

vi.mock("@backblaze-labs/b2-sdk/s3", () => ({
  createS3ClientConfig: vi.fn((input) => {
    capturedS3ConfigInputs.push(input);
    return {
      endpoint: input.accountInfo.getS3ApiUrl(),
      region: input.region,
      credentials: {
        accessKeyId: input.applicationKeyId,
        secretAccessKey: input.applicationKey,
      },
    };
  }),
}));

import {
  buildB2S3ClientConfig,
  createReportS3Client,
  createS3ObjectClient,
  expectedB2S3Endpoint,
  validateB2S3ApiUrl,
} from "../../src/s3/client";
import { logger } from "../../src/utils/logger";
import type { B2Config } from "../../src/utils/types";

const config: B2Config = {
  applicationKeyId: "principal-key-id",
  applicationKey: "principal-secret",
  appKeyId: "legacy-s3-key-id",
  appKey: "legacy-s3-secret",
  masterKeyId: "master-key-id",
  masterKey: "master-secret",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
  transport: "stdio",
};

function capturedEndpointAccountInfo(): CapturedEndpointAccountInfo {
  buildB2S3ClientConfig(config);
  const accountInfo = capturedS3ConfigInputs.at(-1)?.accountInfo;
  if (!accountInfo) throw new Error("Expected buildB2S3ClientConfig to pass AccountInfo.");
  return accountInfo;
}

describe("B2 S3 client configuration", () => {
  beforeEach(() => {
    capturedS3ConfigInputs.length = 0;
  });

  it("uses path-style addressing and the trusted B2 S3 endpoint", () => {
    const s3 = buildB2S3ClientConfig(config);

    expect(s3.endpoint).toBe(expectedB2S3Endpoint("us-west-004"));
    expect(s3.forcePathStyle).toBe(true);
    expect(s3.region).toBe("us-west-004");
    expect(s3.credentials).toEqual({
      accessKeyId: "legacy-s3-key-id",
      secretAccessKey: "legacy-s3-secret",
    });
    expect(s3.maxAttempts).toBeUndefined();
  });

  it("can build primary object-tool config with caller credentials", () => {
    const s3 = buildB2S3ClientConfig(config, {
      applicationKeyId: config.applicationKeyId,
      applicationKey: config.applicationKey,
      surface: "s3-object-tools",
    });

    expect(s3.credentials).toEqual({
      accessKeyId: "principal-key-id",
      secretAccessKey: "principal-secret",
    });
    expect(s3.customUserAgent).toEqual([
      ["b2-mcp", "dev"],
      ["transport", "stdio"],
      ["surface", "s3-object-tools"],
    ]);
  });

  it("adds the optional user-agent suffix after the surface tag", () => {
    const previous = process.env.B2_MCP_UA_SUFFIX;
    process.env.B2_MCP_UA_SUFFIX = " tenant-a ";
    try {
      const s3 = buildB2S3ClientConfig(
        { ...config, transport: "http" },
        { surface: "s3-object-tools" },
      );

      expect(s3.customUserAgent).toEqual([
        ["b2-mcp", "dev"],
        ["transport", "http"],
        ["surface", "s3-object-tools"],
        ["suffix", "tenant-a"],
      ]);
    } finally {
      if (previous === undefined) delete process.env.B2_MCP_UA_SUFFIX;
      else process.env.B2_MCP_UA_SUFFIX = previous;
    }
  });

  it("creates object clients with the configured S3 credential override", async () => {
    const s3 = createS3ObjectClient(config, "s3-object-tools");

    expect(typeof s3.destroy).toBe("function");
    expect((s3 as unknown as { config?: unknown }).config).toBeUndefined();
    expect((s3 as unknown as { send?: unknown }).send).toBeUndefined();
    s3.destroy();
  });

  it("can build report client config with explicit caller credentials", () => {
    const s3 = buildB2S3ClientConfig(config, {
      applicationKeyId: config.applicationKeyId,
      applicationKey: config.applicationKey,
      authorizedS3ApiUrl: "https://s3.us-east-005.backblazeb2.com",
      surface: "b2-insights-reports",
    });

    expect(s3.endpoint).toBe("https://s3.us-east-005.backblazeb2.com");
    expect(s3.region).toBe("us-east-005");
    expect(s3.credentials).toEqual({
      accessKeyId: "principal-key-id",
      secretAccessKey: "principal-secret",
    });
    expect(JSON.stringify(s3.customUserAgent)).toContain("b2-insights-reports");
  });

  it("creates report clients with the authorized caller credential", async () => {
    const s3 = createReportS3Client(config, {
      accountId: "acct",
      authorizationToken: "token",
      apiUrl: "https://api005.backblazeb2.com",
      downloadUrl: "https://f005.backblazeb2.com",
      s3ApiUrl: "https://s3.us-west-004.backblazeb2.com",
      recommendedPartSize: 1,
      absoluteMinimumPartSize: 1,
      capabilities: [],
    });

    expect(typeof s3.destroy).toBe("function");
    expect((s3 as unknown as { config?: unknown }).config).toBeUndefined();
    expect((s3 as unknown as { send?: unknown }).send).toBeUndefined();
    s3.destroy();
  });

  it("rejects injected authorize-account S3 endpoints", () => {
    expect(
      validateB2S3ApiUrl("http://169.254.169.254/latest/meta-data", {
        mode: "exact-region",
        region: config.region,
      }),
    ).toMatch(/https/);
    expect(
      validateB2S3ApiUrl("https://key:secret@s3.us-west-004.backblazeb2.com", {
        mode: "exact-region",
        region: config.region,
      }),
    ).toContain("credentials");
    expect(
      validateB2S3ApiUrl("https://attacker.example", {
        mode: "exact-region",
        region: config.region,
      }),
    ).toContain("s3.us-west-004.backblazeb2.com");
    expect(
      validateB2S3ApiUrl("https://s3.us-west-004.backblazeb2.com:8443", {
        mode: "exact-region",
        region: config.region,
      }),
    ).toContain("custom port");
    expect(
      validateB2S3ApiUrl("https://s3.us-west-004.backblazeb2.com/path", {
        mode: "exact-region",
        region: config.region,
      }),
    ).toContain("path");
    expect(
      validateB2S3ApiUrl("not a url", { mode: "exact-region", region: config.region }),
    ).toContain("valid URL");
    expect(
      validateB2S3ApiUrl("https://s3.us-west-004.backblazeb2.com", {
        mode: "exact-region",
        region: config.region,
      }),
    ).toBeNull();
  });

  it("keeps authorized endpoint validation confined to B2 S3 hosts", () => {
    expect(
      validateB2S3ApiUrl("https://s3.us-east-005.backblazeb2.com", {
        mode: "authorized-region",
      }),
    ).toBeNull();
    expect(validateB2S3ApiUrl("https://attacker.example", { mode: "authorized-region" })).toContain(
      "s3.<region>.backblazeb2.com",
    );
    expect(
      validateB2S3ApiUrl("http://169.254.169.254/latest/meta-data", {
        mode: "authorized-region",
      }),
    ).toContain("https");
  });

  it.each([
    [
      "trailing suffix host",
      "https://s3.us-west-004.backblazeb2.com.attacker.com",
      "s3.<region>.backblazeb2.com",
    ],
    [
      "embedded S3 host in path",
      "https://attacker.com/s3.us-east-005.backblazeb2.com",
      "s3.<region>.backblazeb2.com",
    ],
    ["embedded credentials", "https://user:pass@s3.us-east-005.backblazeb2.com", "credentials"],
    ["custom port", "https://s3.us-east-005.backblazeb2.com:8443", "custom port"],
  ])("rejects authorized endpoint hostname-confusion payloads: %s", (_name, raw, reason) => {
    expect(validateB2S3ApiUrl(raw, { mode: "authorized-region" })).toContain(reason);
  });

  it("logs when the authorized S3 region overrides configured B2_REGION", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      buildB2S3ClientConfig(config, {
        authorizedS3ApiUrl: "https://s3.us-east-005.backblazeb2.com",
        surface: "b2-insights-reports",
      });

      expect(warnSpy).toHaveBeenCalledWith(
        {
          configuredRegion: "us-west-004",
          authorizedRegion: "us-east-005",
          authorizedEndpoint: "https://s3.us-east-005.backblazeb2.com",
        },
        "s3.authorized_region.override",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("derives the S3 signing region from authorized S3 endpoints", () => {
    const s3 = buildB2S3ClientConfig(config, {
      authorizedS3ApiUrl: "https://s3.us-east-005.backblazeb2.com",
      surface: "b2-insights-reports",
    });

    expect(s3.endpoint).toBe("https://s3.us-east-005.backblazeb2.com");
    expect(s3.region).toBe("us-east-005");
    expect(capturedS3ConfigInputs.at(-1)).toMatchObject({
      region: "us-east-005",
    });
    expect(capturedS3ConfigInputs.at(-1)?.accountInfo.getS3ApiUrl()).toBe(
      "https://s3.us-east-005.backblazeb2.com",
    );
  });

  it("rejects non-B2 authorized S3 endpoints while building report config", () => {
    expect(() =>
      buildB2S3ClientConfig(config, {
        authorizedS3ApiUrl: "https://attacker.example",
        surface: "b2-insights-reports",
      }),
    ).toThrow(/Authorized B2 S3 endpoint must match s3\.<region>\.backblazeb2\.com/);
  });

  it("keeps the endpoint-only AccountInfo shim credential-free", () => {
    const accountInfo = capturedEndpointAccountInfo();
    const bucketId = "bucket-id";
    const fileId = "file-id";
    const uploadUrlEntry = {
      uploadUrl: "https://upload.example",
      authorizationToken: "upload-token",
    };

    accountInfo.setAuth({} as never);
    accountInfo.clear();
    accountInfo.returnUploadUrl(bucketId, uploadUrlEntry);
    accountInfo.evictUploadUrl(bucketId, uploadUrlEntry);
    accountInfo.returnPartUploadUrl(fileId, uploadUrlEntry);
    accountInfo.evictPartUploadUrl(fileId, uploadUrlEntry);

    expect(accountInfo.getAuth()).toBeNull();
    expect(accountInfo.getS3ApiUrl()).toBe("https://s3.us-west-004.backblazeb2.com");
    expect(accountInfo.getAllowedBucketId()).toBeNull();
    expect(accountInfo.getAllowedBucketIds()).toBeNull();
    expect(accountInfo.checkoutUploadUrl(bucketId)).toBeNull();
    expect(accountInfo.checkoutPartUploadUrl(fileId)).toBeNull();
  });

  // This deliberately exercises the defensive credential-free shim surface. If
  // a future SDK helper starts asking for native B2 authorization state, S3
  // config derivation must keep failing closed instead of inventing credentials.
  it.each([
    ["getApiUrl"],
    ["getDownloadUrl"],
    ["getAuthToken"],
    ["getAccountId"],
    ["getRecommendedPartSize"],
    ["getAbsoluteMinimumPartSize"],
  ] as const)("throws if the S3 helper unexpectedly asks for %s", (method) => {
    const accountInfo = capturedEndpointAccountInfo();

    expect(() => accountInfo[method]()).toThrow(Error);
  });
});
