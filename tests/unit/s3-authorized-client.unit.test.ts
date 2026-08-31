import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the configs createB2S3PeerClient is built with so we can tell a
// configured-region fallback apart from an authorized-endpoint build.
const peerBuilds = vi.hoisted(() => [] as Array<{ endpoint: unknown; region: unknown }>);

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

vi.mock("../../src/s3/aws-sdk-adapter.js", () => ({
  createB2S3PeerClient: vi.fn((config: { endpoint: unknown; region: unknown }) => {
    peerBuilds.push({ endpoint: config.endpoint, region: config.region });
    return {
      endpoint: config.endpoint,
      region: config.region,
      headBucket: vi.fn(async () => ({ ok: true })),
      destroy: vi.fn(),
    };
  }),
}));

import { createAuthorizedS3Client, expectedB2S3Endpoint } from "../../src/s3/client";
import type { B2AuthResponse, B2Config } from "../../src/utils/types";

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

function authResponse(s3ApiUrl: string): B2AuthResponse {
  return {
    accountId: "acct",
    authorizationToken: "token",
    apiUrl: "https://api.backblazeb2.com",
    downloadUrl: "https://f000.backblazeb2.com",
    recommendedPartSize: 100_000_000,
    absoluteMinimumPartSize: 5_000_000,
    s3ApiUrl,
    capabilities: [],
  };
}

describe("createAuthorizedS3Client endpoint classification", () => {
  beforeEach(() => {
    peerBuilds.length = 0;
  });

  it("surfaces untrusted_endpoint/502 instead of masking it with the fallback", async () => {
    const facade = createAuthorizedS3Client({
      getConfig: () => config,
      getAuth: async () => authResponse("https://s3.evil.example.com"),
    });

    await expect(
      (facade as unknown as { headBucket: (i: unknown) => Promise<unknown> }).headBucket({}),
    ).rejects.toMatchObject({ status: 502, code: "untrusted_endpoint" });
    // The rejected endpoint must not have been quietly replaced by a client.
    expect(peerBuilds).toHaveLength(0);
  });

  it("falls back to the configured region for a genuine authorize outage", async () => {
    const facade = createAuthorizedS3Client({
      getConfig: () => config,
      getAuth: async () => {
        throw Object.assign(new Error("bad credentials"), { status: 401, code: "unauthorized" });
      },
    });

    const result = await (
      facade as unknown as { headBucket: (i: unknown) => Promise<unknown> }
    ).headBucket({});

    expect(result).toEqual({ ok: true });
    expect(peerBuilds).toEqual([
      { endpoint: expectedB2S3Endpoint("us-west-004"), region: "us-west-004" },
    ]);
  });
});
