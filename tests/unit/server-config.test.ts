/**
 * Unit tests for loadConfig() in server.ts.
 *
 * Verifies that:
 *   - Required env vars B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY are enforced
 *   - Optional var B2_REGION has the correct default
 */

// We need to control process.env and mock process.exit to test loadConfig
const mockExit = jest.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("process.exit called");
}) as any);

// Silence stderr output from loadConfig error messages
const mockStderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);

afterAll(() => {
  mockExit.mockRestore();
  mockStderr.mockRestore();
});

// Capture original env and restore after each test
const originalEnv = process.env;
beforeEach(() => {
  process.env = { ...originalEnv };
});
afterEach(() => {
  process.env = originalEnv;
  jest.resetModules(); // force fresh import of server.ts each test
});

async function loadConfig() {
  const { loadConfig: lc } = await import("../../dist/server");
  return lc();
}

// ── Required fields ───────────────────────────────────────────────────────────

describe("loadConfig — required env vars", () => {
  it("throws (via process.exit) when B2_APPLICATION_KEY_ID is missing", async () => {
    delete process.env.B2_APPLICATION_KEY_ID;
    process.env.B2_APPLICATION_KEY = "test-key";
    await expect(loadConfig()).rejects.toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("throws (via process.exit) when B2_APPLICATION_KEY is missing", async () => {
    process.env.B2_APPLICATION_KEY_ID = "test-key-id";
    delete process.env.B2_APPLICATION_KEY;
    await expect(loadConfig()).rejects.toThrow("process.exit called");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("throws when both required vars are missing", async () => {
    delete process.env.B2_APPLICATION_KEY_ID;
    delete process.env.B2_APPLICATION_KEY;
    await expect(loadConfig()).rejects.toThrow("process.exit called");
  });
});

// ── Successful config loading ─────────────────────────────────────────────────

describe("loadConfig — valid env vars", () => {
  beforeEach(() => {
    process.env.B2_APPLICATION_KEY_ID = "key-id-123";
    process.env.B2_APPLICATION_KEY = "key-secret-abc";
  });

  it("returns the key ID and key from env vars", async () => {
    const config = await loadConfig();
    expect(config.applicationKeyId).toBe("key-id-123");
    expect(config.applicationKey).toBe("key-secret-abc");
  });

  it("defaults region to us-west-004 when not set", async () => {
    delete process.env.B2_REGION;
    const config = await loadConfig();
    expect(config.region).toBe("us-west-004");
  });

  it("uses B2_REGION when set", async () => {
    process.env.B2_REGION = "eu-central-003";
    const config = await loadConfig();
    expect(config.region).toBe("eu-central-003");
  });

  it("defaults appKeyId to applicationKeyId when B2_APP_KEY_ID is not set", async () => {
    delete process.env.B2_APP_KEY_ID;
    delete process.env.B2_APP_KEY;
    const config = await loadConfig();
    expect(config.appKeyId).toBe("key-id-123");
    expect(config.appKey).toBe("key-secret-abc");
  });

  it("uses B2_APP_KEY_ID and B2_APP_KEY when set", async () => {
    process.env.B2_APP_KEY_ID = "app-key-id-xyz";
    process.env.B2_APP_KEY = "app-key-secret-xyz";
    const config = await loadConfig();
    expect(config.appKeyId).toBe("app-key-id-xyz");
    expect(config.appKey).toBe("app-key-secret-xyz");
    // Primary key is unchanged
    expect(config.applicationKeyId).toBe("key-id-123");
    expect(config.applicationKey).toBe("key-secret-abc");
  });

  describe("master key resolution", () => {
    afterEach(() => {
      delete process.env.B2_MASTER_KEY_ID;
      delete process.env.B2_MASTER_KEY;
    });

    it("defaults masterKeyId to the application key when B2_MASTER_KEY is unset", async () => {
      delete process.env.B2_MASTER_KEY_ID;
      delete process.env.B2_MASTER_KEY;
      const config = await loadConfig();
      expect(config.masterKeyId).toBe("key-id-123");
      expect(config.masterKey).toBe("key-secret-abc");
    });

    it("uses B2_MASTER_KEY_ID/B2_MASTER_KEY when both are set (Partner/bz_* only)", async () => {
      process.env.B2_MASTER_KEY_ID = "master-id";
      process.env.B2_MASTER_KEY = "master-secret";
      const config = await loadConfig();
      expect(config.masterKeyId).toBe("master-id");
      expect(config.masterKey).toBe("master-secret");
      // The application key stays the workhorse for everything else.
      expect(config.applicationKeyId).toBe("key-id-123");
    });

    it("ignores a partial master key (only one half set) and falls back to the application key", async () => {
      process.env.B2_MASTER_KEY_ID = "master-id";
      delete process.env.B2_MASTER_KEY;
      const config = await loadConfig();
      expect(config.masterKeyId).toBe("key-id-123");
      expect(config.masterKey).toBe("key-secret-abc");
    });
  });
});
