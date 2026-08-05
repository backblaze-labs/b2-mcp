import type { IncomingHttpHeaders, ServerResponse } from "http";
import type {
  AuthInfo,
  McpHandlerRequestOptions,
  McpHttpHandler,
} from "@modelcontextprotocol/server";

type RequestBodyChunk = string | Uint8Array;

export interface NodeHttpRequest extends AsyncIterable<RequestBodyChunk> {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  auth?: AuthInfo;
}

export interface NodeHttpAdapterOptions {
  onerror?: (error: Error) => void;
}

function reportAdapterError(options: NodeHttpAdapterOptions, error: unknown): void {
  try {
    options.onerror?.(error instanceof Error ? error : new Error(String(error)));
  } catch {
    // Error observers must not prevent a protocol-safe response.
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readRequestBody(req: NodeHttpRequest): Promise<string | undefined> {
  const decoder = new TextDecoder();
  let body = "";
  for await (const chunk of req) {
    body += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  body += decoder.decode();
  return body || undefined;
}

async function toWebRequest(
  req: NodeHttpRequest,
  parsedBody: unknown,
  signal: AbortSignal,
): Promise<Request> {
  const method = (req.method ?? "GET").toUpperCase();
  const host =
    firstHeaderValue(req.headers.host) ??
    firstHeaderValue(req.headers[":authority"]) ??
    "localhost";
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(":")) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }

  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    if (parsedBody === undefined) {
      body = await readRequestBody(req);
    } else {
      body = JSON.stringify(parsedBody);
      headers.delete("content-encoding");
      headers.delete("transfer-encoding");
      if (body === undefined) {
        headers.delete("content-length");
      } else {
        headers.set("content-length", String(new TextEncoder().encode(body).byteLength));
      }
    }
  }

  return new Request(`http://${host}${req.url ?? "/"}`, {
    method,
    headers,
    signal,
    ...(body !== undefined && { body }),
  });
}

function requestIdFromBody(body: unknown): string | number | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { method, id } = body as { method?: unknown; id?: unknown };
  if (typeof method !== "string") return null;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function internalServerError(body: unknown): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: requestIdFromBody(body),
    },
    { status: 500 },
  );
}

function waitForDrain(res: ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      res.off("drain", finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    res.once("drain", finish);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function writeWebResponse(
  response: Response,
  res: ServerResponse,
  signal: AbortSignal,
  options: NodeHttpAdapterOptions,
): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) headers[name] = value;
  res.writeHead(response.status, headers);

  if (response.body !== null) {
    try {
      for await (const chunk of response.body) {
        if (signal.aborted) break;
        if (!res.write(chunk)) await waitForDrain(res, signal);
      }
    } catch (error) {
      if (signal.aborted || res.destroyed) return;
      reportAdapterError(options, error);
      if (!res.destroyed) res.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
  }

  if (!res.destroyed) res.end();
}

/**
 * Adapts the MCP SDK's web-standard fetch handler to Node's HTTP server API.
 * Keeping this narrow bridge local avoids shipping an additional web framework.
 */
export function createNodeHttpHandler(
  handler: Pick<McpHttpHandler, "fetch">,
  options: NodeHttpAdapterOptions = {},
): (req: NodeHttpRequest, res: ServerResponse, parsedBody?: unknown) => Promise<void> {
  return async (req, res, parsedBody) => {
    if (typeof parsedBody === "function") parsedBody = undefined;

    let finished = false;
    const abortController = new AbortController();
    res.on("close", () => {
      if (!finished) abortController.abort();
    });
    if (res.destroyed) abortController.abort();

    let response: Response;
    try {
      const request = await toWebRequest(req, parsedBody, abortController.signal);
      const requestOptions: McpHandlerRequestOptions = {
        ...(req.auth !== undefined && { authInfo: req.auth }),
        ...(parsedBody !== undefined && { parsedBody }),
      };
      response = await handler.fetch(request, requestOptions);
    } catch (error) {
      reportAdapterError(options, error);
      response = internalServerError(parsedBody);
    }

    await writeWebResponse(response, res, abortController.signal, options);
    finished = true;
  };
}
