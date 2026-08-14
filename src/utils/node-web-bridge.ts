import * as http from "http";
import { Readable } from "stream";

export interface NodeRequestToWebOptions {
  scheme?: "http" | "https";
}

export function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

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

export function resumeUnreadRequest(req: http.IncomingMessage): void {
  if (!req.readableEnded && !req.destroyed) req.resume();
}
