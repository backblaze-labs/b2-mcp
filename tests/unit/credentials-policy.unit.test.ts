import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { IncomingHttpHeaders } from "http";
import type {
  AuthenticatedIncomingMessage,
  CredentialProviderContext,
} from "../../src/credentials";

let credentials: typeof import("../../src/credentials");
let logger: typeof import("../../src/utils/logger")["logger"];
const savedEnv = process.env;

beforeEach(async () => {
  process.env = { ...savedEnv };
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("B2_")) delete process.env[name];
  }
  Object.assign(process.env, {
    B2_SECRET_SINK: "off",
    B2_APPLICATION_KEY_ID: "application-id",
    B2_APPLICATION_KEY: "application-secret",
    B2_MASTER_KEY_ID: "master-id",
    B2_MASTER_KEY: "master-secret",
  });
  // Exercise import-time header sets, alias patterns, and the first warning.
  vi.resetModules();
  credentials = await import("../../src/credentials");
  ({ logger } = await import("../../src/utils/logger"));
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = savedEnv;
});

function auth(extra?: Record<string, unknown>, clientId = "client-A"): AuthInfo {
  return { token: "verified-token", clientId, scopes: [], ...(extra && { extra }) };
}

function request(headers: IncomingHttpHeaders = {}, info?: AuthInfo): CredentialProviderContext {
  return { req: { headers, ...(info && { auth: info }) } as AuthenticatedIncomingMessage };
}

const canonicalHeaders = {
  "x-b2-mcp-key-id": "application-id",
  "x-b2-mcp-key": "application-secret",
  "x-b2-mcp-master-key-id": "master-id",
  "x-b2-mcp-master-key": "master-secret",
};
const credentialHeaders = [
  "x-b2-mcp-key-id",
  "x-b2-mcp-key",
  "x-b2-mcp-master-key-id",
  "x-b2-mcp-master-key",
  "x-b2-key-id",
  "x-b2-key",
  "x-b2-master-key-id",
  "x-b2-master-key",
  "x-b2-app-key-id",
  "x-b2-app-key",
  "x-b2-mcp-app-key-id",
  "x-b2-mcp-app-key",
];

function expectFailure(action: () => unknown, code: string, status: number, message: string) {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(credentials.CredentialResolutionError);
  expect(caught).toMatchObject({ name: "CredentialResolutionError", code, status, message });
}

function setTenant(ref = "TENANT_A", id = "tenant-id", secret = "tenant-secret") {
  process.env[`B2_CREDENTIAL_${ref}_APPLICATION_KEY_ID`] = id;
  process.env[`B2_CREDENTIAL_${ref}_APPLICATION_KEY`] = secret;
}

describe("credential configuration boundaries", () => {
  it("preserves default and explicit credential error contracts", () => {
    expect(new credentials.CredentialResolutionError("specific failure")).toMatchObject({
      name: "CredentialResolutionError",
      message: "specific failure",
      status: 401,
      code: "credential_resolution_failed",
    });
    expect(
      new credentials.CredentialResolutionError("custom failure", 403, "custom_code"),
    ).toMatchObject({
      name: "CredentialResolutionError",
      message: "custom failure",
      status: 403,
      code: "custom_code",
    });
  });

  it.each([undefined, "", "invalid", "ALLOW", " block ", "allow", "block", "confirm", "elicit"])(
    "resolves explicit and fallback destructive policy %s for each transport",
    (value) => {
      if (value === undefined) delete process.env.B2_DESTRUCTIVE_POLICY;
      else process.env.B2_DESTRUCTIVE_POLICY = value;
      const explicit =
        value === "allow" || value === "block" || value === "confirm" || value === "elicit";
      expect(new credentials.StdioEnvCredentialProvider().resolve().config.destructivePolicy).toBe(
        explicit ? value : "confirm",
      );
      expect(
        new credentials.HttpServerCredentialProvider().resolve().config.destructivePolicy,
      ).toBe(explicit ? value : "block");
      expect(
        new credentials.HttpHeaderCredentialProvider().resolve(request(canonicalHeaders)).config
          .destructivePolicy,
      ).toBe(explicit ? value : "block");
    },
  );

  it.each(["B2_MASTER_KEY_ID", "B2_MASTER_KEY"])(
    "handles a partial %s pair per transport",
    (missing) => {
      delete process.env[missing];
      const local = new credentials.StdioEnvCredentialProvider().resolve();
      expect(local.config).toMatchObject({
        masterKeyId: "application-id",
        masterKey: "application-secret",
      });
      expect(logger.warn).toHaveBeenCalledWith(
        { credentialPair: "B2 master key" },
        "credential.partial_ignored",
      );
      expectFailure(
        () => new credentials.HttpServerCredentialProvider().resolve(),
        "partial_credential",
        400,
        "B2 master key must include both id and secret",
      );
      const headers: IncomingHttpHeaders = { ...canonicalHeaders };
      delete headers[
        missing === "B2_MASTER_KEY" ? "x-b2-mcp-master-key" : "x-b2-mcp-master-key-id"
      ];
      expectFailure(
        () => new credentials.HttpHeaderCredentialProvider().resolve(request(headers)),
        "partial_credential",
        400,
        "B2 master key must include both id and secret",
      );
    },
  );

  it.each(["B2_APPLICATION_KEY_ID", "B2_APPLICATION_KEY"])(
    "rejects missing primary %s",
    (missing) => {
      delete process.env[missing];
      expectFailure(
        () => new credentials.StdioEnvCredentialProvider().resolve(),
        "missing_credentials",
        401,
        "B2 application credentials are required",
      );
      expectFailure(
        () => new credentials.HttpServerCredentialProvider().resolve(),
        "missing_credentials",
        401,
        "B2 application credentials are required",
      );
    },
  );

  it.each([
    [undefined, undefined, true, false, null],
    ["false", undefined, false, false, null],
    ["true", undefined, true, false, null],
    ["true", "/safe/root", true, true, "/safe/root"],
    ["false", "/safe/root", false, false, "/safe/root"],
    ["TRUE", "/safe/root", true, false, "/safe/root"],
    ["true", "", true, false, ""],
  ] as const)(
    "resolves local-file permission for %s and root %s",
    (flag, root, local, http, expectedRoot) => {
      if (flag !== undefined) process.env.B2_ALLOW_LOCAL_FILES = flag;
      if (root !== undefined) process.env.B2_FILE_ROOT = root;
      expect(new credentials.StdioEnvCredentialProvider().resolve().config).toMatchObject({
        allowLocalFiles: local,
        fileRoot: expectedRoot,
        transport: "stdio",
      });
      expect(new credentials.HttpServerCredentialProvider().resolve().config).toMatchObject({
        allowLocalFiles: http,
        fileRoot: expectedRoot,
        transport: "http",
      });
    },
  );

  it("keeps primary, S3, and master material distinct while ignoring removed overrides", () => {
    process.env.B2_APP_KEY_ID = "retired-id";
    process.env.B2_APP_KEY = "retired-secret";
    const result = new credentials.StdioEnvCredentialProvider().resolve();
    expect(result.config).toMatchObject({
      applicationKeyId: "application-id",
      applicationKey: "application-secret",
      appKeyId: "application-id",
      appKey: "application-secret",
      masterKeyId: "master-id",
      masterKey: "master-secret",
      region: "us-west-004",
      outputFormat: "json",
      enableMcpPrompts: false,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("config.removed_alias:"));
  });

  it.each([
    [undefined, "us-west-004"],
    ["  ", "us-west-004"],
    [" us-east-005 ", "us-east-005"],
  ])("normalizes region %s", (value, expected) => {
    if (value !== undefined) process.env.B2_REGION = value;
    expect(new credentials.StdioEnvCredentialProvider().resolve().config.region).toBe(expected);
  });

  it("uses independent SHA-256 vectors for public, private, and caller scopes", () => {
    // Independently computed with Python hashlib from the documented ordered,
    // NUL-delimited credential fields and the private verifier domain prefix.
    expect(credentials.credentialFingerprint("abc")).toBe("ba7816bf8f01cfea");
    const local = new credentials.StdioEnvCredentialProvider().resolve();
    expect(credentials.fingerprintConfig(local.config)).toBe("000093ab82f35e1b");
    expect(credentials.verificationFingerprintConfig(local.config)).toBe("2c3850344671eba4");
    expect(local).toMatchObject({
      cacheKey: "credential:000093ab82f35e1b",
      capabilityCacheKey: "credential:2c3850344671eba4",
    });
    expect(local.config).toMatchObject({
      credentialFingerprint: "000093ab82f35e1b",
      callerFingerprint: "7a694e4272962348",
    });
    expect(new credentials.StdioEnvCredentialProvider().name).toBe("stdio-env");
    for (const remote of [
      new credentials.HttpServerCredentialProvider().resolve(),
      new credentials.HttpHeaderCredentialProvider().resolve(request(canonicalHeaders)),
    ]) {
      expect(remote.cacheKey).toBe("credential:000093ab82f35e1b");
      expect(remote.capabilityCacheKey).toBe("credential:2c3850344671eba4");
    }
    const before = local.capabilityCacheKey;
    process.env.B2_APPLICATION_KEY = "rotated-secret";
    const rotated = new credentials.StdioEnvCredentialProvider().resolve();
    expect(rotated.capabilityCacheKey).not.toBe(before);
    expect(rotated.cacheKey).toBe(local.cacheKey);
    expect(rotated.config.callerFingerprint).toBe(local.config.callerFingerprint);
  });
});

describe("HTTP credential parsing and discovery", () => {
  it.each(credentialHeaders)(
    "rejects the %s header before selecting server/principal credentials",
    (header) => {
      expect(credentials.hasCredentialHeaders({ [header]: "untrusted" })).toBe(true);
      expect(credentials.hasCredentialHeaders({ [header.toUpperCase()]: "untrusted" })).toBe(true);
      const broker = { resolve: vi.fn() };
      for (const provider of [
        new credentials.HttpServerCredentialProvider(),
        new credentials.HttpPrincipalCredentialProvider(broker),
      ]) {
        expectFailure(
          () => provider.resolve(request({ [header]: "untrusted" }, auth({ sub: "alice" }))),
          "credential_headers_rejected",
          400,
          "B2 credential headers are not accepted in this mode",
        );
      }
      expect(broker.resolve).not.toHaveBeenCalled();
    },
  );

  it("allows public authorization headers without treating them as B2 credentials", () => {
    expect(
      credentials.hasCredentialHeaders({
        authorization: "Bearer verified-token",
        "x-public": "metadata",
      }),
    ).toBe(false);
    expect(
      new credentials.HttpServerCredentialProvider().resolve(
        request({ authorization: "Bearer verified-token" }),
      ).config.applicationKeyId,
    ).toBe("application-id");
  });

  it.each([undefined, {}])("requires a request in header and principal mode (%s)", (context) => {
    const broker = { resolve: vi.fn() };
    for (const provider of [
      new credentials.HttpHeaderCredentialProvider(),
      new credentials.HttpPrincipalCredentialProvider(broker),
    ]) {
      expectFailure(
        () => provider.resolve(context),
        "request_required",
        500,
        "HTTP request required",
      );
    }
    expect(broker.resolve).not.toHaveBeenCalled();
  });

  it.each(Object.keys(canonicalHeaders))("handles duplicate %s values precisely", (header) => {
    const headers: IncomingHttpHeaders = {
      ...canonicalHeaders,
      [header]: [canonicalHeaders[header as keyof typeof canonicalHeaders], "conflict"],
    };
    expectFailure(
      () => credentials.configFromHttpHeaders({ headers }),
      "conflicting_headers",
      400,
      "Conflicting B2 credential headers",
    );
    headers[header] = [
      canonicalHeaders[header as keyof typeof canonicalHeaders],
      canonicalHeaders[header as keyof typeof canonicalHeaders],
    ];
    expect(credentials.configFromHttpHeaders({ headers })).toMatchObject({
      applicationKeyId: "application-id",
      masterKeyId: "master-id",
    });
  });

  it("returns null only for an incomplete primary header pair", () => {
    expect(credentials.configFromHttpHeaders({ headers: {} })).toBeNull();
    expect(
      credentials.configFromHttpHeaders({ headers: { "x-b2-mcp-key-id": "id-only" } }),
    ).toBeNull();
    expect(
      credentials.configFromHttpHeaders({ headers: { "x-b2-mcp-key": "secret-only" } }),
    ).toBeNull();
    expect(
      credentials.configFromHttpHeaders({
        headers: { "x-b2-key-id": "retired-id", "x-b2-key": "retired-secret" },
      }),
    ).toBeNull();
    expectFailure(
      () =>
        credentials.configFromHttpHeaders({
          headers: {
            "x-b2-mcp-key-id": "id",
            "x-b2-mcp-key": "secret",
            "x-b2-mcp-master-key": "partial",
          },
        }),
      "partial_credential",
      400,
      "B2 master key must include both id and secret",
    );
  });

  it("creates literal discovery placeholders with caller-specific private scopes", () => {
    const first = credentials.httpDiscoveryCredentialResolution();
    const second = credentials.httpDiscoveryCredentialResolution("caller-B");
    expect(credentials.DISCOVERY_MODE_CREDENTIAL).toBe("b2-mcp-discovery-mode");
    expect(first.config).toMatchObject({
      applicationKeyId: "b2-mcp-discovery-mode",
      applicationKey: "b2-mcp-discovery-mode",
      appKeyId: "b2-mcp-discovery-mode",
      appKey: "b2-mcp-discovery-mode",
      masterKeyId: "b2-mcp-discovery-mode",
      masterKey: "b2-mcp-discovery-mode",
      transport: "http",
    });
    expect(first.cacheKey).toBe("credential:b2-mcp-discovery-mode");
    expect(first.capabilityCacheKey).toMatch(/^discovery:[a-f0-9]{16}$/);
    expect(first.capabilityCacheKey).toBe("discovery:c18ce85dafe2e329");
    expect(second.capabilityCacheKey).toBe("discovery:34467ed64c8c484a");
    expect(second.cacheKey).toBe("caller-B");
    expect(second.capabilityCacheKey).not.toBe(first.capabilityCacheKey);
    expect(second.config.callerFingerprint).not.toBe(first.config.callerFingerprint);
  });
});

describe("verified principal selection and isolation", () => {
  it.each([
    [{ sub: " alice " }, "alice"],
    [{ subject: " alice " }, "alice"],
    [{ principal: " alice " }, "alice"],
    [{ sub: 42, subject: "bob" }, "bob"],
    [{ sub: "  ", subject: "bob" }, "bob"],
    [{ sub: "alice", subject: "bob", principal: "eve" }, "alice"],
    [{ sub: " alice ", iss: " https://issuer.example " }, "https://issuer.example#alice"],
    [{ sub: "alice", issuer: " https://issuer.example " }, "https://issuer.example#alice"],
    [{ sub: "alice", iss: "   " }, "alice"],
  ] as Array<[Record<string, unknown>, string]>)(
    "selects only stable verified claims %#",
    (extra, principal) => {
      process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({ [principal]: "tenant_a" });
      setTenant();
      const result = new credentials.HttpPrincipalCredentialProvider().resolve(
        request({}, auth(extra)),
      );
      expect(result).toMatchObject({
        principal,
        config: {
          applicationKeyId: "tenant-id",
          applicationKey: "tenant-secret",
          appKey: "tenant-secret",
          masterKey: "tenant-secret",
        },
      });
      expect(result.cacheKey).toMatch(/^principal:[a-f0-9]{16}$/);
      expect(result.capabilityCacheKey).toMatch(/^principal:[a-f0-9]{16}$/);
      expect(result.cacheKey).not.toContain(principal);
    },
  );

  it.each([undefined, {}, { email: "alice" }, { sub: " " }, { sub: 42 }, { principal: false }])(
    "rejects missing stable identity before broker lookup %#",
    (extra) => {
      process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({
        alice: "tenant_a",
        "client:client-A": "tenant_a",
      });
      const broker = { resolve: vi.fn() };
      expectFailure(
        () =>
          new credentials.HttpPrincipalCredentialProvider(broker).resolve(request({}, auth(extra))),
        "missing_principal",
        401,
        "Verified principal is required",
      );
      expect(broker.resolve).not.toHaveBeenCalled();
    },
  );

  it("requires verified auth info and rejects unmapped principals before broker lookup", () => {
    const broker = { resolve: vi.fn() };
    const provider = new credentials.HttpPrincipalCredentialProvider(broker);
    expectFailure(
      () => provider.resolve(request()),
      "missing_auth_info",
      401,
      "Verified MCP authInfo is required",
    );
    expectFailure(
      () => provider.resolve(request({}, auth({ sub: "unmapped" }))),
      "principal_not_mapped",
      403,
      "No credential mapping for principal",
    );
    expect(broker.resolve).not.toHaveBeenCalled();
  });

  it("separates issuer namespaces and never selects another principal's credential", () => {
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({
      "https://first.example#alice": "tenant_a",
      "https://second.example#alice": "tenant_b",
    });
    setTenant();
    setTenant("TENANT_B", "second-id", "second-secret");
    const provider = new credentials.HttpPrincipalCredentialProvider();
    const first = provider.resolve(
      request({}, auth({ sub: "alice", iss: "https://first.example" })),
    );
    const second = provider.resolve(
      request({}, auth({ sub: "alice", iss: "https://second.example" })),
    );
    expect(first.config.applicationKeyId).toBe("tenant-id");
    expect(second.config.applicationKeyId).toBe("second-id");
    expect(second.cacheKey).not.toBe(first.cacheKey);
    expect(second.capabilityCacheKey).not.toBe(first.capabilityCacheKey);
    expect(second.config.callerFingerprint).not.toBe(first.config.callerFingerprint);
    expectFailure(
      () => provider.resolve(request({}, auth({ sub: "alice", iss: "https://unknown.example" }))),
      "principal_not_mapped",
      403,
      "No credential mapping for principal",
    );
  });

  it.each(["server", "headers"] as const)(
    "scopes %s rates to trimmed subjects or clients without changing capability caches",
    (mode) => {
      const provider =
        mode === "server"
          ? new credentials.HttpServerCredentialProvider()
          : new credentials.HttpHeaderCredentialProvider();
      const headers = mode === "headers" ? canonicalHeaders : {};
      const plain = provider.resolve(request(headers));
      const alice = provider.resolve(request(headers, auth({ sub: " alice " })));
      const same = provider.resolve(request(headers, auth({ sub: "alice" }, "different-client")));
      const client = provider.resolve(request(headers, auth(undefined, " client-A ")));
      const blank = provider.resolve(request(headers, auth(undefined, "   ")));
      expect(alice.cacheKey).toMatch(
        mode === "server"
          ? /^server-principal:[a-f0-9]{16}$/
          : /^credential-principal:[a-f0-9]{16}:verified-principal:[a-f0-9]{16}$/,
      );
      expect(same.cacheKey).toBe(alice.cacheKey);
      expect(client.cacheKey).not.toBe(alice.cacheKey);
      expect(client.cacheKey).not.toBe(plain.cacheKey);
      expect(blank.cacheKey).toBe(plain.cacheKey);
      expect(alice.config.callerFingerprint).not.toBe(plain.config.callerFingerprint);
      expect(client.config.callerFingerprint).not.toBe(plain.config.callerFingerprint);
      for (const result of [plain, alice, same, client, blank])
        expect(result.capabilityCacheKey).toBe(plain.capabilityCacheKey);
      if (mode === "server") {
        expect(alice.principal).toBe("alice");
        expect(client.principal).toBe("client:client-A");
        expect(plain).not.toHaveProperty("principal");
        expect(blank).not.toHaveProperty("principal");
      }
    },
  );
});

describe("principal map and secret broker validation", () => {
  it("binds principal capability scopes to both the identity and rotated secret", () => {
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({
      alice: "tenant_a",
      bob: "tenant_a",
    });
    setTenant();
    const provider = new credentials.HttpPrincipalCredentialProvider();
    const first = provider.resolve(request({}, auth({ sub: "alice" })));
    const other = provider.resolve(request({}, auth({ sub: "bob" })));
    // Independent hashlib vector: SHA-256 of the principal, NUL delimiter,
    // and the private credential fingerprint 47f422a602f60f9e, truncated to 16.
    expect(first.cacheKey).toBe("principal:2bd806c97f0e00af");
    expect(first.capabilityCacheKey).toBe("principal:bac1b8e6489dc829");
    expect(other.capabilityCacheKey).not.toBe(first.capabilityCacheKey);
    process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY = "rotated-tenant-secret";
    const rotated = provider.resolve(request({}, auth({ sub: "alice" })));
    expect(rotated.cacheKey).toBe(first.cacheKey);
    expect(rotated.capabilityCacheKey).not.toBe(first.capabilityCacheKey);
  });

  it.each(["not json", "null", "false", "42", '"text"', "[]"])(
    "rejects invalid map %s at startup before lookup",
    (raw) => {
      process.env.B2_PRINCIPAL_CREDENTIAL_MAP = raw;
      const broker = { resolve: vi.fn() };
      const provider = new credentials.HttpPrincipalCredentialProvider(broker);
      expectFailure(
        () => provider.validateConfiguration(),
        "invalid_principal_map",
        500,
        "Invalid principal credential map",
      );
      expectFailure(
        () => provider.resolve(request({}, auth({ sub: "alice" }))),
        "invalid_principal_map",
        500,
        "Invalid principal credential map",
      );
      expect(broker.resolve).not.toHaveBeenCalled();
    },
  );

  it.each(["", "prefix!tenant", "tenant!suffix", "tenant/ref", "a".repeat(81)])(
    "rejects invalid reference %s",
    (ref) => {
      expectFailure(
        () => new credentials.EnvSecretBroker().resolve(ref),
        "invalid_credential_ref",
        500,
        "Invalid credential reference",
      );
      process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({ alice: ref });
      expectFailure(
        () => new credentials.HttpPrincipalCredentialProvider().validateConfiguration(),
        "invalid_principal_map",
        500,
        "Invalid principal credential map",
      );
    },
  );

  it.each(["a", "a".repeat(80), "tenant-a", "tenant_A2"])(
    "normalizes valid reference %s",
    (ref) => {
      const normalized = ref.toUpperCase().replace(/-/g, "_");
      setTenant(normalized);
      expect(new credentials.EnvSecretBroker().resolve(ref)).toEqual({
        applicationKeyId: "tenant-id",
        applicationKey: "tenant-secret",
        masterKeyId: undefined,
        masterKey: undefined,
      });
    },
  );

  it.each(["B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID", "B2_CREDENTIAL_TENANT_A_APPLICATION_KEY"])(
    "returns no broker material when %s is missing",
    (missing) => {
      setTenant();
      delete process.env[missing];
      expect(new credentials.EnvSecretBroker().resolve("tenant_a")).toBeNull();
    },
  );

  it("resolves explicit shared refs, rejects normalization collisions, and refreshes changed maps", () => {
    setTenant();
    setTenant("TENANT_B", "second-id", "second-secret");
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({
      alice: "tenant_a",
      bob: "tenant_a",
      ignored: 42,
    });
    const provider = new credentials.HttpPrincipalCredentialProvider();
    expect(provider.resolve(request({}, auth({ sub: "alice" }))).config.applicationKeyId).toBe(
      "tenant-id",
    );
    expect(provider.resolve(request({}, auth({ sub: "bob" }))).config.applicationKeyId).toBe(
      "tenant-id",
    );
    expectFailure(
      () => provider.resolve(request({}, auth({ sub: "ignored" }))),
      "principal_not_mapped",
      403,
      "No credential mapping for principal",
    );
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({ alice: "tenant_b" });
    expect(provider.resolve(request({}, auth({ sub: "alice" }))).config.applicationKeyId).toBe(
      "second-id",
    );
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({
      alice: "tenant-a",
      bob: "tenant_a",
    });
    expectFailure(
      () => provider.validateConfiguration(),
      "invalid_principal_map",
      500,
      "Invalid principal credential map",
    );
  });

  it("does not resolve absent refs or inherited map properties", () => {
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({ alice: "missing" });
    const broker = { resolve: vi.fn().mockReturnValue(null) };
    const provider = new credentials.HttpPrincipalCredentialProvider(broker);
    expectFailure(
      () => provider.resolve(request({}, auth({ sub: "alice" }))),
      "credential_ref_not_found",
      403,
      "Credential reference not found",
    );
    expect(broker.resolve).toHaveBeenCalledExactlyOnceWith("missing");
    broker.resolve.mockClear();
    expectFailure(
      () => provider.resolve(request({}, auth({ sub: "toString" }))),
      "principal_not_mapped",
      403,
      "No credential mapping for principal",
    );
    expect(broker.resolve).not.toHaveBeenCalled();
  });
});

describe("startup preflight and migration warnings", () => {
  it("allows the server provider to resolve without a request-bearing context", () => {
    const provider = new credentials.HttpServerCredentialProvider();
    expect(provider.resolve({})).toEqual(provider.resolve());
  });

  it.each(["stdio", "http"] as const)(
    "preflights an unusable explicit file sink during %s startup",
    (transport) => {
      const dir = mkdtempSync(join(tmpdir(), "b2-mcp-credential-preflight-"));
      const parent = join(dir, "regular-file-parent");
      const file = join(parent, "secrets.jsonl");
      try {
        writeFileSync(parent, "unchanged-public-marker");
        process.env.B2_SECRET_SINK = "file";
        process.env.B2_SECRET_SINK_FILE = file;
        process.env.B2_ALLOW_LOCAL_FILES = "true";
        const preflight =
          transport === "stdio"
            ? () => new credentials.StdioEnvCredentialProvider().resolve()
            : () => credentials.validateHttpStartupConfiguration();
        expect(preflight).toThrow(/B2_SECRET_SINK=file could not open/);
        expect(readFileSync(parent, "utf8")).toBe("unchanged-public-marker");
        expect(existsSync(file)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [undefined, "headers", "http-headers"],
    [" SERVER ", "server", "http-server"],
    [" Principal ", "principal", "http-principal"],
    [" HEADERS ", "headers", "http-headers"],
  ])("normalizes credential mode %s", (raw, mode, name) => {
    if (raw !== undefined) process.env.B2_HTTP_CREDENTIAL_MODE = raw;
    expect(credentials.getHttpCredentialMode()).toBe(mode);
    expect(credentials.getHttpCredentialProvider().name).toBe(name);
  });

  it.each(["", "unsupported"])("rejects credential mode %s", (raw) => {
    process.env.B2_HTTP_CREDENTIAL_MODE = raw;
    expectFailure(
      () => credentials.getHttpCredentialMode(),
      "invalid_credential_mode",
      500,
      "Invalid B2_HTTP_CREDENTIAL_MODE",
    );
  });

  it("runs provider preflight only after request-independent startup validation", () => {
    const provider = { name: "test", resolve: vi.fn(), validateConfiguration: vi.fn() };
    credentials.validateHttpCredentialConfiguration(provider);
    expect(provider.validateConfiguration).toHaveBeenCalledTimes(1);
    expect(provider.resolve).not.toHaveBeenCalled();
    process.env.B2_HTTP_CREDENTIAL_MODE = "unsupported";
    expectFailure(
      () => credentials.validateHttpCredentialConfiguration(provider),
      "invalid_credential_mode",
      500,
      "Invalid B2_HTTP_CREDENTIAL_MODE",
    );
    expect(provider.validateConfiguration).toHaveBeenCalledTimes(1);
  });

  it("supports providers without an optional preflight and validates server credentials", () => {
    const provider = { name: "test", resolve: vi.fn() };
    expect(() => credentials.validateHttpCredentialConfiguration(provider)).not.toThrow();
    expect(provider.resolve).not.toHaveBeenCalled();
    delete process.env.B2_APPLICATION_KEY;
    expectFailure(
      () => new credentials.HttpServerCredentialProvider().validateConfiguration(),
      "missing_credentials",
      401,
      "B2 application credentials are required",
    );
  });

  it("wraps a non-Error output encoder preflight failure without exposing it", async () => {
    const serializer = await import("../../src/utils/result-serializer");
    const failure: unknown = { secret: "private-preflight-detail" };
    const preflight = vi.spyOn(serializer, "preflightMcpOutputFormat").mockImplementation(() => {
      throw failure;
    });
    expectFailure(
      () => credentials.validateHttpStartupConfiguration(),
      "invalid_output_format",
      500,
      "Invalid B2_MCP_OUTPUT_FORMAT",
    );
    expect(preflight).toHaveBeenCalledTimes(1);
  });

  it.each([
    "B2_APP_KEY",
    "B2_APP_KEY_ID",
    "B2_APP_KEY_FILE",
    "B2_APP_KEY_ID_FILE",
    "B2_CREDENTIAL_TEAM_2_APP_KEY",
    "B2_CREDENTIAL_TEAM_2_APP_KEY_ID",
    "B2_CREDENTIAL_TEAM_2_APP_KEY_FILE",
    "B2_CREDENTIAL_TEAM_2_APP_KEY_ID_FILE",
  ])("warns once for the retired %s alias without its value", (name) => {
    process.env[name] = "private-retired-value";
    credentials.warnRemovedCredentialEnvAliases();
    credentials.warnRemovedCredentialEnvAliases();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no longer read and are ignored"),
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
      "private-retired-value",
    );
    credentials._resetRemovedCredentialEnvAliasWarning();
    credentials.warnRemovedCredentialEnvAliases();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it.each([
    "PREFIX_B2_CREDENTIAL_TEAM_APP_KEY",
    "B2_CREDENTIAL_TEAM_APP_KEY_SUFFIX",
    "B2_CREDENTIAL__APP_KEY",
    "B2_CREDENTIAL_!_APP_KEY",
    "B2_CREDENTIAL_TEAM_APPLICATION_KEY",
  ])("does not warn for unrelated environment name %s", (name) => {
    process.env[name] = "public-value";
    credentials.warnRemovedCredentialEnvAliases();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("checks migration aliases at HTTP startup", () => {
    process.env.B2_APP_KEY = "private-retired-value";
    credentials.validateHttpStartupConfiguration();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("config.removed_alias:"),
    );
  });
});
