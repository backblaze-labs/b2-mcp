/**
 * Unit tests for HTTP transport helpers.
 * Covers configFromHeaders parsing and getPort validation.
 */

import type { AuthInfo } from "@modelcontextprotocol/server";
import * as http from "http";
import type { AddressInfo } from "net";
import { ReadableStream, type ReadableStreamDefaultController } from "node:stream/web";
import {
  buildHttpServer,
  configFromHeaders,
  createInFlightLimiter,
  deriveRateKey,
  getPort,
  handleHttpBootstrapFatal,
  startHttp,
} from "../../src/http-server";
import { createB2McpFetchHandler } from "../../src/http-fetch-handler";
import {
  validateHttpCredentialConfiguration,
  type AuthenticatedIncomingMessage,
} from "../../src/credentials";
import { closeHttpServer, listenOnLocalhost, request } from "../support/http";
import { getDestructivePolicy } from "../../src/utils/destructive-gate";
import * as loggerModule from "../../src/utils/logger";
import { allowRequest, rateLimiterConfig, _resetRateLimiter } from "../../src/utils/rate-limiter";

type ShutdownSignal = "SIGTERM" | "SIGINT";

const { logger } = loggerModule;
const shutdownSignals: readonly ShutdownSignal[] = ["SIGTERM", "SIGINT"];

function signalListeners(signal: ShutdownSignal): NodeJS.SignalsListener[] {
  return process.listeners(signal) as NodeJS.SignalsListener[];
}

function snapshotSignalListeners(): Record<ShutdownSignal, Set<NodeJS.SignalsListener>> {
  return {
    SIGTERM: new Set(signalListeners("SIGTERM")),
    SIGINT: new Set(signalListeners("SIGINT")),
  };
}

function findNewSignalListener(
  signal: ShutdownSignal,
  snapshot: Record<ShutdownSignal, Set<NodeJS.SignalsListener>>,
): NodeJS.SignalsListener | undefined {
  return signalListeners(signal).find((listener) => !snapshot[signal].has(listener));
}

function newSignalListeners(
  signal: ShutdownSignal,
  snapshot: Record<ShutdownSignal, Set<NodeJS.SignalsListener>>,
): NodeJS.SignalsListener[] {
  return signalListeners(signal).filter((listener) => !snapshot[signal].has(listener));
}

function removeNewSignalListeners(
  snapshot: Record<ShutdownSignal, Set<NodeJS.SignalsListener>>,
): void {
  for (const signal of shutdownSignals) {
    for (const registeredListener of newSignalListeners(signal, snapshot)) {
      process.off(signal, registeredListener);
    }
  }
}

describe("configFromHeaders", () => {
  const baseEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.B2_REGION;
    delete process.env.B2_MCP_OUTPUT_FORMAT;
    delete process.env.B2_SECRET_SINK;
    delete process.env.B2_SECRET_SINK_FILE;
    delete process.env.B2_ALLOW_LOCAL_FILES;
  });
  afterAll(() => {
    process.env = baseEnv;
  });

  it("returns null when X-B2-Key-Id is missing", () => {
    const req = { headers: { "x-b2-key": "secret" } };
    expect(configFromHeaders(req)).toBeNull();
  });

  it("returns null when X-B2-Key is missing", () => {
    const req = { headers: { "x-b2-key-id": "id" } };
    expect(configFromHeaders(req)).toBeNull();
  });

  it("rejects conflicting duplicate credential header values", () => {
    const req = { headers: { "x-b2-key-id": ["a", "b"], "x-b2-key": "secret" } };
    expect(() => configFromHeaders(req)).toThrow(/conflicting/i);
  });

  it("refuses HTTP file secret sink configuration without explicit local-file opt-in", () => {
    process.env.B2_SECRET_SINK = "file";
    process.env.B2_SECRET_SINK_FILE = "/tmp/b2-mcp-secrets.jsonl";

    expect(() => validateHttpCredentialConfiguration()).toThrow(/B2_ALLOW_LOCAL_FILES=true/);
  });

  it("falls back to primary key when app key headers are absent", () => {
    const req = { headers: { "x-b2-key-id": "primary-id", "x-b2-key": "primary-secret" } };
    const config = configFromHeaders(req)!;
    expect(config.applicationKeyId).toBe("primary-id");
    expect(config.applicationKey).toBe("primary-secret");
    expect(config.appKeyId).toBe("primary-id");
    expect(config.appKey).toBe("primary-secret");
  });

  it("uses app key headers when provided", () => {
    const req = {
      headers: {
        "x-b2-key-id": "master-id",
        "x-b2-key": "master-secret",
        "x-b2-app-key-id": "app-id",
        "x-b2-app-key": "app-secret",
      },
    };
    const config = configFromHeaders(req)!;
    expect(config.applicationKeyId).toBe("master-id");
    expect(config.appKeyId).toBe("app-id");
    expect(config.appKey).toBe("app-secret");
  });

  it("defaults region when env var unset", () => {
    const req = { headers: { "x-b2-key-id": "id", "x-b2-key": "secret" } };
    const config = configFromHeaders(req)!;
    expect(config.region).toBe("us-west-004");
  });

  it("respects the B2_REGION env var", () => {
    process.env.B2_REGION = "eu-central-003";
    const req = { headers: { "x-b2-key-id": "id", "x-b2-key": "secret" } };
    const config = configFromHeaders(req)!;
    expect(config.region).toBe("eu-central-003");
  });

  it("defaults structured tool-result text output to compact JSON", () => {
    const req = { headers: { "x-b2-key-id": "id", "x-b2-key": "secret" } };
    expect(configFromHeaders(req)?.outputFormat).toBe("json");
  });

  it("honors TOON structured tool-result text output mode", () => {
    process.env.B2_MCP_OUTPUT_FORMAT = "toon";
    const req = { headers: { "x-b2-key-id": "id", "x-b2-key": "secret" } };
    expect(configFromHeaders(req)?.outputFormat).toBe("toon");
  });

  it("rejects unknown structured tool-result text output modes", () => {
    process.env.B2_MCP_OUTPUT_FORMAT = "yaml";
    const req = { headers: { "x-b2-key-id": "id", "x-b2-key": "secret" } };
    expect(() => configFromHeaders(req)).toThrow(/B2_MCP_OUTPUT_FORMAT/);
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
  it("is deterministic and distinct per non-secret cache key", () => {
    expect(deriveRateKey("abc")).toBe(deriveRateKey("abc"));
    expect(deriveRateKey("abc")).not.toBe(deriveRateKey("abd"));
    expect(deriveRateKey("abc")).toBe("rate:abc");
  });
});

describe("createInFlightLimiter", () => {
  it("bounds in-flight requests globally and per credential", () => {
    const limiter = createInFlightLimiter(2, 1);
    expect(limiter.acquire("credential:a")).toEqual({ ok: true });
    expect(limiter.acquire("credential:a")).toMatchObject({ ok: false, status: 429 });
    expect(limiter.acquire("credential:b")).toEqual({ ok: true });
    expect(limiter.acquire("credential:c")).toMatchObject({ ok: false, status: 503 });
    limiter.release("credential:a");
    expect(limiter.acquire("credential:c")).toEqual({ ok: true });
  });
});

describe("HTTP server lifecycle", () => {
  const encoder = new TextEncoder();

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("listens on an ephemeral localhost port and shuts down", async () => {
    const handle = buildHttpServer();
    const port = await listenOnLocalhost(handle);

    const res = await request(port, "GET", "/health");

    expect(res.status).toBe(200);
    await closeHttpServer(handle);
    expect(handle.server.listening).toBe(false);
  });

  it("schedules periodic cache sweeps and clears them on drain", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const previousTimerCount = setIntervalSpy.mock.results.length;

    const handle = buildHttpServer();
    const sweepTimer = setIntervalSpy.mock.results.at(-1)?.value;

    expect(setIntervalSpy.mock.results.length).toBe(previousTimerCount + 1);
    handle.drain();
    expect(clearIntervalSpy).toHaveBeenCalledWith(sweepTimer);
  });

  it("rejects startup when the requested HTTP port is already bound", async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const port = (blocker.address() as AddressInfo).port;
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const previousTimerCount = setIntervalSpy.mock.results.length;

    try {
      await expect(startHttp({ port })).rejects.toMatchObject({ code: "EADDRINUSE" });
      const startupTimers = setIntervalSpy.mock.results
        .slice(previousTimerCount)
        .map((result) => result.value);
      expect(startupTimers.length).toBeGreaterThan(0);
      expect(clearIntervalSpy).toHaveBeenCalledWith(startupTimers.at(-1));
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("drains startup resources when listen throws synchronously", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const previousTimerCount = setIntervalSpy.mock.results.length;

    await expect(startHttp({ port: 70_000 })).rejects.toThrow();
    const startupTimers = setIntervalSpy.mock.results
      .slice(previousTimerCount)
      .map((result) => result.value);
    expect(startupTimers.length).toBeGreaterThan(0);
    expect(clearIntervalSpy).toHaveBeenCalledWith(startupTimers.at(-1));
  });

  it("normalizes non-Error synchronous listen failures during startup", async () => {
    const listenSpy = vi.spyOn(http.Server.prototype, "listen").mockImplementation((() => {
      throw "raw listen failure";
    }) as typeof http.Server.prototype.listen);

    try {
      await expect(startHttp({ port: 3000 })).rejects.toThrow("raw listen failure");
    } finally {
      listenSpy.mockRestore();
    }
  });

  it("drains in-flight requests before closing the MCP handler", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const close = vi.fn(async () => undefined);
    const handle = buildHttpServer({
      idleSweepMode: "request",
      mcpHandler: {
        fetch: vi.fn(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(streamController) {
                  controller = streamController;
                  streamController.enqueue(encoder.encode("drained"));
                },
              }),
              { status: 200 },
            ),
        ),
        close,
      },
    });

    try {
      const port = await listenOnLocalhost(handle);
      const pending = request(port, "GET", "/mcp");
      await vi.waitFor(() => expect(controller).toBeDefined());

      handle.drain();
      expect(close).not.toHaveBeenCalled();
      const drainingRes = await request(port, "GET", "/health");
      expect(drainingRes.status).toBe(503);

      controller?.close();
      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.body).toBe("drained");
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    } finally {
      await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    }
  });

  it("passes verified authInfo from the hook into the MCP handler", async () => {
    const authInfo: AuthInfo = {
      token: "verified:test-token",
      clientId: "client-1",
      scopes: ["b2:read"],
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      resource: new URL("http://localhost/mcp"),
      extra: { sub: "subject-1" },
    };
    const getAuthInfo = vi.fn((req: AuthenticatedIncomingMessage) => {
      expect(req.auth).toBeUndefined();
      return authInfo;
    });
    const fetch = vi.fn(async (_req: Request, options?: { authInfo?: AuthInfo }) => {
      return new Response(JSON.stringify({ clientId: options?.authInfo?.clientId }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    });
    const handle = buildHttpServer({
      idleSweepMode: "request",
      getAuthInfo,
      mcpHandler: { fetch, close: vi.fn(async () => undefined) },
    });

    try {
      const port = await listenOnLocalhost(handle);
      const res = await request(port, "GET", "/mcp");

      expect(res.status).toBe(202);
      expect(JSON.parse(res.body)).toEqual({ clientId: "client-1" });
      expect(getAuthInfo).toHaveBeenCalledTimes(1);
      expect(getAuthInfo.mock.calls[0]?.[0].auth).toBe(authInfo);
      expect(fetch.mock.calls[0]?.[1]?.authInfo).toBe(authInfo);
    } finally {
      await closeHttpServer(handle);
    }
  });

  it("returns a sanitized 500 when the Node fetch pipeline throws", async () => {
    const pipelineError = new Error("pipeline failed with sk-test-secret");
    pipelineError.stack = "Error: pipeline failed with sk-test-secret\n    at secret-stack-frame";
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const handle = buildHttpServer({
      fetchHandler: {
        sessions: new Map<string, never>(),
        fetch: vi.fn(async () => {
          throw pipelineError;
        }),
        drain: vi.fn(),
        close: vi.fn(async () => undefined),
      },
    });

    try {
      const port = await listenOnLocalhost(handle);
      const res = await request(port, "GET", "/mcp");

      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: "Internal server error" });
      expect(res.body).not.toContain("sk-test-secret");
      expect(res.body).not.toContain("secret-stack-frame");
      expect(warnSpy).toHaveBeenCalledWith(
        { err: "pipeline failed with sk-test-secret" },
        "mcp.http.failed",
      );
    } finally {
      await closeHttpServer(handle);
    }
  });

  it("returns a sanitized 500 when the Node fetch pipeline rejects non-Error values", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const handle = buildHttpServer({
      fetchHandler: {
        sessions: new Map<string, never>(),
        fetch: vi.fn(() => Promise.reject("string failure with sk-test-secret")),
        drain: vi.fn(),
        close: vi.fn(async () => undefined),
      },
    });

    try {
      const port = await listenOnLocalhost(handle);
      const res = await request(port, "GET", "/mcp");

      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: "Internal server error" });
      expect(res.body).not.toContain("sk-test-secret");
      expect(warnSpy).toHaveBeenCalledWith(
        { err: "string failure with sk-test-secret" },
        "mcp.http.failed",
      );
    } finally {
      await closeHttpServer(handle);
    }
  });

  it.each(["SIGTERM", "SIGINT"] as const)("handles %s by draining and closing", async (signal) => {
    const signalSnapshot = snapshotSignalListeners();
    const exitCodes: Array<string | number | null | undefined> = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code) => {
      exitCodes.push(code);
      return undefined as never;
    }) as typeof process.exit);
    let listener: NodeJS.SignalsListener | undefined;

    try {
      await startHttp({ port: 0 });
      listener = findNewSignalListener(signal, signalSnapshot);
      expect(listener).toBeTypeOf("function");
      listener?.(signal);
      listener?.(signal);

      await vi.waitFor(() => expect(exitCodes).toContain(0));
      expect(newSignalListeners("SIGTERM", signalSnapshot)).toEqual([]);
      expect(newSignalListeners("SIGINT", signalSnapshot)).toEqual([]);
    } finally {
      if (listener && !exitCodes.includes(0)) {
        listener(signal);
        await vi.waitFor(() => expect(exitCodes).toContain(0)).catch(() => undefined);
      }
      removeNewSignalListeners(signalSnapshot);
      exitSpy.mockRestore();
    }
  });

  it("resolves PORT from the environment when no explicit port is provided", async () => {
    const savedPort = process.env.PORT;
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const port = (blocker.address() as AddressInfo).port;
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    process.env.PORT = String(port);
    const signalSnapshot = snapshotSignalListeners();
    const exitCodes: Array<string | number | null | undefined> = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code) => {
      exitCodes.push(code);
      return undefined as never;
    }) as typeof process.exit);
    let listener: NodeJS.SignalsListener | undefined;

    try {
      await startHttp();
      listener = findNewSignalListener("SIGTERM", signalSnapshot);
      expect(listener).toBeTypeOf("function");
      listener?.("SIGTERM");

      await vi.waitFor(() => expect(exitCodes).toContain(0));
    } finally {
      if (listener && !exitCodes.includes(0)) {
        listener("SIGTERM");
        await vi.waitFor(() => expect(exitCodes).toContain(0)).catch(() => undefined);
      }
      removeNewSignalListeners(signalSnapshot);
      exitSpy.mockRestore();
      if (savedPort === undefined) delete process.env.PORT;
      else process.env.PORT = savedPort;
    }
  });

  it("handles close callbacks that run before a drain timer is assigned", async () => {
    const signalSnapshot = snapshotSignalListeners();
    const flushSpy = vi.spyOn(loggerModule, "flushLogsSync").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const originalListen = http.Server.prototype.listen;
    let startedServer: http.Server | undefined;
    const listenSpy = vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (
      this: http.Server,
      ...args: unknown[]
    ) {
      startedServer = this;
      return Reflect.apply(originalListen, this, args) as http.Server;
    } as typeof http.Server.prototype.listen);
    let closeSpy: ReturnType<typeof vi.spyOn> | undefined;

    try {
      await startHttp({ port: 0 });
      listenSpy.mockRestore();
      expect(startedServer).toBeDefined();
      const server = startedServer as http.Server;
      closeSpy = vi.spyOn(server, "close").mockImplementation(function (
        this: http.Server,
        callback?: (err?: Error) => void,
      ) {
        callback?.();
        return this;
      } as typeof server.close);
      const listener = findNewSignalListener("SIGTERM", signalSnapshot);
      expect(listener).toBeTypeOf("function");

      expect(() => listener?.("SIGTERM")).toThrow("process.exit(0)");
      expect(flushSpy).toHaveBeenCalledTimes(1);
      expect(newSignalListeners("SIGTERM", signalSnapshot)).toEqual([]);
      expect(newSignalListeners("SIGINT", signalSnapshot)).toEqual([]);
    } finally {
      closeSpy?.mockRestore();
      listenSpy.mockRestore();
      if (startedServer?.listening) {
        await new Promise<void>((resolve) => startedServer?.close(() => resolve()));
      }
      removeNewSignalListeners(signalSnapshot);
    }
  });

  it("exits non-zero when graceful shutdown exceeds the drain timeout", async () => {
    const signalSnapshot = snapshotSignalListeners();
    const exitCodes: Array<string | number | null | undefined> = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code) => {
      exitCodes.push(code);
      return undefined as never;
    }) as typeof process.exit);
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const flushSpy = vi.spyOn(loggerModule, "flushLogsSync").mockImplementation(() => undefined);
    const originalListen = http.Server.prototype.listen;
    let startedServer: http.Server | undefined;
    const listenSpy = vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (
      this: http.Server,
      ...args: unknown[]
    ) {
      startedServer = this;
      return Reflect.apply(originalListen, this, args) as http.Server;
    } as typeof http.Server.prototype.listen);
    let signalListener: NodeJS.SignalsListener | undefined;
    let closeSpy: ReturnType<typeof vi.spyOn> | undefined;

    try {
      await startHttp({ port: 0 });
      listenSpy.mockRestore();
      expect(startedServer).toBeDefined();
      const server = startedServer as http.Server;
      signalListener = findNewSignalListener("SIGTERM", signalSnapshot);
      expect(signalListener).toBeTypeOf("function");
      closeSpy = vi.spyOn(server, "close").mockImplementation(function (this: http.Server) {
        return this;
      } as typeof server.close);

      vi.useFakeTimers();
      signalListener?.("SIGTERM");
      await vi.advanceTimersByTimeAsync(10_000);

      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(loggerError).toHaveBeenCalledWith("server.drainTimeout");
      expect(flushSpy).toHaveBeenCalledTimes(1);
      expect(exitCodes).toContain(1);
      expect(newSignalListeners("SIGTERM", signalSnapshot)).toEqual([]);
      expect(newSignalListeners("SIGINT", signalSnapshot)).toEqual([]);
    } finally {
      vi.useRealTimers();
      closeSpy?.mockRestore();
      listenSpy.mockRestore();
      if (startedServer?.listening) {
        await new Promise<void>((resolve) => startedServer?.close(() => resolve()));
      }
      removeNewSignalListeners(signalSnapshot);
      exitSpy.mockRestore();
    }
  });

  it("logs runtime server errors before shutting down", async () => {
    const signalSnapshot = snapshotSignalListeners();
    const exitCodes: Array<string | number | null | undefined> = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code) => {
      exitCodes.push(code);
      return undefined as never;
    }) as typeof process.exit);
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const serverOn = vi.spyOn(http.Server.prototype, "on");
    let signalListener: NodeJS.SignalsListener | undefined;

    try {
      await startHttp({ port: 0 });
      signalListener = findNewSignalListener("SIGTERM", signalSnapshot);
      const serverOnCalls = serverOn.mock.calls as Array<[string | symbol, unknown, ...unknown[]]>;
      const runtimeErrorListener = serverOnCalls
        .filter(([event]) => event === "error")
        .at(-1)?.[1] as ((err: Error) => void) | undefined;

      expect(runtimeErrorListener).toBeTypeOf("function");
      runtimeErrorListener?.(new Error("runtime socket failed"));

      await vi.waitFor(() => expect(exitCodes).toContain(0));
      expect(loggerError).toHaveBeenCalledWith({ err: "runtime socket failed" }, "server.error");
      expect(newSignalListeners("SIGTERM", signalSnapshot)).toEqual([]);
      expect(newSignalListeners("SIGINT", signalSnapshot)).toEqual([]);
    } finally {
      if (signalListener && !exitCodes.includes(0)) {
        signalListener("SIGTERM");
        await vi.waitFor(() => expect(exitCodes).toContain(0)).catch(() => undefined);
      }
      removeNewSignalListeners(signalSnapshot);
      exitSpy.mockRestore();
    }
  });

  it("logs and exits from the HTTP bootstrap fatal handler", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const loggerFatal = vi.spyOn(logger, "fatal").mockImplementation(() => undefined);
    const flushSpy = vi.spyOn(loggerModule, "flushLogsSync").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);

    expect(() => handleHttpBootstrapFatal(new Error("fatal startup failed"))).toThrow(
      "process.exit(1)",
    );
    expect(stderr).toHaveBeenCalledWith("b2-mcp: fatal startup failed\n");
    expect(loggerFatal).toHaveBeenCalledWith({ err: "fatal startup failed" }, "server.fatal");
    expect(flushSpy).toHaveBeenCalledTimes(1);

    expect(() => handleHttpBootstrapFatal("fatal startup string")).toThrow("process.exit(1)");
    expect(stderr).toHaveBeenCalledWith("b2-mcp: fatal startup string\n");
    expect(loggerFatal).toHaveBeenCalledWith({ err: "fatal startup string" }, "server.fatal");
    expect(flushSpy).toHaveBeenCalledTimes(2);
  });
});

describe("health and readiness endpoints", () => {
  beforeEach(() => {
    _resetRateLimiter();
  });

  afterEach(() => {
    _resetRateLimiter();
  });

  it("rejects disallowed Host before returning readiness metadata", async () => {
    const savedHosts = process.env.B2_ALLOWED_HOSTS;
    process.env.B2_ALLOWED_HOSTS = "mcp.example.com";
    const handle = buildHttpServer({
      credentialProvider: {
        name: "test-provider",
        validateConfiguration() {
          throw new Error("readiness should not be evaluated");
        },
        resolve() {
          throw new Error("resolve should not be called by readiness");
        },
      },
    });

    try {
      const port = await listenOnLocalhost(handle);
      const res = await request(port, "GET", "/ready", { headers: { host: "evil.example" } });

      expect(res.status).toBe(403);
      expect(res.body).toContain("Host/Origin not allowed");
      expect(res.body).not.toContain("version");
      expect(res.body).not.toContain("inFlightRequests");
    } finally {
      if (savedHosts === undefined) delete process.env.B2_ALLOWED_HOSTS;
      else process.env.B2_ALLOWED_HOSTS = savedHosts;
      await closeHttpServer(handle);
    }
  });

  it("allows loopback health probes when localhost is not in the host allowlist", async () => {
    const savedHosts = process.env.B2_ALLOWED_HOSTS;
    process.env.B2_ALLOWED_HOSTS = "mcp.example.com";
    const handle = buildHttpServer({
      credentialProvider: {
        name: "test-provider",
        validateConfiguration() {
          return undefined;
        },
        resolve() {
          throw new Error("resolve should not be called by readiness");
        },
      },
    });

    try {
      const port = await listenOnLocalhost(handle);

      for (const path of ["/health", "/ready"]) {
        const res = await request(port, "GET", path, {
          headers: { host: `localhost:${port}` },
        });

        expect(res.status).toBe(200);
        expect(res.body).not.toContain("Host/Origin not allowed");
      }
    } finally {
      if (savedHosts === undefined) delete process.env.B2_ALLOWED_HOSTS;
      else process.env.B2_ALLOWED_HOSTS = savedHosts;
      await closeHttpServer(handle);
    }
  });

  it("rejects missing Host headers outside the loopback health exception", async () => {
    const pipeline = createB2McpFetchHandler();

    try {
      const res = await pipeline.fetch(new Request("http://localhost/mcp"), {
        remoteAddress: "203.0.113.10",
      });
      const body = await res.text();

      expect(res.status).toBe(403);
      expect(body).toContain("Host/Origin not allowed");
    } finally {
      await pipeline.close();
    }
  });

  it("does not rate-limit health probes with the data-plane MCP bucket", async () => {
    const sourceRateKey = deriveRateKey("http:127.0.0.1");
    for (let index = 0; index < rateLimiterConfig.burst; index += 1) {
      expect(allowRequest(sourceRateKey)).toBe(true);
    }
    expect(allowRequest(sourceRateKey)).toBe(false);

    const handle = buildHttpServer({
      credentialProvider: {
        name: "test-provider",
        validateConfiguration() {
          return undefined;
        },
        resolve() {
          throw new Error("resolve should not be called by readiness");
        },
      },
    });

    try {
      const port = await listenOnLocalhost(handle);
      const res = await request(port, "GET", "/ready");

      expect(res.status).toBe(200);
    } finally {
      await closeHttpServer(handle);
    }
  });

  it("exposes internal readiness metadata without resolving B2 credentials", async () => {
    let validated = 0;
    let resolved = 0;
    const handle = buildHttpServer({
      credentialProvider: {
        name: "test-provider",
        validateConfiguration() {
          validated++;
        },
        resolve() {
          resolved++;
          throw new Error("resolve should not be called by readiness");
        },
      },
    });

    try {
      const port = await listenOnLocalhost(handle);
      const res = await request(port, "GET", "/ready");
      const body = JSON.parse(res.body);

      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        status: "ok",
        server: "backblaze-b2-mcp",
        activeSessions: 0,
        inFlightRequests: 0,
        openSubscriptions: 0,
      });
      expect(typeof body.version).toBe("string");
      expect(validated).toBe(1);
      expect(resolved).toBe(0);
    } finally {
      await closeHttpServer(handle);
    }
  });

  it("reports not-ready when configuration validation fails", async () => {
    const handle = buildHttpServer({
      credentialProvider: {
        name: "test-provider",
        validateConfiguration() {
          throw new Error("invalid test config");
        },
        resolve() {
          throw new Error("resolve should not be called by readiness");
        },
      },
    });

    try {
      const port = await listenOnLocalhost(handle);
      const res = await request(port, "GET", "/ready");
      const body = JSON.parse(res.body);

      expect(res.status).toBe(503);
      expect(body).toMatchObject({
        status: "error",
        error: "Credential configuration invalid",
        inFlightRequests: 0,
        openSubscriptions: 0,
      });
    } finally {
      await closeHttpServer(handle);
    }
  });
});

describe("configFromHeaders — destructive policy default (HTTP is safe-by-default)", () => {
  const saved = process.env.B2_DESTRUCTIVE_POLICY;
  const creds = { "x-b2-key-id": "key-abc", "x-b2-key": "secret-xyz" };

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

describe("getPort", () => {
  const baseArgv = process.argv.slice();
  const baseEnv = { ...process.env };
  beforeEach(() => {
    process.argv = baseArgv.slice();
    delete process.env.PORT;
  });
  afterAll(() => {
    process.argv = baseArgv;
    process.env = baseEnv;
  });

  it("defaults to 3000 when no --port or PORT env", () => {
    expect(getPort()).toBe(3000);
  });

  it("uses --port arg", () => {
    process.argv.push("--port", "8080");
    expect(getPort()).toBe(8080);
  });

  it("uses PORT env when --port absent", () => {
    process.env.PORT = "4000";
    expect(getPort()).toBe(4000);
  });

  it("throws on non-numeric port", () => {
    process.argv.push("--port", "abc");
    expect(() => getPort()).toThrow(/Invalid port/);
  });

  it("uses the same strict port validation as the unified CLI", () => {
    process.argv.push("--port", "3000abc");
    expect(() => getPort()).toThrow("Invalid port: 3000abc");
  });

  it("prefers explicit argv over PORT env when resolving HTTP ports", () => {
    expect(getPort(["http", "--port=4567"], { PORT: "1234" })).toBe(4567);
  });

  it("throws on port <= 0", () => {
    process.argv.push("--port", "0");
    expect(() => getPort()).toThrow(/Invalid port/);
  });

  it("throws on port > 65535", () => {
    process.argv.push("--port", "70000");
    expect(() => getPort()).toThrow(/Invalid port/);
  });
});
