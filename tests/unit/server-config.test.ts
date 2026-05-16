/**
 * Unit tests for loadConfig() in server.ts.
 *
 * Verifies that:
 *   - Required env vars B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY are enforced
 *   - Optional vars B2_REGION, B2_LARGE_FILE_THRESHOLD, B2_PART_SIZE have correct defaults
 *   - parseInt is applied correctly to numeric env vars
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

  it("defaults largeFileThreshold to 100MB when not set", async () => {
    delete process.env.B2_LARGE_FILE_THRESHOLD;
    const config = await loadConfig();
    expect(config.largeFileThreshold).toBe(100 * 1024 * 1024);
  });

  it("parses B2_LARGE_FILE_THRESHOLD as an integer", async () => {
    process.env.B2_LARGE_FILE_THRESHOLD = "52428800"; // 50MB
    const config = await loadConfig();
    expect(config.largeFileThreshold).toBe(52428800);
  });

  it("defaults partSize to 100MB when not set", async () => {
    delete process.env.B2_PART_SIZE;
    const config = await loadConfig();
    expect(config.partSize).toBe(100 * 1024 * 1024);
  });

  it("parses B2_PART_SIZE as an integer", async () => {
    process.env.B2_PART_SIZE = "10485760"; // 10MB
    const config = await loadConfig();
    expect(config.partSize).toBe(10485760);
  });

  it("defaults s3ApplicationKeyId to applicationKeyId when B2_S3_APPLICATION_KEY_ID is not set", async () => {
    delete process.env.B2_S3_APPLICATION_KEY_ID;
    delete process.env.B2_S3_APPLICATION_KEY;
    const config = await loadConfig();
    expect(config.s3ApplicationKeyId).toBe("key-id-123");
    expect(config.s3ApplicationKey).toBe("key-secret-abc");
  });

  it("uses B2_S3_APPLICATION_KEY_ID and B2_S3_APPLICATION_KEY when set", async () => {
    process.env.B2_S3_APPLICATION_KEY_ID = "s3-key-id-xyz";
    process.env.B2_S3_APPLICATION_KEY = "s3-key-secret-xyz";
    const config = await loadConfig();
    expect(config.s3ApplicationKeyId).toBe("s3-key-id-xyz");
    expect(config.s3ApplicationKey).toBe("s3-key-secret-xyz");
    // Master key is unchanged
    expect(config.applicationKeyId).toBe("key-id-123");
    expect(config.applicationKey).toBe("key-secret-abc");
  });
});
