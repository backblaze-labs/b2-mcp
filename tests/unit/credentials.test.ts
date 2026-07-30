import {
  CredentialResolutionError,
  fingerprintConfig,
  getHttpCredentialMode,
  getHttpCredentialProvider,
  hasCredentialHeaders,
  HttpHeaderCredentialProvider,
  HttpPrincipalCredentialProvider,
  HttpServerCredentialProvider,
  StdioEnvCredentialProvider,
  verificationFingerprintConfig,
} from "../../src/credentials";

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
  delete process.env.B2_PRINCIPAL_CREDENTIAL_MAP;
  delete process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID;
  delete process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY;
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
    expect(resolved.config.credentialFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(resolved.cacheKey).not.toContain("stdio-id");
    expect(resolved.verificationKey).toMatch(/^credential:[a-f0-9]{16}$/);
  });

  it("fails closed when required stdio credentials are missing", () => {
    expect(() => new StdioEnvCredentialProvider().resolve()).toThrow(CredentialResolutionError);
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
          "x-b2-key-id": "header-id",
          "x-b2-key": "header-secret",
        },
      } as any,
    });
    expect(resolved.config.applicationKeyId).toBe("header-id");
    expect(resolved.config.transport).toBe("http");
    expect(resolved.cacheKey).not.toContain("header-id");
    expect(resolved.cacheKey).not.toContain("header-secret");
    expect(resolved.verificationKey).not.toBe(resolved.cacheKey);
  });

  it("rejects partial optional header credentials", () => {
    expect(() =>
      new HttpHeaderCredentialProvider().resolve({
        req: {
          headers: {
            "x-b2-key-id": "header-id",
            "x-b2-key": "header-secret",
            "x-b2-app-key-id": "s3-id",
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
        req: { headers: { "x-b2-key-id": "spoof", "x-b2-key": "spoof-secret" } } as any,
      }),
    ).toThrow(/not accepted/i);
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
    expect(resolved.verificationKey).toMatch(/^principal:[a-f0-9]{16}$/);
    expect(resolved.cacheKey).not.toContain("alice");
    expect(resolved.cacheKey).not.toContain("tenant-id");
  });

  it("uses the secret in verification identity without changing log identity", () => {
    const provider = new HttpHeaderCredentialProvider();
    const first = provider.resolve({
      req: { headers: { "x-b2-key-id": "header-id", "x-b2-key": "secret-a" } } as any,
    });
    const second = provider.resolve({
      req: { headers: { "x-b2-key-id": "header-id", "x-b2-key": "secret-b" } } as any,
    });
    expect(first.cacheKey).toBe(second.cacheKey);
    expect(first.verificationKey).not.toBe(second.verificationKey);
  });

  it("principal provider rejects unauthenticated requests and B2 header spoofing", () => {
    const provider = new HttpPrincipalCredentialProvider();
    expect(() => provider.resolve({ req: { headers: {} } as any })).toThrow(/authInfo/i);
    expect(() =>
      provider.resolve({
        req: {
          headers: { "x-b2-key-id": "spoof", "x-b2-key": "spoof-secret" },
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

  it("detects legacy and explicit B2 credential headers", () => {
    expect(hasCredentialHeaders({ "x-b2-key-id": "k" })).toBe(true);
    expect(hasCredentialHeaders({ "x-b2-mcp-key-id": "k" })).toBe(true);
    expect(hasCredentialHeaders({ authorization: "Bearer t" })).toBe(false);
  });
});
