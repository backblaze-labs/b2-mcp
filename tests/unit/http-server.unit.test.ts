/**
 * Unit tests for HTTP transport helpers.
 * Covers configFromHeaders parsing and getPort validation.
 */

import {
  configFromHeaders,
  createInFlightLimiter,
  deriveRateKey,
  getPort,
} from "../../src/http-server";
import { getDestructivePolicy } from "../../src/utils/destructive-gate";

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

describe("configFromHeaders — filesystem policy", () => {
  const baseReq = { headers: { "x-b2-key-id": "k", "x-b2-key": "s" } };

  afterEach(() => {
    delete process.env.B2_ALLOW_LOCAL_FILES;
    delete process.env.B2_FILE_ROOT;
  });

  it("disables local file access by default on HTTP", () => {
    const cfg = configFromHeaders(baseReq);
    expect(cfg?.allowLocalFiles).toBe(false);
  });

  it("only enables local files when explicitly opted in AND given a root", () => {
    process.env.B2_ALLOW_LOCAL_FILES = "true";
    expect(configFromHeaders(baseReq)?.allowLocalFiles).toBe(false);
    process.env.B2_FILE_ROOT = "/srv/uploads";
    const cfg = configFromHeaders(baseReq);
    expect(cfg?.allowLocalFiles).toBe(true);
    expect(cfg?.fileRoot).toBe("/srv/uploads");
  });
});

describe("configFromHeaders — credential model", () => {
  it("application key drives native+S3; master falls back to it when unset", () => {
    const cfg = configFromHeaders({
      headers: { "x-b2-key-id": "app-id", "x-b2-key": "app-secret" },
    });
    expect(cfg?.applicationKeyId).toBe("app-id");
    expect(cfg?.appKeyId).toBe("app-id");
    expect(cfg?.masterKeyId).toBe("app-id");
    expect(cfg?.masterKey).toBe("app-secret");
  });

  it("uses X-B2-Master-Key-* for the master credential when provided", () => {
    const cfg = configFromHeaders({
      headers: {
        "x-b2-key-id": "app-id",
        "x-b2-key": "app-secret",
        "x-b2-master-key-id": "master-id",
        "x-b2-master-key": "master-secret",
      },
    });
    expect(cfg?.applicationKeyId).toBe("app-id");
    expect(cfg?.masterKeyId).toBe("master-id");
    expect(cfg?.masterKey).toBe("master-secret");
  });

  it("rejects partial master credential headers", () => {
    expect(() =>
      configFromHeaders({
        headers: {
          "x-b2-key-id": "app-id",
          "x-b2-key": "app-secret",
          "x-b2-master-key-id": "master-id",
        },
      }),
    ).toThrow(/both id and secret/i);
  });

  it("still honors the deprecated X-B2-App-Key-* S3 override", () => {
    const cfg = configFromHeaders({
      headers: {
        "x-b2-key-id": "master-id",
        "x-b2-key": "master-secret",
        "x-b2-app-key-id": "s3-id",
        "x-b2-app-key": "s3-secret",
      },
    });
    expect(cfg?.appKeyId).toBe("s3-id");
    expect(cfg?.applicationKeyId).toBe("master-id");
  });

  it("accepts the explicit X-B2-MCP-* header names", () => {
    const cfg = configFromHeaders({
      headers: { "x-b2-mcp-key-id": "app-id", "x-b2-mcp-key": "app-secret" },
    });
    expect(cfg?.applicationKeyId).toBe("app-id");
    expect(cfg?.appKeyId).toBe("app-id");
  });
});

describe("deriveRateKey", () => {
  it("is deterministic and distinct per key id", () => {
    expect(deriveRateKey("abc")).toBe(deriveRateKey("abc"));
    expect(deriveRateKey("abc")).not.toBe(deriveRateKey("abd"));
    expect(deriveRateKey("abcdefgh")).not.toContain("abcdefgh");
  });
});

describe("createInFlightLimiter", () => {
  it("bounds in-flight requests globally and per credential", () => {
    const limiter = createInFlightLimiter(2, 1);
    expect(limiter.acquire("credential:a")).toEqual({ ok: true });
    expect(limiter.acquire("credential:a")).toMatchObject({ ok: false, status: 429 });
    expect(limiter.acquire("credential:b")).toEqual({ ok: true });
    expect(limiter.acquire("credential:c")).toMatchObject({ ok: false, status: 503 });
    limiter.release("credential:a");
    expect(limiter.acquire("credential:c")).toEqual({ ok: true });
  });
});

describe("configFromHeaders — destructive policy default (HTTP is safe-by-default)", () => {
  const saved = process.env.B2_DESTRUCTIVE_POLICY;
  const creds = { "x-b2-key-id": "key-abc", "x-b2-key": "secret-xyz" };

  afterEach(() => {
    if (saved === undefined) delete process.env.B2_DESTRUCTIVE_POLICY;
    else process.env.B2_DESTRUCTIVE_POLICY = saved;
  });

  it("defaults to block when B2_DESTRUCTIVE_POLICY is unset (internet-facing)", () => {
    delete process.env.B2_DESTRUCTIVE_POLICY;
    const cfg = configFromHeaders({ headers: creds });
    expect(cfg).not.toBeNull();
    expect(getDestructivePolicy(cfg!)).toBe("block");
  });

  it("honors an explicit opt-down to confirm", () => {
    process.env.B2_DESTRUCTIVE_POLICY = "confirm";
    expect(getDestructivePolicy(configFromHeaders({ headers: creds })!)).toBe("confirm");
  });

  it("honors an explicit allow", () => {
    process.env.B2_DESTRUCTIVE_POLICY = "allow";
    expect(getDestructivePolicy(configFromHeaders({ headers: creds })!)).toBe("allow");
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
