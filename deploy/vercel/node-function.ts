import * as http from "http";
import { Readable } from "stream";

export type VercelNodeHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>;

export type FetchRoute = (request: Request) => Promise<Response> | Response;

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function headersFromNode(headers: http.IncomingHttpHeaders): Headers {
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

function requestUrl(req: http.IncomingMessage): string {
  const host =
    firstHeaderValue(req.headers.host) ??
    firstHeaderValue(req.headers[":authority"]) ??
    "localhost";
  return `https://${host}${req.url ?? "/"}`;
}

function nodeRequestToWeb(req: http.IncomingMessage, signal: AbortSignal): Request {
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
  return new Request(requestUrl(req), init);
}

function headersFromWeb(headers: Headers): http.OutgoingHttpHeaders {
  const nodeHeaders: http.OutgoingHttpHeaders = {};
  for (const [name, value] of headers) nodeHeaders[name] = value;
  const setCookies = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (setCookies && setCookies.length > 0) nodeHeaders["set-cookie"] = setCookies;
  return nodeHeaders;
}

async function writeWebResponse(
  response: Response,
  res: http.ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  res.writeHead(response.status, headersFromWeb(response.headers));
  if (response.body !== null) {
    for await (const chunk of response.body) {
      if (signal.aborted) break;
      res.write(chunk);
    }
  }
  if (!res.destroyed) res.end();
}

export function createVercelNodeHandler(route: FetchRoute): VercelNodeHandler {
  return async (req, res) => {
    const abortController = new AbortController();
    let finished = false;
    res.on("close", () => {
      if (!finished) abortController.abort();
    });

    try {
      const response = await route(nodeRequestToWeb(req, abortController.signal));
      if (!req.readableEnded && !req.destroyed) req.resume();
      await writeWebResponse(response, res, abortController.signal);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      } else if (!res.destroyed) {
        res.destroy();
      }
    } finally {
      finished = true;
    }
  };
}
