import {
  accountInfoForS3Endpoint,
  buildB2S3ClientConfig,
  createReportS3Client,
  createS3ObjectClient,
  expectedB2S3Endpoint,
  validateB2S3ApiUrl,
} from "../../src/s3/client";
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

describe("B2 S3 client configuration", () => {
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
      ["backblaze-b2-mcp", expect.any(String)],
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
        ["backblaze-b2-mcp", expect.any(String)],
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
      authorizedS3ApiUrl: "https://s3.us-west-004.backblazeb2.com",
      surface: "b2-insights-reports",
    });

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
    expect(validateB2S3ApiUrl("http://169.254.169.254/latest/meta-data", config.region)).toMatch(
      /https/,
    );
    expect(
      validateB2S3ApiUrl("https://key:secret@s3.us-west-004.backblazeb2.com", config.region),
    ).toContain("credentials");
    expect(validateB2S3ApiUrl("https://attacker.example", config.region)).toContain(
      "s3.us-west-004.backblazeb2.com",
    );
    expect(
      validateB2S3ApiUrl("https://s3.us-west-004.backblazeb2.com:8443", config.region),
    ).toContain("custom port");
    expect(
      validateB2S3ApiUrl("https://s3.us-west-004.backblazeb2.com/path", config.region),
    ).toContain("path");
    expect(validateB2S3ApiUrl("not a url", config.region)).toContain("valid URL");
    expect(validateB2S3ApiUrl("https://s3.us-west-004.backblazeb2.com", config.region)).toBeNull();
  });

  it("rejects mismatched authorized S3 endpoints while building report config", () => {
    expect(() =>
      buildB2S3ClientConfig(config, {
        authorizedS3ApiUrl: "https://s3.us-east-005.backblazeb2.com",
        surface: "b2-insights-reports",
      }),
    ).toThrow(/Authorized B2 S3 endpoint must match s3\.us-west-004\.backblazeb2\.com/);
  });

  it("keeps the endpoint-only AccountInfo shim credential-free", () => {
    const accountInfo = accountInfoForS3Endpoint("https://s3.us-west-004.backblazeb2.com");
    const bucketId = "bucket-id" as never;
    const fileId = "file-id" as never;
    const uploadUrlEntry = {
      uploadUrl: "https://upload.example",
      authorizationToken: "upload-token",
    } as never;

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

  it.each([
    ["getApiUrl"],
    ["getDownloadUrl"],
    ["getAuthToken"],
    ["getAccountId"],
    ["getRecommendedPartSize"],
    ["getAbsoluteMinimumPartSize"],
  ] as const)("throws if the S3 helper unexpectedly asks for %s", (method) => {
    const accountInfo = accountInfoForS3Endpoint("https://s3.us-west-004.backblazeb2.com");

    expect(() => accountInfo[method]()).toThrow(
      `${method} is not used when deriving B2 S3 client configuration.`,
    );
  });
});
