// cspell:ignore unstub
import { ReadableStream } from "node:stream/web";
import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  closeVercelMcpHandlerForTests,
  vercelHealthFetch,
  vercelMcpFetch,
  vercelProtectedResourceMetadataFetch,
} from "../../deploy/vercel/adapter";
import { logger } from "../../src/utils/logger";

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

function setVercelEnv() {
  process.env = {
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
    B2_OAUTH_INTROSPECTION_TIMEOUT_MS: "25",
    B2_OAUTH_RESOURCE: "https://mcp.example.com/mcp",
    B2_OAUTH_AUDIENCE: "https://mcp.example.com/mcp",
    B2_OAUTH_ALLOWED_SUBJECTS: "subject",
    B2_MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
    B2_REGISTER_ALL_TOOLS: "true",
  };
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

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    host: "mcp.example.com",
    ...extra,
  };
}

function modernHeaders(method: string, name?: string): Record<string, string> {
  return jsonHeaders({
    "Mcp-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
    ...(name && { "Mcp-Name": name }),
  });
}

function legacyInitializeBody(protocolVersion = "2025-06-18"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "b2-mcp-vercel-test", version: "1.0.0" },
    },
  });
}

function legacyBody(method: string, params: Record<string, unknown> = {}, id = 2): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function introspectionClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active: true,
    iss: "https://issuer.example.com/",
    sub: "subject",
    aud: ["https://mcp.example.com/mcp"],
    resource: ["https://mcp.example.com/mcp"],
    exp: Math.floor(Date.now() / 1000) + 600,
    token_type: "bearer",
    alg: "RS256",
    scope: "b2:read",
    client_id: "client",
    ...overrides,
  };
}

function introspectionResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify(introspectionClaims(overrides)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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

describe("Vercel adapter", () => {
  beforeEach(async () => {
    await closeVercelMcpHandlerForTests();
    setVercelEnv();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await closeVercelMcpHandlerForTests();
    process.env = savedEnv;
  });

  afterAll(async () => {
    await closeVercelMcpHandlerForTests();
  });

  it("serves OAuth Protected Resource Metadata without exposing secrets", async () => {
    const response = vercelProtectedResourceMetadataFetch();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      resource: "https://mcp.example.com/mcp",
      authorization_servers: ["https://issuer.example.com/"],
      scopes_supported: ["b2:read", "b2:write", "b2:admin"],
    });
    expect(JSON.stringify(body)).not.toContain("app-secret");
  });

  it("serves bounded health metadata from static configuration", async () => {
    const response = await vercelHealthFetch(
      new Request("https://mcp.example.com/health", { headers: { host: "mcp.example.com" } }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      server: "backblaze-b2-mcp",
      activeSessions: 0,
      openSubscriptions: 0,
    });
    expect(JSON.stringify(body)).not.toContain("app-secret");
    expect(JSON.stringify(body)).not.toContain("app-id");
  });

  it("returns a bearer challenge before credential resolution when auth is missing", async () => {
    const response = await vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", { headers: { host: "mcp.example.com" } }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(response.headers.get("www-authenticate")).toContain(
      ".well-known/oauth-protected-resource/mcp",
    );
  });

  it.each([
    ["wrong path", "https://mcp.example.com/not-mcp", "POST", jsonHeaders(), 404],
    ["wrong method", "https://mcp.example.com/mcp", "PUT", jsonHeaders(), 405],
    [
      "wrong host",
      "https://mcp.example.com/mcp",
      "POST",
      jsonHeaders({ host: "evil.example.com" }),
      403,
    ],
    [
      "wrong origin",
      "https://mcp.example.com/mcp",
      "POST",
      jsonHeaders({ Origin: "https://evil.example.com" }),
      403,
    ],
  ])("rejects %s before OAuth introspection", async (_name, url, method, headers, status) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await vercelMcpFetch(
      new Request(url, {
        method,
        headers: { ...headers, Authorization: "Bearer access-token" },
        body: method === "POST" || method === "PUT" ? "{}" : undefined,
      }),
    );

    expect(response.status).toBe(status);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed Authorization headers before OAuth introspection", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: jsonHeaders({ Authorization: "Basic access-token" }),
        body: modernBody("tools/list"),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores forged identity headers and uses verified token claims", async () => {
    const introspection = vi.fn().mockResolvedValue(introspectionResponse());
    vi.stubGlobal("fetch", introspection);

    const listed = await rpcJson(
      await vercelMcpFetch(
        new Request("https://mcp.example.com/mcp", {
          method: "POST",
          headers: {
            ...modernHeaders("tools/list"),
            Authorization: "Bearer access-token",
            "X-Principal": "attacker-subject",
            "X-User": "attacker-user",
          },
          body: modernBody("tools/list"),
        }),
        { remoteAddress: "203.0.113.42" },
      ),
    );
    const toolNames = new Set(
      ((listed.result?.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name),
    );

    expect(toolNames.has("b2_list_buckets")).toBe(true);
    expect(toolNames.has("b2_create_bucket")).toBe(false);
    expect(introspection).toHaveBeenCalledTimes(1);
  });

  it("serves modern discovery and tools/list through the Vercel adapter", async () => {
    const discoverResponse = await vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: modernHeaders("server/discover"),
        body: modernBody("server/discover"),
      }),
      validAuthInfo,
    );
    const listedResponse = await vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: modernHeaders("tools/list"),
        body: modernBody("tools/list", {}, 2),
      }),
      validAuthInfo,
    );
    const discover = await rpcJson(discoverResponse);
    const listed = await rpcJson(listedResponse);
    const toolNames = new Set(
      ((listed.result?.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name),
    );

    expect(discoverResponse.headers.get("cache-control") ?? "").not.toMatch(/\bpublic\b/i);
    expect(listedResponse.headers.get("cache-control") ?? "").not.toMatch(/\bpublic\b/i);
    expect(discover.result?.supportedVersions).toContain("2026-07-28");
    expect(discover.result?.capabilities?.tools).toBeDefined();
    expect(discover.result?.ttlMs).toBe(30_000);
    expect(discover.result?.cacheScope).toBe("private");
    expect(listed.result?.ttlMs).toBe(30_000);
    expect(listed.result?.cacheScope).toBe("private");
    expect(toolNames.has("b2_list_buckets")).toBe(true);
    expect(toolNames.has("b2_create_bucket")).toBe(false);
  });

  it("serves the named 2025 stateless fallback through the Vercel adapter", async () => {
    const initialized = await rpcJson(
      await vercelMcpFetch(
        new Request("https://mcp.example.com/mcp", {
          method: "POST",
          headers: jsonHeaders(),
          body: legacyInitializeBody(),
        }),
        validAuthInfo,
      ),
    );
    const listed = await rpcJson(
      await vercelMcpFetch(
        new Request("https://mcp.example.com/mcp", {
          method: "POST",
          headers: jsonHeaders(),
          body: legacyBody("tools/list"),
        }),
        validAuthInfo,
      ),
    );
    const toolNames = new Set(
      ((listed.result?.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name),
    );

    expect(initialized.result?.protocolVersion).toBe("2025-06-18");
    expect(toolNames.has("b2_list_buckets")).toBe(true);
  });

  it("rejects declared oversized bodies before OAuth introspection", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: {
          ...jsonHeaders({ Authorization: "Bearer access-token" }),
          "Content-Length": String(1024 * 1024 + 1),
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects chunked oversized bodies before OAuth introspection", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });

    const response = await vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: jsonHeaders({ Authorization: "Bearer access-token" }),
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts slow pre-auth bodies before buffering completes", async () => {
    process.env.B2_MAX_SESSIONS_PER_KEY = "1";
    await closeVercelMcpHandlerForTests();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ active: false }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    let slowController: { enqueue(chunk: Uint8Array): void; close(): void } | undefined;
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        slowController = controller;
      },
    });

    const first = vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: jsonHeaders({ Authorization: "Bearer slow" }),
        body: slowBody,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      { remoteAddress: "203.0.113.10" },
    );

    const second = await vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: jsonHeaders({ Authorization: "Bearer second" }),
        body: "{}",
      }),
      { remoteAddress: "203.0.113.10" },
    );

    expect(second.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();

    slowController?.enqueue(new TextEncoder().encode("{}"));
    slowController?.close();
    await expect(first).resolves.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throttles concurrent invalid-token requests before unbounded introspection", async () => {
    process.env.B2_MAX_SESSIONS_PER_KEY = "1";
    await closeVercelMcpHandlerForTests();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Timed out")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: {
          ...jsonHeaders({ Authorization: "Bearer first" }),
          "x-forwarded-for": "203.0.113.10",
        },
        body: "{}",
      }),
      { remoteAddress: "198.51.100.42" },
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const second = await vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: {
          ...jsonHeaders({ Authorization: "Bearer second" }),
          "x-forwarded-for": "203.0.113.99",
          "x-real-ip": "203.0.113.100",
        },
        body: "{}",
      }),
      { remoteAddress: "198.51.100.42" },
    );

    expect(second.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "in_flight_limit", status: 429 }),
      "vercel.oauth.admission_rejected",
    );
    await expect(first).resolves.toMatchObject({ status: 503 });
  });

  it("keeps OAuth admission buckets independent for distinct clients", async () => {
    process.env.B2_MAX_SESSIONS_PER_KEY = "1";
    await closeVercelMcpHandlerForTests();
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Timed out")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: jsonHeaders({ Authorization: "Bearer first" }),
        body: "{}",
      }),
      { remoteAddress: "203.0.113.10" },
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const second = vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: jsonHeaders({ Authorization: "Bearer second" }),
        body: "{}",
      }),
      { remoteAddress: "203.0.113.11" },
    );
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));

    await expect(first).resolves.toMatchObject({ status: 503 });
    await expect(second).resolves.toMatchObject({ status: 503 });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects public B2 credential headers in server mode", async () => {
    const response = await vercelMcpFetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: {
          ...modernHeaders("tools/list"),
          "X-B2-Key-Id": "public-id",
          "X-B2-Key": "public-secret",
        },
        body: modernBody("tools/list"),
      }),
      validAuthInfo,
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/not accepted/i);
  });

  it.each(["GET", "DELETE"])(
    "rejects public B2 credential headers on protocol-only %s requests",
    async (method) => {
      const response = await vercelMcpFetch(
        new Request("https://mcp.example.com/mcp", {
          method,
          headers: {
            host: "mcp.example.com",
            "X-B2-Key-Id": "public-id",
            "X-B2-Key": "public-secret",
          },
        }),
        validAuthInfo,
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/not accepted/i);
    },
  );

  it("fails closed when Vercel header credential mode is not explicitly enabled", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "headers";

    const response = await vercelHealthFetch(
      new Request("https://mcp.example.com/health", { headers: { host: "mcp.example.com" } }),
    );
    const body = (await response.json()) as { code: string; error: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe("configuration_error");
    expect(body.error).toMatch(/not configured/i);
  });

  it("requires a single allowed OAuth subject in server credential mode", async () => {
    delete process.env.B2_OAUTH_ALLOWED_SUBJECTS;

    const response = await vercelHealthFetch(
      new Request("https://mcp.example.com/health", { headers: { host: "mcp.example.com" } }),
    );
    const body = (await response.json()) as { code: string; error: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe("configuration_error");
    expect(body.error).toMatch(/not configured/i);
  });

  it("requires an allowed OAuth subject even when shared server credentials are enabled", async () => {
    delete process.env.B2_OAUTH_ALLOWED_SUBJECTS;
    process.env.B2_VERCEL_ALLOW_SHARED_SERVER_CREDENTIAL = "true";

    const response = await vercelHealthFetch(
      new Request("https://mcp.example.com/health", { headers: { host: "mcp.example.com" } }),
    );
    const body = (await response.json()) as { code: string; error: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe("configuration_error");
    expect(body.error).toMatch(/not configured/i);
  });

  it("allows multiple OAuth subjects only with the shared server credential override", async () => {
    process.env.B2_OAUTH_ALLOWED_SUBJECTS = "subject,other-subject";
    process.env.B2_VERCEL_ALLOW_SHARED_SERVER_CREDENTIAL = "true";

    const response = await vercelHealthFetch(
      new Request("https://mcp.example.com/health", { headers: { host: "mcp.example.com" } }),
    );

    expect(response.status).toBe(200);
  });

  it.each([
    "B2_APPLICATION_KEY",
    "B2_APPLICATION_KEY_ID",
    "B2_APP_KEY",
    "B2_APP_KEY_ID",
    "B2_MASTER_KEY",
    "B2_MASTER_KEY_ID",
    "B2_CREDENTIAL_TENANT_A_APPLICATION_KEY",
    "B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID",
    "B2_CREDENTIAL_TENANT_A_APP_KEY",
    "B2_CREDENTIAL_TENANT_A_APP_KEY_ID",
    "B2_CREDENTIAL_TENANT_A_MASTER_KEY",
    "B2_CREDENTIAL_TENANT_A_MASTER_KEY_ID",
  ])("rejects preview credential env material %s without the explicit override", async (name) => {
    delete process.env.B2_APPLICATION_KEY_ID;
    delete process.env.B2_APPLICATION_KEY;
    process.env.VERCEL_ENV = "preview";
    process.env[name] = "credential-material";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const response = await vercelHealthFetch(
      new Request("https://mcp.example.com/health", { headers: { host: "mcp.example.com" } }),
    );
    const body = (await response.json()) as { code: string; error: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe("configuration_error");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.stringContaining("Preview B2 credentials require"),
      }),
      "vercel.config.invalid",
    );
  });
});
