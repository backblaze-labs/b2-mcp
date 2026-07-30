/**
 * Request-level tests for the HTTP entry point. Production HTTP serving is the
 * SDK v2 per-request handler, so these tests use the 2026-07-28 envelope and
 * assert that no MCP session state or Mcp-Session-Id is required.
 */

import * as http from "http";
import type { AddressInfo } from "net";
import axios from "axios";
import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  buildHttpServer,
  configFromHeaders,
  createInFlightLimiter,
  deriveRateKey,
  headersFromNode,
  HttpServerHandle,
  toWebRequest,
} from "../../src/http-server";
import { invalidateAuthManagerCache } from "../../src/server";
import { getDestructivePolicy } from "../../src/utils/destructive-gate";

jest.mock("axios");
const mockedAxios = axios as jest.MockedFunction<typeof axios> & {
  get: jest.MockedFunction<typeof axios.get>;
};

interface Resp {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function request(
  port: number,
  method: string,
  pathname: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: pathname, headers: opts.headers },
      (res) => {
        let data = "";
        const status = res.statusCode ?? 0;
        const done = () => resolve({ status, body: data, headers: res.headers });
        res.on("data", (c) => (data += c));
        res.on("end", done);
        res.on("close", done);
      },
    );
    req.on("error", () => undefined);
    const t = setTimeout(() => reject(new Error("request timed out")), 4000);
    t.unref();
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function postLargeBody(port: number, pathname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: pathname }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on("error", () => undefined);
    const t = setTimeout(() => reject(new Error("request timed out")), 4000);
    t.unref();
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    let sent = 0;
    let responded = false;
    req.on("response", () => (responded = true));
    function pump() {
      if (responded) return;
      while (sent < 4 * 1024 * 1024) {
        sent += chunk.length;
        if (!req.write(chunk)) {
          req.once("drain", pump);
          return;
        }
      }
      req.end();
    }
    pump();
  });
}

let handle: HttpServerHandle;
let port: number;

const savedRegisterAll = process.env.B2_REGISTER_ALL_TOOLS;
const savedCredentialMode = process.env.B2_HTTP_CREDENTIAL_MODE;

beforeAll(() => {
  process.env.B2_REGISTER_ALL_TOOLS = "true";
  process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
});

afterAll(() => {
  if (savedRegisterAll === undefined) delete process.env.B2_REGISTER_ALL_TOOLS;
  else process.env.B2_REGISTER_ALL_TOOLS = savedRegisterAll;
  if (savedCredentialMode === undefined) delete process.env.B2_HTTP_CREDENTIAL_MODE;
  else process.env.B2_HTTP_CREDENTIAL_MODE = savedCredentialMode;
});

beforeEach(async () => {
  process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
  delete process.env.B2_APPLICATION_KEY_ID;
  delete process.env.B2_APPLICATION_KEY;
  delete process.env.B2_PRINCIPAL_CREDENTIAL_MAP;
  delete process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID;
  delete process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY;
  handle = buildHttpServer();
  await new Promise<void>((r) => handle.server.listen(0, "127.0.0.1", r));
  port = (handle.server.address() as AddressInfo).port;
});

afterEach(async () => {
  jest.clearAllMocks();
  mockedAxios.mockReset();
  mockedAxios.get = jest.fn() as jest.MockedFunction<typeof axios.get>;
  invalidateAuthManagerCache();
  handle.drain();
  await new Promise<void>((r) => handle.server.close(() => r()));
});

const creds = { "x-b2-key-id": "key-abc", "x-b2-key": "secret-xyz" };
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};
const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function modernBody(method: string, params: Record<string, unknown> = {}, id = 1): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: META },
  });
}

function modernHeaders(method: string, name?: string): Record<string, string> {
  return {
    ...JSON_HEADERS,
    "mcp-method": method,
    ...(name && { "mcp-name": name }),
  };
}

const LIST_TOOLS = modernBody("tools/list");
const LEGACY_INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
});

function callToolBody(name: string, args: Record<string, unknown> = {}, id = 1): string {
  return modernBody("tools/call", { name, arguments: args }, id);
}

function authData() {
  return {
    data: {
      accountId: "account-1",
      authorizationToken: "token-1",
      apiInfo: {
        storageApi: {
          apiUrl: "https://api.example",
          downloadUrl: "https://download.example",
          s3ApiUrl: "https://s3.example",
          recommendedPartSize: 100,
          absoluteMinimumPartSize: 100,
          allowed: { capabilities: ["listBuckets"] },
        },
      },
    },
  };
}

async function replaceHandle(getAuthInfo?: (req: any) => AuthInfo | null): Promise<void> {
  handle.drain();
  await new Promise<void>((r) => handle.server.close(() => r()));
  handle = buildHttpServer({ getAuthInfo });
  await new Promise<void>((r) => handle.server.listen(0, "127.0.0.1", r));
  port = (handle.server.address() as AddressInfo).port;
}

describe("HTTP handler (MCP 2026-07-28)", () => {
  it("returns 401 on modern /mcp without credentials", async () => {
    const res = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/list"),
      body: LIST_TOOLS,
    });
    expect(res.status).toBe(401);
    expect(res.body).toMatch(/credentials/i);
  });

  it("returns 200 on /health when default header mode needs no static B2 env", async () => {
    delete process.env.B2_HTTP_CREDENTIAL_MODE;
    await replaceHandle();
    const res = await request(port, "GET", "/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("returns 503 on /health when server mode is missing static credentials", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "server";
    await replaceHandle();
    const res = await request(port, "GET", "/health");
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).status).toBe("error");
  });

  it("fails startup on an invalid credential mode", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "session";
    handle.drain();
    await new Promise<void>((r) => handle.server.close(() => r()));
    expect(() => buildHttpServer()).toThrow(/invalid/i);
    process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
    handle = buildHttpServer();
    await new Promise<void>((r) => handle.server.listen(0, "127.0.0.1", r));
    port = (handle.server.address() as AddressInfo).port;
  });

  it("returns 404 on an unknown path", async () => {
    const res = await request(port, "GET", "/nope");
    expect(res.status).toBe(404);
  });

  it("rejects a non-localhost Host on /mcp when no allowlist is configured", async () => {
    const res = await request(port, "GET", "/mcp", { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/host\/origin/i);
  });

  it("serves legacy initialize through the stateless transition fallback", async () => {
    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS },
      body: LEGACY_INIT,
    });
    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
    expect(handle.sessions.size).toBe(0);
  });

  it("does not route Mcp-Session-Id requests to stateful session storage", async () => {
    const res = await request(port, "GET", "/mcp", {
      headers: { ...creds, "mcp-session-id": "ghost" },
    });
    expect(res.status).not.toBe(200);
    expect(handle.sessions.size).toBe(0);
  });

  it("returns 413 when the request body exceeds the cap", async () => {
    const status = await postLargeBody(port, "/mcp");
    expect(status).toBe(413);
  });

  it("serves a modern tools/list request without a session id", async () => {
    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
    expect(handle.sessions.size).toBe(0);
    expect(JSON.parse(res.body).result.tools.length).toBeGreaterThan(0);
  });

  it("defaults unset B2_HTTP_CREDENTIAL_MODE to header compatibility", async () => {
    delete process.env.B2_HTTP_CREDENTIAL_MODE;
    await replaceHandle();
    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    expect(res.status).toBe(200);
  });

  it("requires headers on every request in header compatibility mode", async () => {
    const ok = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    expect(ok.status).toBe(200);

    const missing = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/list"),
      body: LIST_TOOLS,
    });
    expect(missing.status).toBe(401);
  });

  it("does not forward B2 credential or Authorization headers to the SDK request", () => {
    const req = {
      method: "POST",
      url: "/mcp",
      headers: {
        ...creds,
        "x-b2-mcp-key-id": "key",
        "x-b2-mcp-key": "secret",
        "x-b2-mcp-app-key-id": "app-key",
        "x-b2-mcp-app-key": "app-secret",
        "x-b2-mcp-master-key-id": "master-key",
        "x-b2-mcp-master-key": "master-secret",
        authorization: "Bearer caller-token",
        "content-type": "application/json",
        accept: "application/json",
        "mcp-method": "tools/list",
      },
    } as unknown as http.IncomingMessage;

    const webReq = toWebRequest(req, LIST_TOOLS);
    expect(webReq.headers.get("content-type")).toBe("application/json");
    expect(webReq.headers.get("mcp-method")).toBe("tools/list");
    for (const name of [
      "x-b2-key-id",
      "x-b2-key",
      "x-b2-mcp-key-id",
      "x-b2-mcp-key",
      "x-b2-mcp-app-key-id",
      "x-b2-mcp-app-key",
      "x-b2-mcp-master-key-id",
      "x-b2-mcp-master-key",
      "authorization",
    ]) {
      expect(webReq.headers.has(name)).toBe(false);
    }
    expect(headersFromNode(req.headers).has("authorization")).toBe(false);
  });

  it("reuses a B2 auth manager across stateless requests for the same credential", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue(authData());
    mockedAxios.mockResolvedValue({ data: { buckets: [] } } as never);

    for (let i = 0; i < 2; i++) {
      const res = await request(port, "POST", "/mcp", {
        headers: { ...creds, ...modernHeaders("tools/call", "b2_list_buckets") },
        body: callToolBody("b2_list_buckets", {}, i + 1),
      });
      expect(res.status).toBe(200);
    }
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(mockedAxios).toHaveBeenCalledTimes(2);
  });

  it("does not reuse the B2 auth cache when a header secret changes", async () => {
    mockedAxios.get = jest.fn().mockResolvedValue(authData());
    mockedAxios.mockResolvedValue({ data: { buckets: [] } } as never);

    const first = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/call", "b2_list_buckets") },
      body: callToolBody("b2_list_buckets", {}, 1),
    });
    const second = await request(port, "POST", "/mcp", {
      headers: {
        "x-b2-key-id": creds["x-b2-key-id"],
        "x-b2-key": "different-secret",
        ...modernHeaders("tools/call", "b2_list_buckets"),
      },
      body: callToolBody("b2_list_buckets", {}, 2),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it("bounds in-flight requests globally and per credential", () => {
    const limiter = createInFlightLimiter(2, 1);
    expect(limiter.acquire("credential:a")).toEqual({ ok: true });
    expect(limiter.acquire("credential:a")).toMatchObject({ ok: false, status: 429 });
    expect(limiter.acquire("credential:b")).toEqual({ ok: true });
    expect(limiter.acquire("credential:c")).toMatchObject({ ok: false, status: 503 });
    limiter.release("credential:a");
    expect(limiter.acquire("credential:c")).toEqual({ ok: true });
  });

  it("server mode uses process credentials and rejects public B2 credential headers", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "server";
    process.env.B2_APPLICATION_KEY_ID = "server-key";
    process.env.B2_APPLICATION_KEY = "server-secret";
    await replaceHandle();

    const spoofed = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    expect(spoofed.status).toBe(400);
    expect(spoofed.body).not.toContain("server-secret");

    const ok = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/list"),
      body: LIST_TOOLS,
    });
    expect(ok.status).toBe(200);
  });

  it("principal mode supports broker injection and rejects B2 header spoofing", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "principal";
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({ alice: "tenant_a" });
    await replaceHandle(() => ({
      token: "verified-token",
      clientId: "client-a",
      scopes: [],
      extra: { sub: "alice" },
    }));
    handle.drain();
    await new Promise<void>((r) => handle.server.close(() => r()));
    handle = buildHttpServer({
      getAuthInfo: () => ({
        token: "verified-token",
        clientId: "client-a",
        scopes: [],
        extra: { sub: "alice" },
      }),
      secretBroker: {
        resolve: (ref) =>
          ref === "tenant_a"
            ? { applicationKeyId: "tenant-key", applicationKey: "tenant-secret" }
            : null,
      },
    });
    await new Promise<void>((r) => handle.server.listen(0, "127.0.0.1", r));
    port = (handle.server.address() as AddressInfo).port;

    const spoofed = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    expect(spoofed.status).toBe(400);

    const ok = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/list"),
      body: LIST_TOOLS,
    });
    expect(ok.status).toBe(200);
  });

  it("principal mode requires verified authInfo", async () => {
    process.env.B2_HTTP_CREDENTIAL_MODE = "principal";
    process.env.B2_PRINCIPAL_CREDENTIAL_MAP = JSON.stringify({ alice: "tenant_a" });
    process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY_ID = "tenant-key";
    process.env.B2_CREDENTIAL_TENANT_A_APPLICATION_KEY = "tenant-secret";
    await replaceHandle();

    const missingAuth = await request(port, "POST", "/mcp", {
      headers: modernHeaders("tools/list"),
      body: LIST_TOOLS,
    });
    expect(missingAuth.status).toBe(401);
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

describe("configFromHeaders — destructive policy default (HTTP is safe-by-default)", () => {
  const saved = process.env.B2_DESTRUCTIVE_POLICY;
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
