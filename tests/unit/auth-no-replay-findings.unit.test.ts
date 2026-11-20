import { B2AuthManager } from "../../src/auth";
import { B2Client, setB2PartnerClientFactoryForTests } from "../../src/b2/client";
import { resetCircuitBreakersForTests } from "../../src/utils/circuit-breaker";
import { parseB2Error } from "../../src/utils/errors";
import { _resetRetryBudget } from "../../src/utils/retry";
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
  masterKeyId: "test-master-key-id",
  masterKey: "test-master-key-secret",
  region: "us-west-004",
  allowLocalFiles: false,
  fileRoot: null,
};

const writes: { endpoint: string; invoke: (client: B2Client) => Promise<unknown> }[] = [
  {
    endpoint: "b2_create_bucket",
    invoke: (client) => client.createBucket({ bucketName: "no-replay", bucketType: "allPrivate" }),
  },
  {
    endpoint: "b2_update_bucket",
    invoke: (client) => client.updateBucket({ bucketId: "bucket-1", bucketType: "allPrivate" }),
  },
  { endpoint: "b2_delete_bucket", invoke: (client) => client.deleteBucket("bucket-1") },
  {
    endpoint: "b2_create_key",
    invoke: (client) => client.createKey({ keyName: "no-replay", capabilities: ["readFiles"] }),
  },
  { endpoint: "b2_delete_key", invoke: (client) => client.deleteKey("key-1") },
];

// Exercise both retry transports and the MCP auth boundary, substituting only HTTP I/O.
describe("Finding C29: non-idempotent native writes are never replayed", () => {
  afterEach(() => {
    setB2SdkClientFactoryForTests(null);
    setB2PartnerClientFactoryForTests(null);
    resetCircuitBreakersForTests();
    _resetRetryBudget();
  });

  describe.each(writes)("$endpoint", ({ endpoint, invoke }) => {
    it.each([401, 503])("sends once on HTTP %s with maxRetries:0", async (status) => {
      const code = status === 401 ? "expired_auth_token" : "service_unavailable";
      const transport = new RecordingTransport((request) => {
        if (b2EndpointName(request) === "b2_authorize_account") {
          return new StaticHttpResponse(
            200,
            authorizeResponse(["writeBuckets", "deleteBuckets", "writeKeys", "deleteKeys"]),
          );
        }
        expect(b2EndpointName(request)).toBe(endpoint);
        return new StaticHttpResponse(status, { status, code, message: "injected failure" });
      });
      installSdkTransport(transport, {
        maxRetries: 3,
        initialRetryDelayMs: 1,
        maxRetryDelayMs: 1,
        requestTimeoutMs: 30_000,
      });
      const client = new B2Client(new B2AuthManager(config));
      const error = await invoke(client).then(
        () => {
          throw new Error("Expected the injected write failure");
        },
        (failure: unknown) => failure,
      );

      expect(parseB2Error(error)).toMatchObject({ status, code });
      const attempts = transport.requests.filter((request) => b2EndpointName(request) === endpoint);
      expect(attempts[0]?.retry?.maxRetries).toBe(0);
      expect(attempts).toHaveLength(1);
      expect(
        transport.requests.filter((request) => b2EndpointName(request) === "b2_authorize_account"),
      ).toHaveLength(1);
    });
  });
});
