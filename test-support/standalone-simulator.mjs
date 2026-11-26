// Harness for the standalone B2 simulator (backblaze-labs/b2-simulator).
// Plain ESM so the TypeScript tests (through standalone-simulator.ts) and the
// protocol entrypoint (tests/protocol/support/simulator-entrypoint.mjs) share
// one implementation. Types and docs: standalone-simulator.d.mts.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FetchTransport } from "@backblaze-labs/b2-sdk";

export const SIMULATOR_DIR_ENV = "B2_SIMULATOR_DIR";

export const IN_PROCESS_COMPATIBLE_ARGS = Object.freeze([
  "--control",
  "--profile",
  "ts-sdk",
  "--permissive-auth",
  "--no-partner-authorize",
]);

const EXIT_WITH_OWNER = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "exit-with-owner.mjs"),
).href;

const READY_PATTERNS = {
  http: /^SIMULATOR-LISTENING (http:\/\/127\.0\.0\.1:\d+)$/m,
  https: /^SIMULATOR-LISTENING (https:\/\/127\.0\.0\.1:\d+)$/m,
  control: /^SIMULATOR-CONTROL (http:\/\/127\.0\.0\.1:\d+)$/m,
};

const SERVER_ENV_NAMES = [
  "PATH",
  "Path",
  "SystemRoot",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
];

export function resolveSimulatorServeScript(env = process.env) {
  const dir = env[SIMULATOR_DIR_ENV]?.trim();
  if (!dir) {
    throw new Error(
      `${SIMULATOR_DIR_ENV} is not set. Simulator-backed tests need a local checkout of ` +
        "backblaze-labs/b2-simulator: clone it and set " +
        `${SIMULATOR_DIR_ENV}=/absolute/path/to/b2-simulator (see docs/TESTING.md, ` +
        '"Standalone Simulator").',
    );
  }
  if (!isAbsolute(dir)) {
    throw new Error(`${SIMULATOR_DIR_ENV} must be an absolute path, got ${dir}.`);
  }
  const serveScript = join(dir, "bin", "simulator", "serve.mjs");
  if (!existsSync(serveScript)) {
    throw new Error(
      `${SIMULATOR_DIR_ENV}=${dir} has no bin/simulator/serve.mjs; point it at a ` +
        "backblaze-labs/b2-simulator checkout.",
    );
  }
  return { serveScript, caCertPath: join(dir, "bin", "simulator", "loopback-cert.pem") };
}

/** Environment for the server: enough to run node, and never a B2 credential. */
function serverEnv() {
  const env = {};
  for (const name of SERVER_ENV_NAMES) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function waitForReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const fail = (reason) => {
      cleanup();
      child.kill("SIGKILL");
      reject(new Error(`${reason}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };
    const timer = setTimeout(
      () => fail(`simulator did not print its listening lines within ${timeoutMs} ms`),
      timeoutMs,
    );
    const onStdout = (chunk) => {
      stdout += chunk.toString("utf8");
      const http = READY_PATTERNS.http.exec(stdout)?.[1];
      const https = READY_PATTERNS.https.exec(stdout)?.[1];
      const control = READY_PATTERNS.control.exec(stdout)?.[1];
      if (http && https && control) {
        cleanup();
        resolve({ http, https, control });
      }
    };
    const onStderr = (chunk) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code, signal) =>
      fail(`simulator exited before listening (code ${code}, signal ${signal})`);
    const onError = (err) => fail(`simulator could not start: ${err.message}`);
    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    }
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function control(origin, method, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`simulator control ${method} ${path} answered ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Send every request to `origin`, keeping path and query, and answer as if the
 * simulator lived at the origin the client asked for.
 *
 * The SDK's in-process simulator served any host and echoed the requested
 * origin in the URLs it minted (`apiUrl`, `downloadUrl`, `s3ApiUrl`, upload
 * URLs). The standalone server mints its own loopback origin instead, which the
 * MCP server rightly refuses (only `https://*.backblazeb2.com` is trusted). So
 * JSON answers get the loopback origin replaced by the requested one; file
 * bodies and headers are passed through untouched.
 */
export function originRewritingTransport(origin) {
  const inner = new FetchTransport();
  return {
    async send(request) {
      const requested = new URL(request.url);
      const response = await inner.send({
        ...request,
        url: new URL(`${requested.pathname}${requested.search}`, origin).href,
      });
      const json = (response.headers.get("content-type") ?? "").includes("json");
      if (!json || request.method === "HEAD" || requested.origin === origin) return response;
      const text = await response.text();
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(text.split(origin).join(requested.origin), {
        status: response.status,
        headers,
      });
    },
  };
}

export async function startStandaloneSimulator(options = {}) {
  const { serveScript, caCertPath } = resolveSimulatorServeScript(options.env);
  const child = spawn(
    process.execPath,
    [
      "--import",
      EXIT_WITH_OWNER,
      serveScript,
      ...IN_PROCESS_COMPATIBLE_ARGS,
      ...(options.extraArgs ?? []),
    ],
    // stdin stays open: its end is the signal that this owner is gone.
    { env: serverEnv(), stdio: ["pipe", "pipe", "pipe"] },
  );
  const origins = await waitForReady(child, options.startTimeoutMs ?? 15_000);
  // Keep draining output so a chatty server never blocks on a full pipe.
  child.stdout?.resume();
  child.stderr?.resume();
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });

  return {
    pid: child.pid,
    httpOrigin: origins.http,
    httpsOrigin: origins.https,
    controlOrigin: origins.control,
    caCertPath,
    transport: () => originRewritingTransport(origins.http),
    reset: async (config) => {
      await control(origins.control, "POST", "/reset", config ? { config } : {});
    },
    injectFailure: async (fault) => {
      const { id } = await control(origins.control, "POST", "/faults", fault);
      return {
        id,
        clear: async () => {
          await control(origins.control, "DELETE", `/faults/${id}`);
        },
      };
    },
    advanceTime: async (ms) => {
      await control(origins.control, "POST", "/clock", { advanceMs: ms });
    },
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        await exited;
        clearTimeout(timer);
      }
    },
  };
}
