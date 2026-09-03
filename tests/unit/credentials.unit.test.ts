import {
  _resetRemovedCredentialEnvAliasWarning,
  CredentialResolutionError,
  fingerprintConfig,
  getHttpCredentialMode,
  getHttpCredentialProvider,
  hasCredentialHeaders,
  HttpHeaderCredentialProvider,
  HttpPrincipalCredentialProvider,
  HttpServerCredentialProvider,
  StdioEnvCredentialProvider,
  validateHttpCredentialConfiguration,
  validateHttpStartupConfiguration,
  verificationFingerprintConfig,
  warnRemovedCredentialEnvAliases,
} from "../../src/credentials";
import { logger } from "../../src/utils/logger";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const savedEnv = process.env;

beforeEach(() => {
  process.env = { ...savedEnv };
  delete process.env.B2_HTTP_CREDENTIAL_MODE;
  delete process.env.B2_APPLICATION_KEY_ID;
  delete process.env.B2_APPLICATION_KEY;
  delete process.env.B2_APP_KEY_ID;
  delete process.env.B2_APP_KEY;
  delete process.env.B2_MASTER_KEY_ID;
  delete process.env.B2_MASTER_KEY;
  delete process.env.B2_MCP_OUTPUT_FORMAT;
  delete process.env.B2_SECRET_SINK;
  delete process.env.B2_SECRET_SINK_FILE;
  delete process.env.B2_ALLOW_LOCAL_FILES;
  delete process.env.B2_ALLOW_INLINE_SECRETS;
  delete process.env.B2_PRINCIPAL_CREDENTIAL_MAP;
  delete process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID;
  delete process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY;
  process.env.B2_SECRET_SINK = "off";
});

afterEach(() => {
  process.env = savedEnv;
});

describe("credential providers", () => {
  it("loads stdio credentials from the existing environment variables", () => {
    process.env.B2_APPLICATION_KEY_ID = "stdio-id";
    process.env.B2_APPLICATION_KEY = "stdio-secret";
    const resolved = new StdioEnvCredentialProvider().resolve();
    expect(resolved.config.applicationKeyId).toBe("stdio-id");
    expect(resolved.config.applicationKey).toBe("stdio-secret");
    expect(resolved.config.transport).toBe("stdio");
    expect(resolved.config.outputFormat).toBe("json");
    expect(resolved.config.credentialFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(resolved.cacheKey).not.toContain("stdio-id");
    expect(resolved.capabilityCacheKey).toMatch(/^credential:[a-f0-9]{16}$/);
  });

  it("fails closed when required stdio credentials are missing", () => {
    expect(() => new StdioEnvCredentialProvider().resolve()).toThrow(CredentialResolutionError);
  });

  it("honors compact JSON output compatibility mode", () => {
    process.env.B2_APPLICATION_KEY_ID = "stdio-id";
    process.env.B2_APPLICATION_KEY = "stdio-secret";
    process.env.B2_MCP_OUTPUT_FORMAT = "json";
    const resolved = new StdioEnvCredentialProvider().resolve();
    expect(resolved.config.outputFormat).toBe("json");
  });

  it("disables MCP workflow prompts by default and only enables them on an explicit true", () => {
    process.env.B2_APPLICATION_KEY_ID = "stdio-id";
    process.env.B2_APPLICATION_KEY = "stdio-secret";

    delete process.env.B2_ENABLE_MCP_PROMPTS;
    expect(new StdioEnvCredentialProvider().resolve().config.enableMcpPrompts).toBe(false);

    process.env.B2_ENABLE_MCP_PROMPTS = "false";
    expect(new StdioEnvCredentialProvider().resolve().config.enableMcpPrompts).toBe(false);

    process.env.B2_ENABLE_MCP_PROMPTS = "true";
    expect(new StdioEnvCredentialProvider().resolve().config.enableMcpPrompts).toBe(true);
  });

  it("honors TOON output mode", () => {
    process.env.B2_APPLICATION_KEY_ID = "stdio-id";
    process.env.B2_APPLICATION_KEY = "stdio-secret";
    process.env.B2_MCP_OUTPUT_FORMAT = "toon";
    const resolved = new StdioEnvCredentialProvider().resolve();
    expect(resolved.config.outputFormat).toBe("toon");
  });

  it("rejects unknown output formats during config resolution", () => {
    process.env.B2_APPLICATION_KEY_ID = "stdio-id";
    process.env.B2_APPLICATION_KEY = "stdio-secret";
    process.env.B2_MCP_OUTPUT_FORMAT = "yaml";
    let caught: unknown;
    try {
      new StdioEnvCredentialProvider().resolve();
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "invalid_output_format" });
  });

  it("rejects unknown output formats during HTTP header-mode readiness", () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
    process.env.B2_MCP_OUTPUT_FORMAT = "yaml";
    let caught: unknown;
    try {
      validateHttpCredentialConfiguration();
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "invalid_output_format" });
  });

  it("allows HTTP startup without server-mode credentials for readiness reporting", () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "server";

    expect(() => validateHttpStartupConfiguration()).not.toThrow();
    expect(() => validateHttpCredentialConfiguration()).toThrow(CredentialResolutionError);
  });

  it("rejects TOON mode during HTTP readiness when the encoder preflight fails", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
    process.env.B2_MCP_OUTPUT_FORMAT = "toon";

    vi.resetModules();
    vi.doMock("../../src/utils/toon-encoder", () => ({
      encodeToon: () => {
        throw new Error("encoder unavailable");
      },
    }));
    try {
      const { validateHttpCredentialConfiguration: validate } = await import(
        "../../src/credentials"
      );
      let caught: unknown;
      try {
        validate();
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({
        code: "invalid_output_format",
        message: "encoder unavailable",
      });
    } finally {
      vi.doUnmock("../../src/utils/toon-encoder");
      vi.resetModules();
    }
  });

  it("ignores partial optional stdio master credentials and falls back to the app key", () => {
    process.env.B2_APPLICATION_KEY_ID = "stdio-id";
    process.env.B2_APPLICATION_KEY = "stdio-secret";
    process.env.B2_MASTER_KEY_ID = "master-id";
    const resolved = new StdioEnvCredentialProvider().resolve();
    expect(resolved.config.masterKeyId).toBe("stdio-id");
    expect(resolved.config.masterKey).toBe("stdio-secret");
  });

  it("resolves header compatibility credentials per request", () => {
    const resolved = new HttpHeaderCredentialProvider().resolve({
      req: {
        headers: {
          "x-b2-mcp-key-id": "header-id",
          "x-b2-mcp-key": "header-secret",
        },
      } as any,
    });
    expect(resolved.config.applicationKeyId).toBe("header-id");
    expect(resolved.config.transport).toBe("http");
    expect(resolved.cacheKey).not.toContain("header-id");
    expect(resolved.cacheKey).not.toContain("header-secret");
    expect(resolved.capabilityCacheKey).not.toBe(resolved.cacheKey);
  });

  it("scopes header compatibility caller fingerprints to verified authInfo", () => {
    const provider = new HttpHeaderCredentialProvider();
    const alice = provider.resolve({
      req: {
        headers: {
          "x-b2-mcp-key-id": "header-id",
          "x-b2-mcp-key": "header-secret",
        },
        auth: {
          token: "verified",
          clientId: "client-a",
          scopes: ["b2:read"],
          extra: { iss: "https://issuer.example", sub: "alice" },
        },
      } as any,
    });
    const bob = provider.resolve({
      req: {
        headers: {
          "x-b2-mcp-key-id": "header-id",
          "x-b2-mcp-key": "header-secret",
        },
        auth: {
          token: "verified",
          clientId: "client-b",
          scopes: ["b2:read"],
          extra: { iss: "https://issuer.example", sub: "bob" },
        },
      } as any,
    });

    expect(alice.config.credentialFingerprint).toBe(bob.config.credentialFingerprint);
    expect(alice.cacheKey).not.toBe(bob.cacheKey);
    expect(alice.config.callerFingerprint).not.toBe(bob.config.callerFingerprint);
    expect(alice.cacheKey).not.toContain("alice");
    expect(alice.cacheKey).not.toContain("header-secret");
    expect(alice.capabilityCacheKey).toBe(bob.capabilityCacheKey);
  });

  it("does not preflight the HTTP file secret sink during per-request resolution", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-http-secret-sink-hot-path-"));
    const file = join(dir, "nested", "secrets.jsonl");
    process.env.B2_SECRET_SINK = "file";
    process.env.B2_ALLOW_LOCAL_FILES = "true";
    process.env.B2_SECRET_SINK_FILE = file;

    const resolved = new HttpHeaderCredentialProvider().resolve({
      req: {
        headers: {
          "x-b2-mcp-key-id": "header-id",
          "x-b2-mcp-key": "header-secret",
        },
      } as any,
    });

    expect(resolved.config.secretSink).toEqual({ mode: "file", filePath: file });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(dir, "nested"))).toBe(false);
  });

  it("rejects partial optional header credentials", () => {
    expect(() =>
      new HttpHeaderCredentialProvider().resolve({
        req: {
          headers: {
            "x-b2-mcp-key-id": "header-id",
            "x-b2-mcp-key": "header-secret",
            "x-b2-mcp-master-key-id": "master-id",
          },
        } as any,
      }),
    ).toThrow(/both id and secret/i);
  });

  it("server provider uses process credentials and blocks public B2 headers", () => {
    process.env.B2_APPLICATION_KEY_ID = "server-id";
    process.env.B2_APPLICATION_KEY = "server-secret";
    const provider = new HttpServerCredentialProvider();
    const resolved = provider.resolve({ req: { headers: {} } as any });
    expect(resolved.config.applicationKeyId).toBe("server-id");
    expect(() =>
      provider.resolve({
        req: { headers: { "x-b2-mcp-key-id": "spoof", "x-b2-mcp-key": "spoof-secret" } } as any,
      }),
    ).toThrow(/not accepted/i);
  });

  it("server provider rate keys use verified principal when present", () => {
    process.env.B2_APPLICATION_KEY_ID = "server-id";
    process.env.B2_APPLICATION_KEY = "server-secret";
    const provider = new HttpServerCredentialProvider();
    const alice = provider.resolve({
      req: {
        headers: {},
        auth: {
          token: "verified",
          clientId: "client-a",
          scopes: ["b2:read"],
          extra: { iss: "https://issuer.example", sub: "alice" },
        },
      } as any,
    });
    const bob = provider.resolve({
      req: {
        headers: {},
        auth: {
          token: "verified",
          clientId: "client-b",
          scopes: ["b2:read"],
          extra: { iss: "https://issuer.example", sub: "bob" },
        },
      } as any,
    });

    expect(alice.cacheKey).toMatch(/^server-principal:[a-f0-9]{16}$/);
    expect(bob.cacheKey).toMatch(/^server-principal:[a-f0-9]{16}$/);
    expect(alice.cacheKey).not.toBe(bob.cacheKey);
    expect(alice.capabilityCacheKey).toBe(bob.capabilityCacheKey);
    expect(alice.config.credentialFingerprint).toBe(bob.config.credentialFingerprint);
    expect(alice.config.callerFingerprint).not.toBe(bob.config.callerFingerprint);
    expect(alice.cacheKey).not.toContain("alice");
    expect(alice.cacheKey).not.toContain("server-secret");
  });

  it("principal provider maps verified authInfo to an env-backed credential reference", () => {
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({ alice: "tenant_a" });
    process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID = "tenant-id";
    process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY = "tenant-secret";
    const resolved = new HttpPrincipalCredentialProvider().resolve({
      req: {
        headers: {},
        auth: { token: "verified", clientId: "client-a", scopes: [], extra: { sub: "alice" } },
      } as any,
    });
    expect(resolved.config.applicationKeyId).toBe("tenant-id");
    expect(resolved.principal).toBe("alice");
    expect(resolved.cacheKey).toMatch(/^principal:[a-f0-9]{16}$/);
    expect(resolved.capabilityCacheKey).toMatch(/^principal:[a-f0-9]{16}$/);
    expect(resolved.config.callerFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(resolved.cacheKey).not.toContain("alice");
    expect(resolved.cacheKey).not.toContain("tenant-id");
  });

  it("principal provider reports an unmapped secret reference when env material is absent", () => {
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({ alice: "tenant_a" });

    let caught: unknown;
    try {
      new HttpPrincipalCredentialProvider().resolve({
        req: {
          headers: {},
          auth: { token: "verified", clientId: "client-a", scopes: [], extra: { sub: "alice" } },
        } as any,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      code: "credential_ref_not_found",
      status: 403,
    });
  });

  it("uses the secret in capability-cache identity without changing log identity", () => {
    const provider = new HttpHeaderCredentialProvider();
    const first = provider.resolve({
      req: { headers: { "x-b2-mcp-key-id": "header-id", "x-b2-mcp-key": "secret-a" } } as any,
    });
    const second = provider.resolve({
      req: { headers: { "x-b2-mcp-key-id": "header-id", "x-b2-mcp-key": "secret-b" } } as any,
    });
    expect(first.cacheKey).toBe(second.cacheKey);
    expect(first.capabilityCacheKey).not.toBe(second.capabilityCacheKey);
  });

  it("principal provider rejects mutable email-only and clientId-only identities", () => {
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({
      "alice@example.com": "tenant_a",
      "client-a": "tenant_a",
    });
    process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID = "tenant-id";
    process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY = "tenant-secret";
    const provider = new HttpPrincipalCredentialProvider();

    expect(() =>
      provider.resolve({
        req: {
          headers: {},
          auth: {
            token: "verified",
            clientId: "client-a",
            scopes: [],
            extra: { email: "alice@example.com" },
          },
        } as any,
      }),
    ).toThrow(/principal/i);

    expect(() =>
      provider.resolve({
        req: {
          headers: {},
          auth: { token: "verified", clientId: "client-a", scopes: [], extra: {} },
        } as any,
      }),
    ).toThrow(/principal/i);
  });

  it("principal provider qualifies subjects with issuer when present", () => {
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({
      "https://issuer.example#alice": "tenant_a",
    });
    process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID = "tenant-id";
    process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY = "tenant-secret";

    const resolved = new HttpPrincipalCredentialProvider().resolve({
      req: {
        headers: {},
        auth: {
          token: "verified",
          clientId: "client-a",
          scopes: [],
          extra: { iss: "https://issuer.example", sub: "alice" },
        },
      } as any,
    });
    expect(resolved.principal).toBe("https://issuer.example#alice");
  });

  it("rejects principal maps with credential ref normalization collisions", () => {
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({
      alice: "tenant-a",
      mallory: "tenant_a",
    });
    expect(() =>
      new HttpPrincipalCredentialProvider().resolve({
        req: {
          headers: {},
          auth: { token: "verified", clientId: "client-a", scopes: [], extra: { sub: "alice" } },
        } as any,
      }),
    ).toThrow(/principal credential map/i);
  });

  it("does not map inherited object property names as principals", () => {
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({ alice: "tenant_a" });
    const provider = new HttpPrincipalCredentialProvider();
    expect(() =>
      provider.resolve({
        req: {
          headers: {},
          auth: {
            token: "verified",
            clientId: "client-a",
            scopes: [],
            extra: { sub: "constructor" },
          },
        } as any,
      }),
    ).toThrow(/No credential mapping/i);
  });

  it("principal provider rejects unauthenticated requests and B2 header spoofing", () => {
    const provider = new HttpPrincipalCredentialProvider();
    expect(() => provider.resolve({ req: { headers: {} } as any })).toThrow(/authInfo/i);
    expect(() =>
      provider.resolve({
        req: {
          headers: { "x-b2-mcp-key-id": "spoof", "x-b2-mcp-key": "spoof-secret" },
          auth: { token: "verified", clientId: "client-a", scopes: [] },
        } as any,
      }),
    ).toThrow(/not accepted/i);
  });
});

describe("credential mode parsing", () => {
  it("defaults HTTP credential mode to header compatibility", () => {
    expect(getHttpCredentialMode()).toBe("headers");
    expect(getHttpCredentialProvider()).toBeInstanceOf(HttpHeaderCredentialProvider);
  });

  it("selects explicit header and principal providers", () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
    expect(getHttpCredentialProvider()).toBeInstanceOf(HttpHeaderCredentialProvider);
    process.env.B2_HTTP_CREDENTIAL_MODE = "principal";
    expect(getHttpCredentialProvider()).toBeInstanceOf(HttpPrincipalCredentialProvider);
  });

  it("rejects invalid modes", () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "session";
    expect(() => getHttpCredentialMode()).toThrow(/invalid/i);
  });
});

describe("credential fingerprints and header detection", () => {
  it("uses a non-secret fingerprint for cache/log identity", () => {
    const fingerprint = fingerprintConfig({
      applicationKeyId: "key-id",
      appKeyId: "app-id",
      masterKeyId: "master-id",
      region: "us-west-004",
    });
    expect(fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(fingerprint).not.toContain("key-id");
  });

  it("uses a separate secret-bound verifier", () => {
    const a = verificationFingerprintConfig({
      applicationKeyId: "key-id",
      applicationKey: "secret-a",
      appKeyId: "app-id",
      appKey: "secret-a",
      masterKeyId: "master-id",
      masterKey: "secret-a",
      region: "us-west-004",
    });
    const b = verificationFingerprintConfig({
      applicationKeyId: "key-id",
      applicationKey: "secret-b",
      appKeyId: "app-id",
      appKey: "secret-b",
      masterKeyId: "master-id",
      masterKey: "secret-b",
      region: "us-west-004",
    });
    expect(a).not.toBe(b);
    expect(a).not.toContain("secret-a");
  });

  it("detects canonical and retired B2 credential headers for the rejection guard", () => {
    expect(hasCredentialHeaders({ "x-b2-mcp-key-id": "k" })).toBe(true);
    expect(hasCredentialHeaders({ "x-b2-mcp-master-key-id": "k" })).toBe(true);
    // Retired aliases are no longer parsed, but the detection guard stays broad so
    // a lagging legacy client is cleanly rejected in server/principal mode rather
    // than silently running under the server-held credential.
    expect(hasCredentialHeaders({ "x-b2-key-id": "k" })).toBe(true);
    expect(hasCredentialHeaders({ "x-b2-key": "k" })).toBe(true);
    expect(hasCredentialHeaders({ "x-b2-master-key": "k" })).toBe(true);
    expect(hasCredentialHeaders({ "x-b2-app-key-id": "k" })).toBe(true);
    expect(hasCredentialHeaders({ "x-b2-mcp-app-key": "k" })).toBe(true);
    expect(hasCredentialHeaders({ authorization: "Bearer t" })).toBe(false);
  });
});

describe("removed credential env alias warning", () => {
  beforeEach(() => {
    _resetRemovedCredentialEnvAliasWarning();
  });

  it("warns once when a removed B2_APP_KEY_* env var is still set", () => {
    process.env.B2_APP_KEY_ID = "still-exported-id";
    process.env.B2_APP_KEY = "still-exported-secret";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    warnRemovedCredentialEnvAliases();
    warnRemovedCredentialEnvAliases();

    const removedAliasWarnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes("B2_APP_KEY_ID/B2_APP_KEY"),
    );
    expect(removedAliasWarnings).toHaveLength(1);
    warn.mockRestore();
  });

  it("warns when a removed principal-mode B2_CREDENTIAL_<REF>_APP_KEY alias is still set", () => {
    process.env.B2_CREDENTIAL_TENANT_A_APP_KEY = "still-exported-principal-secret";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    warnRemovedCredentialEnvAliases();

    expect(
      warn.mock.calls.some((call) => String(call[0]).includes("B2_CREDENTIAL_<REF>_APP_KEY")),
    ).toBe(true);
    warn.mockRestore();
  });

  it("does not warn when no removed alias env var is present", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    warnRemovedCredentialEnvAliases();

    expect(warn.mock.calls.some((call) => String(call[0]).includes("removed_alias"))).toBe(false);
    warn.mockRestore();
  });
});
