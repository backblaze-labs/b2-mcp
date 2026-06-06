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
    transport: { close() {}, sessionId: "x", async handlePostMessage() {} },
    mcpServer: { async close() {} },
    lastActivity: Date.now(),
    rateKey,
  };
}

let handle: HttpServerHandle;
let port: number;

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

describe("HTTP handler", () => {
  it("returns 401 on /sse without credentials", async () => {
    const res = await request(port, "GET", "/sse");
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

  it("returns 400 on /messages without a sessionId", async () => {
    const res = await request(port, "POST", "/messages", { body: "{}" });
    expect(res.status).toBe(400);
  });

  it("returns 404 on /messages for an unknown session", async () => {
    const res = await request(port, "POST", "/messages?sessionId=ghost", { body: "{}" });
    expect(res.status).toBe(404);
  });

  it("returns 413 when the request body exceeds the cap", async () => {
    handle.sessions.set("seed", fakeSession("rk"));
    const status = await postLargeBody(port, "/messages?sessionId=seed");
    expect(status).toBe(413);
  });

  it("returns 503 when total session capacity is reached", async () => {
    for (let i = 0; i < 1000; i++) handle.sessions.set(`s${i}`, fakeSession(`rk${i}`));
    const res = await request(port, "GET", "/sse", { headers: creds });
    expect(res.status).toBe(503);
  });

  it("returns 429 when per-key session capacity is reached", async () => {
    const rk = deriveRateKey("key-abc");
    for (let i = 0; i < 20; i++) handle.sessions.set(`k${i}`, fakeSession(rk));
    const res = await request(port, "GET", "/sse", { headers: creds });
    expect(res.status).toBe(429);
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

describe("deriveRateKey", () => {
  it("is deterministic and distinct per key id", () => {
    expect(deriveRateKey("abc")).toBe(deriveRateKey("abc"));
    expect(deriveRateKey("abc")).not.toBe(deriveRateKey("abd"));
    // Not a raw prefix of the input.
    expect(deriveRateKey("abcdefgh")).not.toContain("abcdefgh");
  });
});
