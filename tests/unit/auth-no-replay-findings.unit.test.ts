/**
 * Case C27: a non-idempotent B2 write must be sent exactly once, whatever the failure
 * status, including a 401 that triggers re-authorization. The 503 cases already hold and run
 * as normal tests; the 401 cases are still defective and use `knownDefect`
 * (see tests/support/known-defect.ts). Covers 5 of the no-replay endpoints.
 */
import { B2AuthManager } from "../../src/auth";
import { B2Client } from "../../src/b2/client";
import type { B2Config } from "../../src/utils/types";
import { expectDefect, knownDefect } from "../support/known-defect";
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

const writes: Array<[string, string, (c: B2Client) => Promise<unknown>]> = [
  [
    "b2_create_bucket",
    "createBucket",
    (c) => c.createBucket({ bucketName: "new-bucket-1", bucketType: "allPrivate" }),
  ],
  ["b2_delete_bucket", "deleteBucket", (c) => c.deleteBucket("bucket-1")],
  [
    "b2_update_bucket",
    "updateBucket",
    (c) => c.updateBucket({ bucketId: "bucket-1", bucketType: "allPrivate" }),
  ],
  [
    "b2_create_key",
    "createKey",
    (c) => c.createKey({ keyName: "new-key-1", capabilities: ["listFiles"] }),
  ],
  ["b2_delete_key", "deleteKey", (c) => c.deleteKey("key-1")],
];

const failures: Array<[string, number, string]> = [
  ["401 expired_auth_token", 401, "expired_auth_token"],
  ["503 service_unavailable", 503, "service_unavailable"],
];

describe("Finding C27: non-idempotent native writes are never replayed", () => {
  for (const [endpoint, method, call] of writes) {
    for (const [label, status, code] of failures) {
      const register = status === 401 ? knownDefect : it;
      register(`${method} (${endpoint}) is sent once after a ${label}`, async () => {
        let writeCalls = 0;
        const transport = new RecordingTransport((request) => {
          const name = b2EndpointName(request);
          if (name === "b2_authorize_account") {
            return new StaticHttpResponse(
              200,
              authorizeResponse(["writeBuckets", "deleteBuckets", "writeKeys", "deleteKeys"]),
            );
          }
          if (name === endpoint) {
            writeCalls++;
            if (writeCalls === 1)
              return new StaticHttpResponse(status, { status, code, message: "x" });
          }
          return new StaticHttpResponse(200, {
            accountId: "test-account-123",
            bucketId: "bucket-1",
            bucketName: "new-bucket-1",
            bucketType: "allPrivate",
            bucketInfo: {},
            corsRules: [],
            lifecycleRules: [],
            options: [],
            revision: 1,
            applicationKeyId: "key-1",
            keyName: "new-key-1",
            capabilities: ["listFiles"],
            applicationKey: "secret",
          });
        });
        installSdkTransport(transport, {
          maxRetries: 3,
          initialRetryDelayMs: 1,
          maxRetryDelayMs: 1,
          requestTimeoutMs: 30_000,
        });
        const client = new B2Client(new B2AuthManager(config));

        await call(client).catch(() => undefined);

        expect(writeCalls, `${endpoint} was requested`).toBeGreaterThan(0);
        if (status === 401) {
          await expectDefect(() => expect(writeCalls, `${endpoint} requests sent`).toBe(1));
        } else {
          expect(writeCalls, `${endpoint} requests sent`).toBe(1);
        }
      });
    }
  }
});
