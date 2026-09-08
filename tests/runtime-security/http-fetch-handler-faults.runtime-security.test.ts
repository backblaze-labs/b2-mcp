/**
 * Runtime-security fault-path coverage for the runtime-neutral HTTP fetch
 * handler (issue #400).
 *
 * These cases drive `createB2McpFetchHandler` directly with crafted Web
 * `Request` objects and a stubbed MCP handler so the security-sensitive error
 * branches — rate-limit rejection, credential-resolution failures, non-POST
 * preflight, Host/Origin edge cases, and the body cap — are exercised
 * deterministically without a network listener or real B2 credentials.
 */

import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  type CredentialProvider,
  type CredentialResolution,
  CredentialResolutionError,
} from "../../src/credentials";
import { type B2McpFetchHandler, createB2McpFetchHandler } from "../../src/http-fetch-handler";
import { MAX_MCP_BODY_BYTES } from "../../src/utils/http-body-limit";
import { logger } from "../../src/utils/logger";
import { _resetRateLimiter } from "../../src/utils/rate-limiter";

const ISSUE = "issue-400-http-fetch-handler-faults";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

function modernBody(method: string, params: Record<string, unknown> = {}, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } });
}

function modernHeaders(method: string, name?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(name && { "mcp-name": name }),
  };
}

function okMcpHandler() {
  return {
    fetch: vi.fn(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
    close: vi.fn(),
  };
}

function resolution(cacheKey = "credential:fixed"): CredentialResolution {
  return {
    config: {} as CredentialResolution["config"],
    cacheKey,
    capabilityCacheKey: `capability:${cacheKey}`,
  };
}

/** Provider that always resolves to a fixed credential handle. */
function fixedProvider(cacheKey = "credential:fixed"): CredentialProvider {
  return {
    name: "test-fixed",
    resolve: () => resolution(cacheKey),
    validateConfiguration: () => undefined,
  };
}

/** Provider whose resolve() throws the supplied error. */
function throwingProvider(err: unknown, name = "test-throwing"): CredentialProvider {
  return {
    name,
    resolve: () => {
      throw err;
    },
    validateConfiguration: () => undefined,
  };
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { host: "localhost", ...headers },
    body,
  });
}

let handler: B2McpFetchHandler | null = null;
const savedEnv = { ...process.env };

function build(options: Parameters<typeof createB2McpFetchHandler>[0] = {}): B2McpFetchHandler {
  handler = createB2McpFetchHandler({
    idleSweepMode: "request",
    mcpHandler: okMcpHandler(),
    fetchCapabilities: async () => null,
    ...options,
  });
  return handler;
}

beforeEach(() => {
  process.env = { ...savedEnv, NODE_ENV: "test" };
  delete process.env.B2_ALLOWED_HOSTS;
  delete process.env.B2_ALLOWED_ORIGINS;
  _resetRateLimiter();
});

afterEach(async () => {
  if (handler) {
    await handler.close();
    handler = null;
  }
  _resetRateLimiter();
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
});

describe(`HTTP fetch handler fault paths (#400)`, () => {
  it("rejects a non-POST/GET/DELETE method with 405 and an Allow header", async () => {
    const h = build({ credentialProvider: fixedProvider() });
    const res = await h.fetch(
      new Request("http://localhost/mcp", { method: "PUT", headers: { host: "localhost" } }),
    );
    expect(res.status, `${ISSUE}: unsupported method must be 405`).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST, DELETE");
  });

  it("returns 413 when the POST body exceeds the 1 MiB cap", async () => {
    const h = build({ credentialProvider: fixedProvider() });
    const res = await h.fetch(
      post("x".repeat(MAX_MCP_BODY_BYTES + 1), modernHeaders("tools/list")),
    );
    expect(res.status, `${ISSUE}: oversized body must return 413`).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
  });

  it("routes an empty POST body through to the MCP handler with the contracted 200 envelope", async () => {
    const mcpHandler = okMcpHandler();
    const h = build({ credentialProvider: fixedProvider(), mcpHandler });
    // The `/mcp` POST body is an untrusted-input boundary: an empty body is a
    // valid empty JSON-RPC parse and must reach the handler with the exact
    // contracted 200 + JSON-RPC envelope — not a partial/unauthenticated 2xx,
    // redirect, or error. Pinning the status and shape (rather than only
    // "not 413/500") makes a future malformed-input regression fail here.
    const res = await h.fetch(post("", modernHeaders("tools/list")));
    expect(res.status, `${ISSUE}: empty body must yield the contracted 200`).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body).toMatchObject({ jsonrpc: "2.0" });
    expect(
      mcpHandler.fetch,
      `${ISSUE}: empty body must reach the MCP handler`,
    ).toHaveBeenCalledTimes(1);
  });

  it("still enforces credential resolution on a malformed JSON body (no unauthenticated bypass)", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const mcpHandler = okMcpHandler();
    const err = new CredentialResolutionError("nope", 401, "capability_auth_failed");
    const h = build({ credentialProvider: throwingProvider(err), mcpHandler });
    // A malformed (unparseable) body must not skip the credential trust
    // boundary or reach the MCP handler with an unexpected 2xx. An unparseable
    // body cannot carry a JSON-RPC id, so the failure surfaces through the plain
    // credential-error envelope at the resolver's status — pin that exact shape.
    const res = await h.fetch(post("{ not json", modernHeaders("tools/list")));
    expect(res.status, `${ISSUE}: malformed body must not bypass credential resolution`).toBe(401);
    const body = JSON.parse(await res.text());
    expect(body).toEqual({ error: "nope" });
    expect(
      mcpHandler.fetch,
      `${ISSUE}: malformed body must not reach the MCP handler`,
    ).not.toHaveBeenCalled();
  });

  it("returns a typed JSON-RPC error status when credential resolution fails", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const err = new CredentialResolutionError("nope", 401, "capability_auth_failed");
    const h = build({ credentialProvider: throwingProvider(err) });
    const res = await h.fetch(post(modernBody("tools/list"), modernHeaders("tools/list")));
    expect(res.status, `${ISSUE}: typed credential error must surface its status`).toBe(401);
    const body = JSON.parse(await res.text());
    expect(body.error.data).toMatchObject({ code: "capability_auth_failed", status: 401 });
    expect(warn.mock.calls.some(([, event]) => event === "credential.resolve.failed")).toBe(true);
  });

  it("returns a generic 500 when credential resolution throws a non-typed error", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const h = build({ credentialProvider: throwingProvider(new Error("boom")) });
    const res = await h.fetch(post(modernBody("tools/list"), modernHeaders("tools/list")));
    expect(res.status, `${ISSUE}: non-typed credential error must be 500`).toBe(500);
    const body = JSON.parse(await res.text());
    expect(body.error.message).toBe("Credential resolution failed");
    expect(body.error.data).toBeUndefined();
  });

  it("labels the principal from subject/issuer and principal auth-info shapes on failure", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const h = build({ credentialProvider: throwingProvider(new Error("boom")) });

    await h.fetch(post(modernBody("tools/list"), modernHeaders("tools/list")), {
      authInfo: {
        token: "t",
        clientId: "c",
        scopes: [],
        extra: { subject: "subj", issuer: "iss" },
      } as AuthInfo,
    });
    await h.fetch(post(modernBody("tools/list"), modernHeaders("tools/list")), {
      authInfo: { token: "t", clientId: "c", scopes: [], extra: { principal: "pr" } } as AuthInfo,
    });

    const failures = warn.mock.calls.filter(([, event]) => event === "credential.resolve.failed");
    expect(failures.length, `${ISSUE}: both principal shapes should log a failure`).toBe(2);
    for (const [fields] of failures) {
      expect((fields as Record<string, unknown>).principal).toBeTruthy();
    }
  });

  it("enters discovery mode on missing credentials and rate-limits repeated discovery", async () => {
    process.env.B2_MCP_RATE_LIMIT_RPS = "1";
    process.env.B2_MCP_RATE_LIMIT_BURST = "1";
    _resetRateLimiter();
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const err = new CredentialResolutionError("no creds", 401, "missing_credentials");
    const h = build({ credentialProvider: throwingProvider(err) });

    const first = await h.fetch(post(modernBody("tools/list"), modernHeaders("tools/list")), {
      remoteAddress: "203.0.113.1",
    });
    const second = await h.fetch(post(modernBody("tools/list"), modernHeaders("tools/list")), {
      remoteAddress: "203.0.113.2",
    });

    expect(first.status, `${ISSUE}: first discovery request should be served`).toBe(200);
    expect(second.status, `${ISSUE}: shared discovery key must rate-limit`).toBe(429);
    expect(info.mock.calls.some(([, event]) => event === "credential.discovery_mode")).toBe(true);
  });

  it("rate-limits repeated requests for the same resolved credential key", async () => {
    process.env.B2_MCP_RATE_LIMIT_RPS = "1";
    process.env.B2_MCP_RATE_LIMIT_BURST = "1";
    _resetRateLimiter();
    const h = build({ credentialProvider: fixedProvider("credential:shared") });

    const first = await h.fetch(post(modernBody("tools/list"), modernHeaders("tools/list")), {
      remoteAddress: "198.51.100.1",
    });
    const second = await h.fetch(post(modernBody("tools/list"), modernHeaders("tools/list")), {
      remoteAddress: "198.51.100.2",
    });

    expect(first.status, `${ISSUE}: first credential request is served`).toBe(200);
    expect(second.status, `${ISSUE}: exhausted credential bucket must return 429`).toBe(429);
  });

  it.each([
    {
      name: "no host header rejected",
      env: {},
      headers: {} as Record<string, string>,
      noHost: true,
      expected: 403,
    },
    {
      name: "bare IPv6 loopback host allowed in localhost mode",
      env: {},
      headers: { host: "::1" },
      expected: 200,
    },
    {
      name: "malformed origin rejected in localhost mode",
      env: {},
      headers: { host: "localhost", origin: "http://[bad" },
      expected: 403,
    },
    {
      name: "bracketed IPv6 host without matching port rejected",
      env: { B2_ALLOWED_HOSTS: "[::1]:8080" },
      headers: { host: "[::1]" },
      expected: 403,
    },
    {
      name: "host+port allowlist match with origin port allowed",
      env: { B2_ALLOWED_HOSTS: "mcp.example.com:8443" },
      headers: { host: "mcp.example.com:8443", origin: "https://mcp.example.com:8443" },
      expected: 200,
    },
    {
      name: "malformed origin under host allowlist rejected",
      env: { B2_ALLOWED_HOSTS: "mcp.example.com" },
      headers: { host: "mcp.example.com", origin: "::::" },
      expected: 403,
    },
    {
      name: "empty-hostname origin under host allowlist rejected",
      env: { B2_ALLOWED_HOSTS: "mcp.example.com" },
      headers: { host: "mcp.example.com", origin: "file:///etc/passwd" },
      expected: 403,
    },
  ])("host/origin policy: $name", async ({ env, headers, expected, noHost }) => {
    for (const [key, value] of Object.entries(env)) process.env[key] = value as string;
    const h = build({ credentialProvider: fixedProvider() });
    const requestHeaders = noHost ? {} : { host: "localhost", ...headers };
    const req = new Request("http://localhost/mcp", { method: "GET", headers: requestHeaders });
    const res = await h.fetch(req);
    expect(res.status, `${ISSUE}: host/origin case '${expected}'`).toBe(expected);
  });

  it("permits a loopback /health probe under a strict host allowlist", async () => {
    process.env.B2_ALLOWED_HOSTS = "mcp.example.com";
    const h = build({ credentialProvider: fixedProvider() });

    const req = new Request("http://localhost/health", {
      method: "GET",
      headers: { host: "localhost" },
    });
    const res = await h.fetch(req, {
      allowLoopbackHealthProbe: true,
      remoteAddress: "::1",
    });
    expect(res.status, `${ISSUE}: loopback health probe should pass strict host policy`).toBe(200);
    expect(JSON.parse(await res.text()).status).toBe("ok");
  });

  it("permits a loopback /health probe with a loopback Origin header", async () => {
    process.env.B2_ALLOWED_HOSTS = "mcp.example.com";
    const h = build({ credentialProvider: fixedProvider() });

    const req = new Request("http://localhost/health", {
      method: "GET",
      headers: { host: "127.0.0.1", origin: "http://localhost" },
    });
    const res = await h.fetch(req, {
      allowLoopbackHealthProbe: true,
      remoteAddress: "127.0.0.1",
    });
    expect(res.status).toBe(200);
  });

  it("rejects a health probe when the remote address is not loopback", async () => {
    process.env.B2_ALLOWED_HOSTS = "mcp.example.com";
    const h = build({ credentialProvider: fixedProvider() });

    const req = new Request("http://localhost/health", {
      method: "GET",
      headers: { host: "localhost" },
    });
    const res = await h.fetch(req, {
      allowLoopbackHealthProbe: true,
      // no remoteAddress -> isLoopbackRemoteAddress(undefined) is false
    });
    expect(res.status, `${ISSUE}: non-loopback health probe must fail closed`).toBe(403);
  });

  it("returns 503 while shutting down", async () => {
    const h = build({ credentialProvider: fixedProvider() });
    h.drain();
    const res = await h.fetch(post(modernBody("tools/list"), modernHeaders("tools/list")));
    expect(res.status, `${ISSUE}: draining server must refuse new work`).toBe(503);
  });

  it("returns 404 for unknown paths", async () => {
    const h = build({ credentialProvider: fixedProvider() });
    const res = await h.fetch(
      new Request("http://localhost/nope", { method: "GET", headers: { host: "localhost" } }),
    );
    expect(res.status).toBe(404);
  });
});
