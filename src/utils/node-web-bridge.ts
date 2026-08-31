import * as http from "http";
import { Readable } from "stream";

/**
 * Helpers for translating between Node HTTP primitives and Fetch API objects.
 *
 * @remarks
 * The standalone Node server uses these helpers so the shared fetch pipeline
 * can also run in serverless environments.
 */

/** Options used when converting a Node request into a Web request. */
export interface NodeRequestToWebOptions {
  /** Scheme to use when reconstructing an absolute request URL. */
  scheme?: "http" | "https";
}

/**
 * Return the first header value from Node's string-or-array representation.
 *
 * @param value - Header value from `IncomingHttpHeaders`.
 *
 * @returns First value, single value, or undefined.
 */
export function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Convert Node incoming headers into a Fetch Headers object.
 *
 * @param headers - Node incoming headers.
 *
 * @returns Fetch-compatible Headers.
 */
export function headersFromNode(headers: http.IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.startsWith(":")) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else {
      result.set(name, value);
    }
  }
  return result;
}

/**
 * Reconstruct an absolute request URL from a Node request.
 *
 * @param req - Incoming Node request.
 * @param options - URL reconstruction options.
 *
 * @returns Absolute URL string.
 */
export function nodeRequestUrl(
  req: http.IncomingMessage,
  options: NodeRequestToWebOptions = {},
): string {
  const scheme = options.scheme ?? "http";
  const host =
    firstHeaderValue(req.headers.host) ??
    firstHeaderValue(req.headers[":authority"]) ??
    "localhost";
  return `${scheme}://${host}${req.url ?? "/"}`;
}

/**
 * Read the URL path from a Node request.
 *
 * @param req - Incoming Node request.
 * @param options - URL reconstruction options.
 *
 * @returns Request pathname, or `/` when parsing fails.
 */
export function nodeRequestPath(
  req: http.IncomingMessage,
  options: NodeRequestToWebOptions = {},
): string {
  try {
    return new URL(nodeRequestUrl(req, options)).pathname;
  } catch {
    return "/";
  }
}

/**
 * Convert a Node request stream into a Fetch Request.
 *
 * @param req - Incoming Node request.
 * @param signal - Abort signal tied to the Node connection.
 * @param options - URL reconstruction options.
 *
 * @returns Fetch-compatible Request.
 */
export function nodeRequestToWeb(
  req: http.IncomingMessage,
  signal: AbortSignal,
  options: NodeRequestToWebOptions = {},
): Request {
  const method = (req.method ?? "GET").toUpperCase();
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: headersFromNode(req.headers),
    signal,
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as RequestInit["body"];
    init.duplex = "half";
  }
  return new Request(nodeRequestUrl(req, options), init);
}

/**
 * Convert Fetch response headers into Node outgoing headers.
 *
 * @param headers - Fetch Headers object.
 *
 * @returns Node outgoing header map.
 */
export function headersFromWeb(headers: Headers): http.OutgoingHttpHeaders {
  const nodeHeaders: http.OutgoingHttpHeaders = {};
  for (const [name, value] of headers) {
    const current = nodeHeaders[name];
    if (current === undefined) {
      nodeHeaders[name] = value;
    } else if (Array.isArray(current)) {
      current.push(value);
    } else {
      nodeHeaders[name] = [String(current), value];
    }
  }
  const setCookies = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (setCookies && setCookies.length > 0) nodeHeaders["set-cookie"] = setCookies;
  return nodeHeaders;
}

function waitForDrain(res: http.ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted || res.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    res.once("drain", onDrain);
    res.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Stream a Fetch Response into a Node ServerResponse.
 *
 * @param response - Fetch response produced by the shared HTTP pipeline.
 * @param res - Node response to write.
 * @param signal - Abort signal tied to the client connection.
 */
export async function writeWebResponse(
  response: Response,
  res: http.ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  res.writeHead(response.status, headersFromWeb(response.headers));

  if (response.body !== null) {
    const reader = response.body.getReader();
    const cancelBody = () => {
      void reader.cancel("client disconnected").catch(() => undefined);
    };
    signal.addEventListener("abort", cancelBody, { once: true });
    try {
      while (true) {
        if (signal.aborted || res.destroyed) {
          await reader.cancel("client disconnected").catch(() => undefined);
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) await waitForDrain(res, signal);
      }
    } finally {
      signal.removeEventListener("abort", cancelBody);
      reader.releaseLock();
    }
  }

  if (!signal.aborted && !res.destroyed) res.end();
}

/**
 * Drain any unread request body after a request is rejected.
 *
 * @param req - Incoming Node request.
 */
export function resumeUnreadRequest(req: http.IncomingMessage): void {
  if (!req.readableEnded && !req.destroyed) req.resume();
}
