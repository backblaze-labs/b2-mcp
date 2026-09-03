import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  closeCloudflareMcpHandlerForTests,
  cloudflareHealthFetch,
  cloudflareMcpFetch,
  cloudflareProtectedResourceMetadataFetch,
  cloudflareWorkerFetch,
} from "../../deploy/cloudflare-worker/adapter";
import { deriveRateKey } from "../../src/http-fetch-handler";
import { _getBucket, _resetRateLimiter } from "../../src/utils/rate-limiter";
import { jwksResponse, signedJwt } from "../support/oauth-jwks";
import { introspectionResponse } from "../support/oauth-introspection";

const savedEnv = { ...process.env };

const validAuthInfo: AuthInfo = {
  token: "redacted-test-token",
  clientId: "client",
  scopes: ["b2:read"],
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  resource: new URL("https://mcp.example.com/mcp"),
  extra: {
    iss: "https://issuer.example.com/",
    sub: "subject",
    aud: ["https://mcp.example.com/mcp"],
    resource: ["https://mcp.example.com/mcp"],
    alg: "RS256",
    token_type: "Bearer",
    nbf: Math.floor(Date.now() / 1000) - 60,
  },
};

function cloudflareEnv(): NodeJS.ProcessEnv {
  return {
    ...savedEnv,
    B2_HTTP_CREDENTIAL_MODE: "server",
    B2_APPLICATION_KEY_ID: "app-id",
    B2_APPLICATION_KEY: "app-secret",
    B2_ALLOWED_HOSTS: "mcp.example.com",
    B2_DESTRUCTIVE_POLICY: "block",
    B2_OAUTH_ISSUER: "https://issuer.example.com/",
    B2_OAUTH_AUTHORIZATION_ENDPOINT: "https://issuer.example.com/oauth2/authorize",
    B2_OAUTH_TOKEN_ENDPOINT: "https://issuer.example.com/oauth2/token",
    B2_OAUTH_INTROSPECTION_ENDPOINT: "https://issuer.example.com/oauth2/introspect",
    B2_OAUTH_INTROSPECTION_CLIENT_ID: "client",
    B2_OAUTH_INTROSPECTION_CLIENT_SECRET: "secret",
    B2_OAUTH_RESOURCE: "https://mcp.example.com/mcp",
    B2_OAUTH_AUDIENCE: "https://mcp.example.com/mcp",
    B2_OAUTH_ALLOWED_SUBJECTS: "subject",
    B2_MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
    B2_REGISTER_ALL_TOOLS: "true",
    B2_ALLOW_LOCAL_FILES: "false",
  };
}

function setCloudflareEnv() {
  process.env = cloudflareEnv();
}

function modernBody(method: string, params: Record<string, unknown> = {}, id = 1): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
}

function modernHeaders(method: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    host: "mcp.example.com",
    "Mcp-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
  };
}

async function rpcJson(response: Response): Promise<Record<string, any>> {
  expect(response.status).toBe(200);
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  return JSON.parse(dataLine ?? text) as Record<string, any>;
}

describe("Cloudflare Worker adapter", () => {
  beforeEach(async () => {
    await closeCloudflareMcpHandlerForTests();
    setCloudflareEnv();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await closeCloudflareMcpHandlerForTests();
    _resetRateLimiter();
    process.env = savedEnv;
  });

  afterAll(async () => {
    await closeCloudflareMcpHandlerForTests();
  });

  it("installs Worker bindings before serving health", async () => {
    process.env = { ...savedEnv };
    const response = await cloudflareWorkerFetch(
      new Request("https://mcp.example.com/health"),
      cloudflareEnv(),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "ok", server: "backblaze-b2-mcp" });
    expect(JSON.stringify(body)).not.toContain("app-secret");
  });

  it("serves OAuth metadata without exposing secrets", async () => {
    const response = cloudflareProtectedResourceMetadataFetch();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ resource: "https://mcp.example.com/mcp" });
    expect(JSON.stringify(body)).not.toContain("app-secret");
  });

  it("serves modern discovery through the Worker adapter", async () => {
    const discover = await rpcJson(
      await cloudflareMcpFetch(
        new Request("https://mcp.example.com/mcp", {
          method: "POST",
          headers: modernHeaders("server/discover"),
          body: modernBody("server/discover"),
        }),
        validAuthInfo,
      ),
    );

    expect(discover.result?.supportedVersions).toContain("2026-07-28");
  });

  it("rejects missing bearer auth through the Worker entrypoint", async () => {
    process.env = { ...savedEnv };
    const response = await cloudflareWorkerFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: modernHeaders("tools/list"),
        body: modernBody("tools/list"),
      }),
      cloudflareEnv(),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects inactive bearer tokens through the Worker entrypoint", async () => {
    process.env = { ...savedEnv };
    const introspection = vi.fn().mockResolvedValue(introspectionResponse({ active: false }));
    vi.stubGlobal("fetch", introspection);

    const response = await cloudflareWorkerFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { ...modernHeaders("tools/list"), Authorization: "Bearer access-token" },
        body: modernBody("tools/list"),
      }),
      cloudflareEnv(),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(introspection).toHaveBeenCalledTimes(1);
  });

  it("accepts introspected bearer tokens through the Worker entrypoint", async () => {
    process.env = { ...savedEnv };
    const introspection = vi.fn().mockResolvedValue(introspectionResponse());
    vi.stubGlobal("fetch", introspection);

    const discover = await rpcJson(
      await cloudflareWorkerFetch(
        new Request("https://mcp.example.com/mcp", {
          method: "POST",
          headers: { ...modernHeaders("server/discover"), Authorization: "Bearer access-token" },
          body: modernBody("server/discover"),
        }),
        cloudflareEnv(),
      ),
    );

    expect(discover.result?.supportedVersions).toContain("2026-07-28");
    expect(introspection).toHaveBeenCalledTimes(1);
  });

  it("accepts locally verified JWT bearer tokens through the Worker entrypoint", async () => {
    process.env = { ...savedEnv };
    const env = {
      ...cloudflareEnv(),
      B2_OAUTH_INTROSPECTION_ENDPOINT: undefined,
      B2_OAUTH_INTROSPECTION_CLIENT_ID: undefined,
      B2_OAUTH_INTROSPECTION_CLIENT_SECRET: undefined,
      B2_OAUTH_JWKS_URI: "https://issuer.example.com/oauth2/jwks",
    };
    const jwksFetch = vi.fn(async () => jwksResponse());
    vi.stubGlobal("fetch", jwksFetch);

    const discover = await rpcJson(
      await cloudflareWorkerFetch(
        new Request("https://mcp.example.com/mcp", {
          method: "POST",
          headers: { ...modernHeaders("server/discover"), Authorization: `Bearer ${signedJwt()}` },
          body: modernBody("server/discover"),
        }),
        env,
      ),
    );

    expect(discover.result?.supportedVersions).toContain("2026-07-28");
    expect(jwksFetch).toHaveBeenCalledTimes(1);
  });

  it("routes Worker JWKS fetches through a service binding when present", async () => {
    process.env = { ...savedEnv };
    const globalFetch = vi.fn(async () => {
      throw new Error("global fetch should not be used for JWKS");
    });
    const jwksService = {
      fetch: vi.fn(async (request: Request) => {
        expect(request.method).toBe("GET");
        expect(request.redirect).toBe("manual");
        expect(request.url).toBe("https://issuer.example.com/oauth2/jwks");
        return jwksResponse();
      }),
    };
    vi.stubGlobal("fetch", globalFetch);
    const env = {
      ...cloudflareEnv(),
      B2_OAUTH_INTROSPECTION_ENDPOINT: undefined,
      B2_OAUTH_INTROSPECTION_CLIENT_ID: undefined,
      B2_OAUTH_INTROSPECTION_CLIENT_SECRET: undefined,
      B2_OAUTH_JWKS_URI: "https://issuer.example.com/oauth2/jwks",
      B2_CLOUDFLARE_WORKER_SMOKE: "true",
      B2_CLOUDFLARE_WORKER_SMOKE_JWKS_SERVICE: jwksService,
    };

    const discover = await rpcJson(
      await cloudflareWorkerFetch(
        new Request("https://mcp.example.com/mcp", {
          method: "POST",
          headers: { ...modernHeaders("server/discover"), Authorization: `Bearer ${signedJwt()}` },
          body: modernBody("server/discover"),
        }),
        env,
      ),
    );

    expect(discover.result?.supportedVersions).toContain("2026-07-28");
    expect(jwksService.fetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("keeps the JWKS service binding smoke-only", async () => {
    process.env = { ...savedEnv };
    const globalFetch = vi.fn(async () => jwksResponse());
    const jwksService = {
      fetch: vi.fn(async () => {
        throw new Error("smoke-only JWKS binding should not be used");
      }),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", globalFetch);
    const env = {
      ...cloudflareEnv(),
      B2_OAUTH_INTROSPECTION_ENDPOINT: undefined,
      B2_OAUTH_INTROSPECTION_CLIENT_ID: undefined,
      B2_OAUTH_INTROSPECTION_CLIENT_SECRET: undefined,
      B2_OAUTH_JWKS_URI: "https://issuer.example.com/oauth2/jwks",
      B2_CLOUDFLARE_WORKER_SMOKE_JWKS_SERVICE: jwksService,
    };

    const discover = await rpcJson(
      await cloudflareWorkerFetch(
        new Request("https://mcp.example.com/mcp", {
          method: "POST",
          headers: { ...modernHeaders("server/discover"), Authorization: `Bearer ${signedJwt()}` },
          body: modernBody("server/discover"),
        }),
        env,
      ),
    );

    expect(discover.result?.supportedVersions).toContain("2026-07-28");
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(jwksService.fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cloudflare_worker.oauth.test_jwks_service_binding_inactive"),
    );
  });

  it("rejects bearer tokens whose subject is outside the local allowlist", async () => {
    process.env = { ...savedEnv };
    const introspection = vi
      .fn()
      .mockResolvedValue(
        introspectionResponse({ sub: "attacker-subject", client_id: "attacker-client" }),
      );
    vi.stubGlobal("fetch", introspection);

    const response = await cloudflareWorkerFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { ...modernHeaders("tools/list"), Authorization: "Bearer access-token" },
        body: modernBody("tools/list"),
      }),
      cloudflareEnv(),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(introspection).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized MCP bodies before Worker OAuth introspection", async () => {
    process.env = { ...savedEnv };
    const introspection = vi.fn().mockResolvedValue(introspectionResponse());
    vi.stubGlobal("fetch", introspection);

    const response = await cloudflareWorkerFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { ...modernHeaders("tools/list"), Authorization: "Bearer access-token" },
        body: "x".repeat(1 * 1024 * 1024 + 1),
      }),
      cloudflareEnv(),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "Request body too large" });
    expect(introspection).not.toHaveBeenCalled();
  });

  it("revalidates pre-supplied AuthInfo subjects before MCP dispatch", async () => {
    const response = await cloudflareMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: modernHeaders("tools/list"),
        body: modernBody("tools/list"),
      }),
      {
        ...validAuthInfo,
        extra: { ...validAuthInfo.extra, sub: "attacker-subject" },
      },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects pre-supplied AuthInfo without an accepted B2 scope", async () => {
    const response = await cloudflareMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: modernHeaders("tools/list"),
        body: modernBody("tools/list"),
      }),
      {
        ...validAuthInfo,
        scopes: ["profile"],
      },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain("insufficient_scope");
  });

  it("rejects public B2 credential headers in server mode", async () => {
    const response = await cloudflareMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: {
          ...modernHeaders("tools/list"),
          "X-B2-MCP-Key-Id": "public-id",
          "X-B2-MCP-Key": "public-secret",
        },
        body: modernBody("tools/list"),
      }),
      validAuthInfo,
    );
    const body = (await response.json()) as {
      error: { message: string; data: { code: string; status: number } };
      id: number;
      jsonrpc: string;
    };

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: {
        message: expect.stringMatching(/not accepted/i),
        data: { code: "credential_headers_rejected", status: 400 },
      },
    });
  });

  it("fails closed when Worker header credential mode is not explicitly enabled", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "headers";

    const response = await cloudflareHealthFetch(new Request("https://mcp.example.com/health"));
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe("configuration_error");
  });

  it("requires serverless local file access to stay disabled", async () => {
    process.env.B2_ALLOW_LOCAL_FILES = "true";

    const response = await cloudflareHealthFetch(new Request("https://mcp.example.com/health"));
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe("configuration_error");
  });

  it("honors Worker binding rate-limit overrides after request-scoped env install", async () => {
    process.env = { ...savedEnv };
    const env = { ...cloudflareEnv(), B2_MCP_RATE_LIMIT_RPS: "1", B2_MCP_RATE_LIMIT_BURST: "1" };
    const request = () =>
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: modernHeaders("tools/list"),
        body: modernBody("tools/list"),
      });

    const first = await cloudflareWorkerFetch(request(), env, {
      remoteAddress: "198.51.100.5",
    });
    const second = await cloudflareWorkerFetch(request(), env, {
      remoteAddress: "198.51.100.5",
    });

    expect(first.status).toBe(401);
    expect(second.status).toBe(429);
    expect(_getBucket(deriveRateKey("cloudflare-worker-oauth:198.51.100.5"))).toBeDefined();
  });

  it("does not trust spoofed IP headers for unauthenticated admission keys", async () => {
    process.env = { ...savedEnv };
    const env = { ...cloudflareEnv(), B2_MCP_RATE_LIMIT_RPS: "1", B2_MCP_RATE_LIMIT_BURST: "1" };
    const first = await cloudflareWorkerFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: {
          ...modernHeaders("tools/list"),
          "cf-connecting-ip": "198.51.100.20",
          "x-real-ip": "198.51.100.10",
        },
        body: modernBody("tools/list"),
      }),
      env,
    );
    const second = await cloudflareWorkerFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: {
          ...modernHeaders("tools/list"),
          "cf-connecting-ip": "198.51.100.21",
          "x-real-ip": "198.51.100.11",
        },
        body: modernBody("tools/list"),
      }),
      env,
    );

    expect(first.status).toBe(401);
    expect(second.status).toBe(429);
    expect(_getBucket(deriveRateKey("cloudflare-worker-oauth:unknown"))).toBeDefined();
    expect(_getBucket(deriveRateKey("cloudflare-worker-oauth:198.51.100.10"))).toBeUndefined();
    expect(_getBucket(deriveRateKey("cloudflare-worker-oauth:198.51.100.11"))).toBeUndefined();
    expect(_getBucket(deriveRateKey("cloudflare-worker-oauth:198.51.100.20"))).toBeUndefined();
    expect(_getBucket(deriveRateKey("cloudflare-worker-oauth:198.51.100.21"))).toBeUndefined();
  });
});
