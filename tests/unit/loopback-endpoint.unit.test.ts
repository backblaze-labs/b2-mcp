vi.mock("@backblaze-labs/b2-sdk/s3", () => ({
  createS3ClientConfig: vi.fn((input) => ({
    endpoint: input.accountInfo.getS3ApiUrl(),
    region: input.region,
    credentials: {
      accessKeyId: input.applicationKeyId,
      secretAccessKey: input.applicationKey,
    },
  })),
}));

import { validateB2ApiUrl } from "../../src/b2/client";
import { createB2McpFetchHandler } from "../../src/http-fetch-handler";
import { buildHttpServer } from "../../src/http-server";
import {
  buildB2S3ClientConfig,
  expectedB2S3Endpoint,
  validateB2S3ApiUrl,
} from "../../src/s3/client";
import { logger } from "../../src/utils/logger";
import {
  activateLoopbackEndpointOverride,
  assertLoopbackEndpointOverrideUnset,
  isLoopbackEndpointUrl,
  LOOPBACK_ENDPOINT_ENV,
  loopbackEndpointOrigin,
  parseLoopbackEndpoint,
  resetLoopbackEndpointOverrideForTests,
} from "../../src/utils/loopback-endpoint";
import type { B2Config } from "../../src/utils/types";

const ORIGIN = "http://127.0.0.1:4566";

const config: B2Config = {
  applicationKeyId: "test-key-id",
  applicationKey: "test-key-secret",
  appKeyId: "test-key-id",
  appKey: "test-key-secret",
  masterKeyId: "test-key-id",
  masterKey: "test-key-secret",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
  transport: "stdio",
};

const DEFAULT_REJECTED = [
  ORIGIN,
  "http://127.0.0.1",
  "http://[::1]:4566",
  "http://localhost:4566",
  "https://127.0.0.1:4566",
  "https://localhost",
  "http://api005.backblazeb2.com",
  "https://api005.backblazeb2.com:8443",
  "https://s3.us-west-004.backblazeb2.com:8443",
  "https://evil.example.com",
];

describe("loopback endpoint override", () => {
  afterEach(() => {
    resetLoopbackEndpointOverrideForTests();
    vi.restoreAllMocks();
  });

  describe("without the variable", () => {
    it("leaves the override inactive", () => {
      expect(activateLoopbackEndpointOverride({})).toBeNull();
      expect(activateLoopbackEndpointOverride({ [LOOPBACK_ENDPOINT_ENV]: "" })).toBeNull();
      expect(loopbackEndpointOrigin()).toBeNull();
    });

    it.each(DEFAULT_REJECTED)("still rejects %s as a native API URL", (raw) => {
      expect(validateB2ApiUrl(raw)).toEqual(expect.any(String));
    });

    it.each(DEFAULT_REJECTED)("still rejects %s as an authorized S3 URL", (raw) => {
      expect(validateB2S3ApiUrl(raw, { mode: "authorized-region" })).toEqual(expect.any(String));
      expect(validateB2S3ApiUrl(raw, { mode: "exact-region", region: "us-west-004" })).toEqual(
        expect.any(String),
      );
    });

    it.each(DEFAULT_REJECTED)("refuses %s when building an authorized S3 config", (raw) => {
      expect(() => buildB2S3ClientConfig(config, { authorizedS3ApiUrl: raw })).toThrow(
        /Authorized B2 S3 endpoint/,
      );
    });

    it("keeps the default S3 endpoint and trusted hosts", () => {
      expect(expectedB2S3Endpoint("us-west-004")).toBe("https://s3.us-west-004.backblazeb2.com");
      expect(validateB2ApiUrl("https://api005.backblazeb2.com")).toBeNull();
      expect(
        validateB2S3ApiUrl("https://s3.us-west-004.backblazeb2.com", { mode: "authorized-region" }),
      ).toBeNull();
    });
  });

  describe("parsing", () => {
    it.each([
      [ORIGIN, ORIGIN],
      [`${ORIGIN}/`, ORIGIN],
      ["http://127.0.0.1", "http://127.0.0.1"],
      ["http://[::1]:9000", "http://[::1]:9000"],
      ["  http://127.0.0.1:80  ", "http://127.0.0.1"],
    ])("accepts %s", (raw, expected) => {
      expect(parseLoopbackEndpoint(raw)).toBe(expected);
    });

    it.each([
      "not a url",
      "https://127.0.0.1:4566",
      "http://localhost:4566",
      "http://127.0.0.2:4566",
      "http://0.0.0.0:4566",
      "http://192.168.1.10:4566",
      "http://169.254.169.254",
      "http://api005.backblazeb2.com",
      "http://example.com",
      "http://127.0.0.1.example.com",
      "http://user:pass@127.0.0.1:4566",
      "http://127.0.0.1:4566/path",
      "http://127.0.0.1:4566?x=1",
      "http://127.0.0.1:4566#frag",
      "ftp://127.0.0.1",
    ])("rejects %s", (raw) => {
      expect(() => parseLoopbackEndpoint(raw)).toThrow(LOOPBACK_ENDPOINT_ENV);
    });
  });

  describe("activation", () => {
    it("activates a loopback origin and logs a visible warning", () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      expect(activateLoopbackEndpointOverride({ [LOOPBACK_ENDPOINT_ENV]: ORIGIN })).toBe(ORIGIN);
      expect(loopbackEndpointOrigin()).toBe(ORIGIN);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ origin: ORIGIN }),
        "endpoint.loopback_override.active",
      );
    });

    it("refuses to activate when NODE_ENV is production", () => {
      expect(() =>
        activateLoopbackEndpointOverride({
          [LOOPBACK_ENDPOINT_ENV]: ORIGIN,
          NODE_ENV: "production",
        }),
      ).toThrow(/production/);
      expect(loopbackEndpointOrigin()).toBeNull();
    });

    it.each(["http://example.com", "https://127.0.0.1:4566", "garbage"])(
      "fails closed on the invalid value %s",
      (raw) => {
        expect(() => activateLoopbackEndpointOverride({ [LOOPBACK_ENDPOINT_ENV]: raw })).toThrow(
          LOOPBACK_ENDPOINT_ENV,
        );
        expect(loopbackEndpointOrigin()).toBeNull();
      },
    );
  });

  describe("HTTP and serverless refusal", () => {
    it("passes when the variable is unset", () => {
      expect(() => assertLoopbackEndpointOverrideUnset({})).not.toThrow();
      expect(() =>
        assertLoopbackEndpointOverrideUnset({ [LOOPBACK_ENDPOINT_ENV]: "" }),
      ).not.toThrow();
    });

    it("throws when the variable is set", () => {
      expect(() =>
        assertLoopbackEndpointOverrideUnset({ [LOOPBACK_ENDPOINT_ENV]: ORIGIN }),
      ).toThrow(/only supported on the stdio transport/);
    });

    it("refuses to build the HTTP pipeline or server while the variable is set", () => {
      vi.stubEnv(LOOPBACK_ENDPOINT_ENV, ORIGIN);
      try {
        expect(() => createB2McpFetchHandler()).toThrow(/stdio transport/);
        expect(() => buildHttpServer()).toThrow(/stdio transport/);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("while active", () => {
    beforeEach(() => {
      vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      activateLoopbackEndpointOverride({ [LOOPBACK_ENDPOINT_ENV]: ORIGIN });
    });

    it("accepts exactly the configured origin for native and S3 URLs", () => {
      for (const raw of [ORIGIN, `${ORIGIN}/`]) {
        expect(isLoopbackEndpointUrl(raw)).toBe(true);
        expect(validateB2ApiUrl(raw)).toBeNull();
        expect(validateB2S3ApiUrl(raw, { mode: "authorized-region" })).toBeNull();
        expect(validateB2S3ApiUrl(raw, { mode: "exact-region", region: "us-west-004" })).toBeNull();
      }
    });

    it.each([
      "http://127.0.0.1:4567",
      "http://127.0.0.1",
      "http://[::1]:4566",
      "http://localhost:4566",
      "http://127.0.0.1:4566.evil.example",
      "http://127.0.0.1:4566/path",
      "http://user:pass@127.0.0.1:4566",
      "https://127.0.0.1:4566",
      "http://192.168.1.10:4566",
      "http://169.254.169.254",
      "http://evil.example.com",
      "https://evil.example.com",
    ])("still rejects %s", (raw) => {
      expect(isLoopbackEndpointUrl(raw)).toBe(false);
      expect(validateB2ApiUrl(raw)).toEqual(expect.any(String));
      expect(validateB2S3ApiUrl(raw, { mode: "authorized-region" })).toEqual(expect.any(String));
    });

    it("keeps trusted Backblaze hosts valid", () => {
      expect(validateB2ApiUrl("https://api005.backblazeb2.com")).toBeNull();
    });

    it("signs S3 requests for the loopback origin with the configured region", () => {
      const s3 = buildB2S3ClientConfig(config, { authorizedS3ApiUrl: ORIGIN });
      expect(s3.endpoint).toBe(ORIGIN);
      expect(s3.region).toBe("us-west-004");
      expect(expectedB2S3Endpoint("us-west-004")).toBe(ORIGIN);
    });

    it("still refuses an authorized S3 URL outside the origin", () => {
      expect(() =>
        buildB2S3ClientConfig(config, { authorizedS3ApiUrl: "http://127.0.0.1:9999" }),
      ).toThrow(/Authorized B2 S3 endpoint/);
    });
  });
});
