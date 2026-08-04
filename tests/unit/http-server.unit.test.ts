/**
 * Unit tests for HTTP transport helpers.
 * Covers configFromHeaders parsing and getPort validation.
 */

import { configFromHeaders, getPort } from "../../src/http-server";

describe("configFromHeaders", () => {
  const baseEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.B2_REGION;
    delete process.env.B2_MCP_OUTPUT_FORMAT;
  });
  afterAll(() => {
    process.env = baseEnv;
  });

  it("returns null when X-B2-Key-Id is missing", () => {
    const req = { headers: { "x-b2-key": "secret" } };
    expect(configFromHeaders(req)).toBeNull();
  });

  it("returns null when X-B2-Key is missing", () => {
    const req = { headers: { "x-b2-key-id": "id" } };
    expect(configFromHeaders(req)).toBeNull();
  });

  it("rejects conflicting duplicate credential header values", () => {
    const req = { headers: { "x-b2-key-id": ["a", "b"], "x-b2-key": "secret" } };
    expect(() => configFromHeaders(req)).toThrow(/conflicting/i);
  });

  it("falls back to primary key when app key headers are absent", () => {
    const req = { headers: { "x-b2-key-id": "primary-id", "x-b2-key": "primary-secret" } };
    const config = configFromHeaders(req)!;
    expect(config.applicationKeyId).toBe("primary-id");
    expect(config.applicationKey).toBe("primary-secret");
    expect(config.appKeyId).toBe("primary-id");
    expect(config.appKey).toBe("primary-secret");
  });

  it("uses app key headers when provided", () => {
    const req = {
      headers: {
        "x-b2-key-id": "master-id",
        "x-b2-key": "master-secret",
        "x-b2-app-key-id": "app-id",
        "x-b2-app-key": "app-secret",
      },
    };
    const config = configFromHeaders(req)!;
    expect(config.applicationKeyId).toBe("master-id");
    expect(config.appKeyId).toBe("app-id");
    expect(config.appKey).toBe("app-secret");
  });

  it("defaults region when env var unset", () => {
    const req = { headers: { "x-b2-key-id": "id", "x-b2-key": "secret" } };
    const config = configFromHeaders(req)!;
    expect(config.region).toBe("us-west-004");
  });

  it("respects the B2_REGION env var", () => {
    process.env.B2_REGION = "eu-central-003";
    const req = { headers: { "x-b2-key-id": "id", "x-b2-key": "secret" } };
    const config = configFromHeaders(req)!;
    expect(config.region).toBe("eu-central-003");
  });

  it("defaults structured tool-result text output to compact JSON", () => {
    const req = { headers: { "x-b2-key-id": "id", "x-b2-key": "secret" } };
    expect(configFromHeaders(req)?.outputFormat).toBe("json");
  });

  it("honors TOON structured tool-result text output mode", () => {
    process.env.B2_MCP_OUTPUT_FORMAT = "toon";
    const req = { headers: { "x-b2-key-id": "id", "x-b2-key": "secret" } };
    expect(configFromHeaders(req)?.outputFormat).toBe("toon");
  });

  it("rejects unknown structured tool-result text output modes", () => {
    process.env.B2_MCP_OUTPUT_FORMAT = "yaml";
    const req = { headers: { "x-b2-key-id": "id", "x-b2-key": "secret" } };
    expect(() => configFromHeaders(req)).toThrow(/B2_MCP_OUTPUT_FORMAT/);
  });
});

describe("getPort", () => {
  const baseArgv = process.argv.slice();
  const baseEnv = { ...process.env };
  beforeEach(() => {
    process.argv = baseArgv.slice();
    delete process.env.PORT;
  });
  afterAll(() => {
    process.argv = baseArgv;
    process.env = baseEnv;
  });

  it("defaults to 3000 when no --port or PORT env", () => {
    expect(getPort()).toBe(3000);
  });

  it("uses --port arg", () => {
    process.argv.push("--port", "8080");
    expect(getPort()).toBe(8080);
  });

  it("uses PORT env when --port absent", () => {
    process.env.PORT = "4000";
    expect(getPort()).toBe(4000);
  });

  it("throws on non-numeric port", () => {
    process.argv.push("--port", "abc");
    expect(() => getPort()).toThrow(/Invalid port/);
  });

  it("throws on port <= 0", () => {
    process.argv.push("--port", "0");
    expect(() => getPort()).toThrow(/Invalid port/);
  });

  it("throws on port > 65535", () => {
    process.argv.push("--port", "70000");
    expect(() => getPort()).toThrow(/Invalid port/);
  });
});
