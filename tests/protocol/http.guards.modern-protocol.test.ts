/**
 * Transport-guard coverage for the modern HTTP entry point (#52 items 12, 14, 15):
 * capacity/abuse guards (unsafe Origin, oversized body, in-flight caps),
 * modern request cancellation reaching the handler abort signal, and
 * `subscriptions/listen` unavailability when no list-change capability is advertised.
 * Deterministic, no live B2 calls (SDK simulator transport only).
 */

import { buildHttpServer, type HttpServerHandle } from "../../src/http-server";
import { invalidateAuthManagerCache } from "../../src/server";
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";
import {
  JSON_HEADERS,
  closeHttpServer,
  creds,
  listenOnLocalhost,
  request,
  restoreEnv,
  saveEnv,
  setDefaultHttpTestEnv,
} from "../support/http";
import { modernBody, modernHeaders } from "./support/clients";
import { setB2SdkClientFactoryForTests } from "../support/sdk-factory-hook";
import { installSdkTransport } from "../support/sdk-test-helpers";

let handle: HttpServerHandle;
let port: number;

const savedEnv = saveEnv([
  "B2_REGISTER_ALL_TOOLS",
  "B2_HTTP_CREDENTIAL_MODE",
  "B2_MAX_SESSIONS",
  "B2_MAX_SESSIONS_PER_KEY",
]);

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const LIST_TOOLS = modernBody("tools/list");

function callToolBody(name: string, args: Record<string, unknown> = {}, id = 1): string {
  return modernBody("tools/call", { name, arguments: args }, id);
}

beforeAll(() => {
  setDefaultHttpTestEnv();
});

afterAll(() => {
  restoreEnv(savedEnv);
});

beforeEach(() => {
  const simulator = new B2Simulator({ minimumPartSize: 1024, recommendedPartSize: 1024 });
  installSdkTransport(simulator.transport());
  process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
  delete process.env.B2_APPLICATION_KEY_ID;
  delete process.env.B2_APPLICATION_KEY;
  delete process.env.B2_MAX_SESSIONS;
  delete process.env.B2_MAX_SESSIONS_PER_KEY;
});

afterEach(async () => {
  setB2SdkClientFactoryForTests(null);
  invalidateAuthManagerCache();
  if (handle) await closeHttpServer(handle);
});

async function startHandle(overrides = {}): Promise<void> {
  handle = buildHttpServer(overrides);
  port = await listenOnLocalhost(handle);
}

describe("HTTP transport guards (MCP 2026-07-28)", () => {
  it("rejects a request with a non-localhost Origin (DNS-rebinding guard)", async () => {
    await startHandle();
    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS, origin: "https://evil.example.com" },
      body: LIST_TOOLS,
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/host\/origin/i);
  });

  it("rejects a request body over the size cap with 413", async () => {
    await startHandle();
    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...JSON_HEADERS },
      body: "x".repeat(1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
  });

  it("returns 503 when the global in-flight cap is exhausted", async () => {
    process.env.B2_MAX_SESSIONS = "1";
    const entered = deferred<void>();
    const gate = deferred<void>();
    await startHandle({
      mcpHandler: {
        fetch: async () => {
          entered.resolve();
          await gate.promise;
          return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
        },
        close: () => undefined,
      },
    });

    const first = request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    await entered.promise; // first request now occupies the only in-flight slot

    const second = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
    });
    expect(second.status).toBe(503);
    expect(JSON.parse(second.body).error).toMatch(/in-flight/i);

    gate.resolve();
    await first;
  });

  it("makes subscriptions/listen unavailable (no list-change capability advertised)", async () => {
    await startHandle();
    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("subscriptions/listen") },
      body: modernBody("subscriptions/listen", {}),
    });
    const parsed = JSON.parse(res.body);
    expect(parsed.result).toBeUndefined();
    expect(parsed.error).toBeDefined();
    // Method not found (-32601) or invalid params (-32602): either way the
    // server does not establish a subscription without a list-change capability.
    expect([-32601, -32602]).toContain(parsed.error.code);
  });

  it("observes client cancellation on the handler abort signal without a late response", async () => {
    let sawAbort = false;
    const entered = deferred<void>();
    await startHandle({
      mcpHandler: {
        fetch: async (req: Request) => {
          entered.resolve();
          await new Promise<void>((resolve) => {
            if (req.signal.aborted) {
              sawAbort = true;
              resolve();
              return;
            }
            req.signal.addEventListener("abort", () => {
              sawAbort = true;
              resolve();
            });
          });
          // Client is gone; do not emit a late response frame.
          return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
        },
        close: () => undefined,
      },
    });

    const controller = new AbortController();
    const inflight = fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: LIST_TOOLS,
      signal: controller.signal,
    }).catch((err) => err);

    await entered.promise; // handler is now blocked awaiting the request signal
    controller.abort();

    const settled = await inflight;
    expect(settled).toBeInstanceOf(Error);
    await waitFor(() => sawAbort);
    expect(sawAbort).toBe(true);
  });

  it("returns 429 when the per-credential in-flight cap is exhausted", async () => {
    process.env.B2_MAX_SESSIONS_PER_KEY = "1";
    const entered = deferred<void>();
    const gate = deferred<void>();
    await startHandle({
      mcpHandler: {
        fetch: async () => {
          entered.resolve();
          await gate.promise;
          return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [] } });
        },
        close: () => undefined,
      },
    });

    const first = request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/call", "b2_list_buckets") },
      body: callToolBody("b2_list_buckets"),
    });
    await entered.promise; // first request holds the only per-credential slot

    const second = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/call", "b2_list_buckets") },
      body: callToolBody("b2_list_buckets"),
    });
    expect(second.status).toBe(429);
    expect(JSON.parse(second.body).error).toMatch(/credential/i);

    gate.resolve();
    await first;
  });

  it("rejects a JSON-RPC batch body", async () => {
    await startHandle();
    const res = await request(port, "POST", "/mcp", {
      headers: { ...creds, ...modernHeaders("tools/list") },
      body: JSON.stringify([JSON.parse(LIST_TOOLS), JSON.parse(LIST_TOOLS)]),
    });
    const parsed = JSON.parse(res.body);
    expect(res.status === 400 || parsed.error !== undefined).toBe(true);
    expect(parsed.result).toBeUndefined();
  });

  it("ignores malformed W3C trace context without rejecting the request", async () => {
    const captured: { traceparent?: string | null } = {};
    await startHandle({
      mcpHandler: {
        fetch: async (req: Request) => {
          captured.traceparent = req.headers.get("traceparent");
          return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
        },
        close: () => undefined,
      },
    });

    const res = await request(port, "POST", "/mcp", {
      headers: {
        ...creds,
        ...modernHeaders("tools/list"),
        traceparent: "not-a-valid-traceparent",
      },
      body: LIST_TOOLS,
    });

    expect(res.status).toBe(200);
    expect(captured.traceparent).toBe("not-a-valid-traceparent");
  });
});
