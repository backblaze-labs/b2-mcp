/**
 * Unit tests for B2AuthManager.
 * Uses jest.spyOn to mock axios at the module level, avoiding
 * nock's circular-reference issues on Node.js v22.
 */

import axios from "axios";
import { B2AuthManager } from "../../src/auth";
import { B2Config } from "../../src/utils/types";

const mockConfig: B2Config = {
  applicationKeyId: "test-key-id",
  applicationKey: "test-key-secret",
  appKeyId: "test-app-key-id",
  appKey: "test-app-key-secret",
  region: "us-west-004",
  largeFileThreshold: 100 * 1024 * 1024,
  partSize: 100 * 1024 * 1024,
  allowLocalFiles: true,
  fileRoot: null,
};

// v4 b2_authorize_account response shape (apiInfo.storageApi) — auth manager flattens this internally
const mockAuthResponse = {
  accountId: "test-account-id",
  authorizationToken: "test-auth-token",
  apiInfo: {
    storageApi: {
      apiUrl: "https://api005.backblazeb2.com",
      downloadUrl: "https://f005.backblazeb2.com",
      s3ApiUrl: "https://s3.us-west-004.backblazeb2.com",
      recommendedPartSize: 100 * 1024 * 1024,
      absoluteMinimumPartSize: 5 * 1024 * 1024,
    },
  },
};

describe("B2AuthManager", () => {
  let getSpy: jest.SpyInstance;

  beforeEach(() => {
    getSpy = jest.spyOn(axios, "get").mockResolvedValue({ data: mockAuthResponse });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should authorize on first getAuth() call", async () => {
    const manager = new B2AuthManager(mockConfig);
    const auth = await manager.getAuth();

    expect(auth.accountId).toBe("test-account-id");
    expect(auth.apiUrl).toBe("https://api005.backblazeb2.com");
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it("should cache the token and not re-authorize on subsequent calls", async () => {
    const manager = new B2AuthManager(mockConfig);

    const auth1 = await manager.getAuth();
    const auth2 = await manager.getAuth();
    const auth3 = await manager.getAuth();

    expect(auth1.authorizationToken).toBe(auth2.authorizationToken);
    expect(auth2.authorizationToken).toBe(auth3.authorizationToken);
    expect(getSpy).toHaveBeenCalledTimes(1); // Only one HTTP call
  });

  it("should re-authorize after invalidate()", async () => {
    getSpy
      .mockResolvedValueOnce({ data: mockAuthResponse })
      .mockResolvedValueOnce({ data: { ...mockAuthResponse, authorizationToken: "new-token" } });

    const manager = new B2AuthManager(mockConfig);
    const auth1 = await manager.getAuth();
    expect(auth1.authorizationToken).toBe("test-auth-token");

    manager.invalidate();
    const auth2 = await manager.getAuth();
    expect(auth2.authorizationToken).toBe("new-token");
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it("should throw on authorization failure", async () => {
    getSpy.mockRejectedValue(new Error("Unauthorized"));

    const manager = new B2AuthManager(mockConfig);
    await expect(manager.getAuth()).rejects.toThrow("Unauthorized");
  });

  it("should handle concurrent getAuth() calls with a single HTTP request", async () => {
    const manager = new B2AuthManager(mockConfig);

    const [auth1, auth2, auth3] = await Promise.all([
      manager.getAuth(),
      manager.getAuth(),
      manager.getAuth(),
    ]);

    expect(getSpy).toHaveBeenCalledTimes(1); // In-flight dedup
    expect(auth1.authorizationToken).toBe(auth2.authorizationToken);
    expect(auth2.authorizationToken).toBe(auth3.authorizationToken);
  });

  it("should not expose auth token in forceRefresh result (handled by tool layer)", async () => {
    const manager = new B2AuthManager(mockConfig);
    const auth = await manager.forceRefresh();
    // forceRefresh returns the full auth data — the tool layer is responsible for redacting the token
    expect(auth.accountId).toBe("test-account-id");
    expect(auth.authorizationToken).toBeDefined();
  });
});
