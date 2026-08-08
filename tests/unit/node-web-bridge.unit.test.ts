import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { ReadableStream } from "node:stream/web";
import type * as http from "http";
import { createVercelNodeHandler } from "../../deploy/vercel/node-function";
import { logger } from "../../src/utils/logger";
import { writeWebResponse } from "../../src/utils/node-web-bridge";

class FakeServerResponse extends EventEmitter {
  destroyed = false;
  headersSent = false;
  statusCode = 0;
  headers: http.OutgoingHttpHeaders = {};
  chunks: Uint8Array[] = [];
  writeReturns: boolean[] = [];
  writeHead = vi.fn((status: number, headers: http.OutgoingHttpHeaders) => {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  });
  write = vi.fn((chunk: Uint8Array) => {
    this.chunks.push(chunk);
    return this.writeReturns.shift() ?? true;
  });
  end = vi.fn(() => {
    this.emit("finish");
    return this;
  });
  destroy = vi.fn((error?: Error) => {
    this.destroyed = true;
    this.emit("error", error ?? new Error("destroyed"));
    return this;
  });
}

function textStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function fakeRequest(): http.IncomingMessage {
  const req = new PassThrough() as unknown as http.IncomingMessage;
  req.method = "GET";
  req.url = "/mcp?token=ignored";
  req.headers = { host: "mcp.example.com" };
  Object.defineProperty(req, "socket", {
    value: { remoteAddress: "198.51.100.10" },
  });
  return req;
}

describe("Node Web bridge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for drain when ServerResponse applies backpressure", async () => {
    const res = new FakeServerResponse();
    res.writeReturns = [false, true];
    const response = new Response(textStream(["a", "b"]));

    const pending = writeWebResponse(
      response,
      res as unknown as http.ServerResponse,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(res.write).toHaveBeenCalledTimes(1));
    expect(res.end).not.toHaveBeenCalled();

    res.emit("drain");
    await pending;

    expect(res.write).toHaveBeenCalledTimes(2);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it("cancels the upstream response body when the client aborts", async () => {
    let cancelled = false;
    const res = new FakeServerResponse();
    res.writeReturns = [false];
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode("chunk"));
      },
      cancel() {
        cancelled = true;
      },
    });

    const pending = writeWebResponse(
      new Response(body),
      res as unknown as http.ServerResponse,
      controller.signal,
    );
    await vi.waitFor(() => expect(res.write).toHaveBeenCalledTimes(1));

    controller.abort();
    await pending;

    expect(cancelled).toBe(true);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("logs redacted diagnostics for unexpected Vercel handler failures", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const res = new FakeServerResponse();
    const handler = createVercelNodeHandler(() => {
      throw new Error("Authorization: Bearer secret-token-value");
    });

    await handler(fakeRequest(), res as unknown as http.ServerResponse);

    expect(res.statusCode).toBe(500);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/mcp",
        headersSent: false,
        aborted: false,
        errorName: "Error",
      }),
      "vercel.http.failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-token-value");
  });
});
