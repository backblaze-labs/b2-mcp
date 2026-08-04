import {
  buildB2S3ClientConfig,
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
  });

  it("uses authorized-principal credentials for report clients", () => {
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

  it("rejects injected authorize-account S3 endpoints", () => {
    expect(validateB2S3ApiUrl("http://169.254.169.254/latest/meta-data", config.region)).toMatch(
      /https/,
    );
    expect(validateB2S3ApiUrl("https://attacker.example", config.region)).toContain(
      "s3.us-west-004.backblazeb2.com",
    );
    expect(validateB2S3ApiUrl("https://s3.us-west-004.backblazeb2.com", config.region)).toBeNull();
  });
});
