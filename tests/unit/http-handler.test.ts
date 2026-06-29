/**
 * Request-level tests for the HTTP transport. buildHttpServer() lets us listen
 * on an ephemeral port and exercise the handler branches that were previously
 * untested: auth rejection, malformed requests, body-size cap, and the
 * session/rate caps that protect the internet-facing server.
 */

import * as http from "http";
import type { AddressInfo } from "net";
import {
  buildHttpServer,
  configFromHeaders,
  deriveRateKey,
  HttpServerHandle,
} from "../../src/http-server";
import { getDestructivePolicy } from "../../src/utils/destructive-gate";

interface Resp {
  status: number;
  body: string;
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
        const done = () => resolve({ status, body: data });
        res.on("data", (c) => (data += c));
        // Resolve on end OR close — the server may reset the request socket
        // right after sending an early response (e.g. a 413).
        res.on("end", done);
        res.on("close", done);
      },
    );
    // The server may destroy the request socket after a 413; ignore that —
    // the response has already been flushed.
    req.on("error", () => undefined);
    const t = setTimeout(() => reject(new Error("request timed out")), 4000);
    t.unref();
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// Stream a large body and resolve as soon as the server sends response
// headers (it responds early with 413 and closes), stopping further writes.
function postLargeBody(port: number, pathname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: pathname }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on("error", () => undefined); // ignore the reset once we have the response
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

// Minimal stand-in for a Session — enough for cap checks and teardown.
function fakeSession(rateKey: string): any {
  return {
    transport: { close() {}, sessionId: "x", async handleRequest() {} },
    mcpServer: { async close() {} },
    lastActivity: Date.now(),
    rateKey,
  };
}

let handle: HttpServerHandle;
let port: number;

// These tests exercise transport mechanics, not capability filtering. Force
// full-surface registration so session creation never reaches the network to
// fetch the key's capabilities (which would be a real authorize call).
const savedRegisterAll = process.env.B2_REGISTER_ALL_TOOLS;
beforeAll(() => {
  process.env.B2_REGISTER_ALL_TOOLS = "true";
});
afterAll(() => {
  if (savedRegisterAll === undefined) delete process.env.B2_REGISTER_ALL_TOOLS;
  else process.env.B2_REGISTER_ALL_TOOLS = savedRegisterAll;
});

beforeEach(async () => {
  handle = buildHttpServer();
  await new Promise<void>((r) => handle.server.listen(0, "127.0.0.1", r));
  port = (handle.server.address() as AddressInfo).port;
});

afterEach(async () => {
  handle.drain();
  await new Promise<void>((r) => handle.server.close(() => r()));
});

const creds = { "x-b2-key-id": "key-abc", "x-b2-key": "secret-xyz" };
const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
});

describe("HTTP handler (Streamable HTTP)", () => {
  it("returns 401 on POST /mcp initialize without credentials", async () => {
    const res = await request(port, "POST", "/mcp", { headers: JSON_HEADERS, body: INIT });
    expect(res.status).toBe(401);
    expect(res.body).toMatch(/credentials/i);
  });

  it("returns 200 on /health", async () => {
    const res = await request(port, "GET", "/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("returns 404 on an unknown path", async () => {
    const res = await request(port, "GET", "/nope");
    expect(res.status).toBe(404);
  });

  it("rejects a non-localhost Host on /mcp when no allowlist is configured (DNS-rebinding default)", async () => {
    // No B2_ALLOWED_HOSTS/ORIGINS set in the test env → secure default: localhost only.
    const res = await request(port, "GET", "/mcp", { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/host\/origin/i);
  });

  it("returns 400 on POST /mcp with no session when the request is not an initialize", async () => {
    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 on GET /mcp for an unknown session", async () => {
    const res = await request(port, "GET", "/mcp", { headers: { "mcp-session-id": "ghost" } });
    expect(res.status).toBe(404);
  });

  it("returns 413 when the request body exceeds the cap", async () => {
    // The body cap fires during read, before session routing, on any POST /mcp.
    const status = await postLargeBody(port, "/mcp");
    expect(status).toBe(413);
  });

  it("returns 503 when total session capacity is reached", async () => {
    for (let i = 0; i < 1000; i++) handle.sessions.set(`s${i}`, fakeSession(`rk${i}`));
    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS },
      body: INIT,
    });
    expect(res.status).toBe(503);
  });

  it("returns 429 when per-key session capacity is reached", async () => {
    const rk = deriveRateKey("key-abc");
    for (let i = 0; i < 20; i++) handle.sessions.set(`k${i}`, fakeSession(rk));
    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS },
      body: INIT,
    });
    expect(res.status).toBe(429);
  });

  it("creates a session on POST /mcp initialize with valid credentials", async () => {
    // Drive a real initialize handshake (createServer → transport → connect). The
    // init response may be an open SSE stream, so resolve on response headers
    // (which already carry Mcp-Session-Id) and tear down.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/mcp",
          headers: { ...creds, ...JSON_HEADERS },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.destroy();
          req.destroy();
        },
      );
      req.on("error", () => undefined);
      const t = setTimeout(() => reject(new Error("init timeout")), 3000);
      t.unref();
      req.write(INIT);
      req.end();
    });
    expect(status).toBe(200);
    await new Promise((r) => setTimeout(r, 50)); // let onsessioninitialized fire
    expect(handle.sessions.size).toBeGreaterThanOrEqual(1);
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
    expect(configFromHeaders(baseReq)?.allowLocalFiles).toBe(false); // no root → still off
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
    expect(cfg?.appKeyId).toBe("app-id"); // S3 uses the application key
    expect(cfg?.masterKeyId).toBe("app-id"); // master falls back to the application key
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
    expect(cfg?.applicationKeyId).toBe("app-id"); // workhorse stays the app key
    expect(cfg?.masterKeyId).toBe("master-id"); // Partner/bz_* use the master key
    expect(cfg?.masterKey).toBe("master-secret");
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
    expect(cfg?.appKeyId).toBe("s3-id"); // legacy: S3 signs with the non-master override
    expect(cfg?.applicationKeyId).toBe("master-id");
  });
});

describe("deriveRateKey", () => {
  it("is deterministic and distinct per key id", () => {
    expect(deriveRateKey("abc")).toBe(deriveRateKey("abc"));
    expect(deriveRateKey("abc")).not.toBe(deriveRateKey("abd"));
    // Not a raw prefix of the input.
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
