import * as http from "http";
import { logger } from "../../src/utils/logger.js";
import {
  nodeRequestPath,
  nodeRequestToWeb,
  resumeUnreadRequest,
  writeWebResponse,
} from "../../src/utils/node-web-bridge.js";
import { sanitizeText } from "../../src/utils/secret-sanitizer.js";

export type VercelNodeHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>;

export interface FetchRouteContext {
  remoteAddress?: string;
}

export type FetchRoute = (
  request: Request,
  context: FetchRouteContext,
) => Promise<Response> | Response;

function logVercelHandlerFailure(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  signal: AbortSignal,
  error: unknown,
): void {
  logger.warn(
    {
      method: req.method ?? "GET",
      path: nodeRequestPath(req, { scheme: "https" }),
      headersSent: res.headersSent,
      aborted: signal.aborted,
      errorName: error instanceof Error ? error.name : typeof error,
      err: sanitizeText(error instanceof Error ? error.message : String(error)),
    },
    "vercel.http.failed",
  );
}

export function createVercelNodeHandler(route: FetchRoute): VercelNodeHandler {
  return async (req, res) => {
    const abortController = new AbortController();
    let finished = false;
    res.on("close", () => {
      if (!finished) abortController.abort();
    });

    try {
      const response = await route(
        nodeRequestToWeb(req, abortController.signal, { scheme: "https" }),
        {
          remoteAddress: req.socket.remoteAddress,
        },
      );
      resumeUnreadRequest(req);
      await writeWebResponse(response, res, abortController.signal);
    } catch (error) {
      logVercelHandlerFailure(req, res, abortController.signal, error);
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
