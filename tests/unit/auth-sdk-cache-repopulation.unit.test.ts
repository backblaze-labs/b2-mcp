import { B2AuthManager } from "../../src/auth";
import { _resetRetryBudget } from "../../src/utils/retry";
import type { B2Config } from "../../src/utils/types";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import {
  authorizeResponse,
  deferred,
  installSdkTransport,
  RecordingTransport,
  StaticHttpResponse,
} from "../support/sdk-test-helpers";

const config: B2Config = {
  applicationKeyId: "public-cache-key-id",
  applicationKey: "public-cache-key-secret",
  appKeyId: "public-cache-key-id",
  appKey: "public-cache-key-secret",
  masterKeyId: "public-master-id",
  masterKey: "public-master-secret",
  region: "us-west-004",
  allowLocalFiles: false,
  fileRoot: null,
};

afterEach(() => {
  setB2SdkClientFactoryForTests(null);
  _resetRetryBudget();
  vi.restoreAllMocks();
});

it.each(["before", "after"] as const)(
  "syncs SDK authorization begun %s manager invalidation without authorizing again",
  async (timing) => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Unexpected external network access"),
    );
    const refreshStarted = deferred<void>();
    const refreshResponse = deferred<StaticHttpResponse>();
    const initial = { ...authorizeResponse(["listBuckets"]), authorizationToken: "before-token" };
    const refreshed = {
      ...authorizeResponse(["readFiles"]),
      authorizationToken: "refreshed-token",
    };
    let calls = 0;
    const io = new RecordingTransport(() => {
      if (++calls === 1) return new StaticHttpResponse(200, initial);
      refreshStarted.resolve(undefined);
      return refreshResponse.promise;
    });
    installSdkTransport(io);
    const manager = new B2AuthManager(config);
    const { client } = await manager.getAuthorizedSdk();

    if (timing === "after") manager.invalidate();
    const refresh = client.authorize();
    // Observe an early SDK failure while waiting for its real outbound request.
    const started = Promise.race([refreshStarted.promise, refresh.then(() => undefined)]);
    try {
      await started;
      if (timing === "before") manager.invalidate();
      expect(client.accountInfo.getAuth()).toBeNull();
      refreshResponse.resolve(new StaticHttpResponse(200, refreshed));
      await refresh;

      // Invalidation clears caches; it does not revoke the already exposed SDK
      // client. Its fresh authorization must repopulate the manager's metadata.
      manager.syncCachedAuthFromSdk();
      await expect(manager.getAuth()).resolves.toMatchObject({
        authorizationToken: "refreshed-token",
        capabilities: ["readFiles"],
      });
      expect((await manager.getAuthorizedSdk()).client).toBe(client);
      expect(io.requests).toHaveLength(2);
    } finally {
      refreshResponse.resolve(new StaticHttpResponse(200, refreshed));
      await Promise.allSettled([refresh, started]);
    }
  },
);
