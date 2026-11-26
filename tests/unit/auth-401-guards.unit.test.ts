/**
 * Regression guard for case C28: a read that meets an expired-token 401 recovers after one
 * retry and succeeds, and a persistent 401 is surfaced (not retried forever). Pins current
 * behavior, including the bound of 8 attempts (4 before and 4 after re-authorization), so a
 * change to the retry policy may legitimately require updating that number.
 */
import { B2AuthManager } from "../../src/auth";
import { B2Client } from "../../src/b2/client";
import type { B2Config } from "../../src/utils/types";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import {
  authorizeResponse,
  b2EndpointName,
  installSdkTransport,
  RecordingTransport,
  StaticHttpResponse,
} from "../support/sdk-test-helpers";

const config: B2Config = {
  applicationKeyId: "test-key-id",
  applicationKey: "test-key-secret",
  appKeyId: "test-app-key-id",
  appKey: "test-app-key-secret",
  masterKeyId: "test-app-key-secret",
  masterKey: "test-app-key-secret",
  region: "us-west-004",
  allowLocalFiles: true,
  fileRoot: null,
};

afterEach(() => {
  setB2SdkClientFactoryForTests(null);
});

function install(listStatuses: number[]) {
  let lists = 0;
  const transport = new RecordingTransport((request) => {
    const name = b2EndpointName(request);
    if (name === "b2_authorize_account") {
      return new StaticHttpResponse(200, authorizeResponse(["listBuckets"]));
    }
    if (name === "b2_list_buckets") {
      const status = listStatuses[Math.min(lists++, listStatuses.length - 1)];
      return status === 200
        ? new StaticHttpResponse(200, { buckets: [] })
        : new StaticHttpResponse(status, {
            status,
            code: "expired_auth_token",
            message: "expired",
          });
    }
    return new StaticHttpResponse(200, {});
  });
  installSdkTransport(transport, {
    maxRetries: 3,
    initialRetryDelayMs: 1,
    maxRetryDelayMs: 1,
    requestTimeoutMs: 30_000,
  });
  const count = (endpoint: string) =>
    transport.requests.filter((r) => b2EndpointName(r) === endpoint).length;
  return { count };
}

describe("expired-token handling on reads (Finding C28 guard)", () => {
  it("a single expired-token 401 on a read is recovered with exactly one retry", async () => {
    const { count } = install([401, 200]);
    const client = new B2Client(new B2AuthManager(config));

    await expect(client.listBuckets()).resolves.toMatchObject({ buckets: [] });

    // One failed attempt plus one recovered attempt: not three replays of the expired token.
    expect(count("b2_list_buckets")).toBe(2);
  });

  it("a persistent expired-token 401 is surfaced after at most 8 attempts (observed: 8 = 4 before and 4 after re-authorize)", async () => {
    const { count } = install([401]);
    const client = new B2Client(new B2AuthManager(config));

    await expect(client.listBuckets()).rejects.toMatchObject({ status: 401 });

    expect(count("b2_list_buckets")).toBeLessThanOrEqual(8);
  });
});
