import * as http from "http";
import type { AddressInfo } from "net";
import type { HttpServerHandle } from "../../src/http-server";

export interface Resp {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

export const creds = { "x-b2-key-id": "key-abc", "x-b2-key": "secret-xyz" };

export const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

export const HTTP_ENV_KEYS = [
  "B2_REGISTER_ALL_TOOLS",
  "B2_HTTP_CREDENTIAL_MODE",
  "B2_ENABLE_MCP_PROMPTS",
] as const;

export type SavedEnv = Record<string, string | undefined>;

export function saveEnv(keys: readonly string[] = HTTP_ENV_KEYS): SavedEnv {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

export function restoreEnv(saved: SavedEnv): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export function setDefaultHttpTestEnv(): void {
  process.env.B2_REGISTER_ALL_TOOLS = "true";
  process.env.B2_HTTP_CREDENTIAL_MODE = "headers";
  delete process.env.B2_ENABLE_MCP_PROMPTS;
}

export function request(
  port: number,
  method: string,
  pathname: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = http.request(
      { host: "127.0.0.1", port, method, path: pathname, headers: opts.headers },
      (res) => {
        let data = "";
        const status = res.statusCode ?? 0;
        const done = () => finish(() => resolve({ status, body: data, headers: res.headers }));
        res.on("data", (c) => (data += c));
        res.on("end", done);
        res.on("close", done);
      },
    );
    req.on("error", (err) => finish(() => reject(err)));
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new Error("request timed out")));
    }, 4000);
    timer.unref();
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export async function listenOnLocalhost(handle: HttpServerHandle): Promise<number> {
  await new Promise<void>((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
  return (handle.server.address() as AddressInfo).port;
}

export async function closeHttpServer(handle: HttpServerHandle): Promise<void> {
  handle.drain();
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
}
