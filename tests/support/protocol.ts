import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { once } from "events";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import {
  DIST_HTTP,
  DIST_INDEX,
  ROOT,
  SIMULATOR_ENTRYPOINT,
  requireBuiltFiles,
  safeSpawnEnv,
} from "../../test-support/mcp-server-process";

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";

export const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "b2-mcp-protocol-test", version: "1.0.0" },
};

export { ROOT, SIMULATOR_ENTRYPOINT };
const REQUEST_TIMEOUT_MS = process.platform === "win32" ? 15_000 : 10_000;

export function requireBuiltEntrypoints(): void {
  requireBuiltFiles(
    [DIST_INDEX, DIST_HTTP, SIMULATOR_ENTRYPOINT],
    "Protocol transport tests require built dist entry points. Run npm run build.",
  );
}

export function protocolEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return safeSpawnEnv({
    NODE_ENV: "test",
    B2_REGISTER_ALL_TOOLS: "true",
    B2_APPLICATION_KEY_ID: "protocol-key-id",
    B2_APPLICATION_KEY: "protocol-key-secret",
    B2_HTTP_CREDENTIAL_MODE: "headers",
    ...extra,
  });
}

export class RawStdioSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private nextId = 1;
  readonly stdoutLines: string[] = [];
  readonly stderrChunks: string[] = [];
  readonly frames: JSONRPCMessage[] = [];

  start(extraEnv: NodeJS.ProcessEnv = {}): void {
    requireBuiltEntrypoints();
    this.child = spawn(process.execPath, [SIMULATOR_ENTRYPOINT, "stdio"], {
      cwd: ROOT,
      env: protocolEnv(extraEnv),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.captureStdout(chunk.toString()));
    this.child.stderr.on("data", (chunk) => this.stderrChunks.push(chunk.toString()));
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<JSONRPCMessage> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.waitForFrame((frame) => "id" in frame && frame.id === id);
  }

  send(message: JSONRPCMessage): void {
    if (!this.child) throw new Error("Raw stdio session is not started");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.stdin.end();
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    timer.unref();
    await once(child, "exit").catch(() => undefined);
    clearTimeout(timer);
  }

  private captureStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      this.stdoutLines.push(line);
      this.frames.push(JSON.parse(line) as JSONRPCMessage);
    }
  }

  private waitForFrame(predicate: (frame: JSONRPCMessage) => boolean): Promise<JSONRPCMessage> {
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const interval = setInterval(() => {
        const frame = this.frames.find(predicate);
        if (frame) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve(frame);
        }
      }, 10);
      const timer = setTimeout(() => {
        clearInterval(interval);
        reject(new Error(`Timed out waiting for stdio frame after ${Date.now() - started}ms`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
    });
  }
}
