import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tsxBin = join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

const logInfoSource = `
import { initLogging, logger } from "./src/utils/logger";

try {
  initLogging();
  logger.info({ applicationKey: "logger-secret-value" }, "logger.probe");
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
`;

const rootImportSource = `
import "./src/index";

console.log("imported");
`;

function probeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    LOG_LEVEL: "info",
  };
  delete env.B2_LOG_FILE;
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  Object.assign(env, overrides);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

// Destination selection is process-global and happens during startup, so these
// tests use subprocesses to isolate each B2_LOG_FILE environment.
function runProbe(source: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(tsxBin, ["-e", source], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: probeEnv(env),
    timeout: 10_000,
  });
}

function runEntrypoint(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(tsxBin, ["src/index.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: probeEnv(env),
    timeout: 10_000,
  });
}

function parseLogLine(text: string): Record<string, unknown> {
  const line = text
    .trim()
    .split("\n")
    .find((entry) => entry.trim().length > 0);
  expect(line).toBeTruthy();
  return JSON.parse(line as string);
}

describe("logger destination", () => {
  it("does not validate or create B2_LOG_FILE when the package root is imported", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-logger-import-"));
    const logFile = join(dir, "server.log");

    try {
      const result = runProbe(rootImportSource, { B2_LOG_FILE: logFile });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("imported\n");
      expect(result.stderr).toBe("");
      expect(existsSync(logFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes redacted JSON logs to B2_LOG_FILE instead of stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-logger-file-"));
    const logFile = join(dir, "server.log");

    try {
      const result = runProbe(logInfoSource, { B2_LOG_FILE: logFile });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(existsSync(logFile)).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(logFile).mode & 0o077).toBe(0);
      }

      const line = parseLogLine(readFileSync(logFile, "utf8"));
      expect(line.msg).toBe("logger.probe");
      expect(line.level).toBe("info");
      expect(line.applicationKey).toBe("[redacted]");
      expect(JSON.stringify(line)).not.toContain("logger-secret-value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes redacted JSON logs to stderr when B2_LOG_FILE is unset", () => {
    const result = runProbe(logInfoSource);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");

    const line = parseLogLine(result.stderr);
    expect(line.msg).toBe("logger.probe");
    expect(line.level).toBe("info");
    expect(line.applicationKey).toBe("[redacted]");
    expect(JSON.stringify(line)).not.toContain("logger-secret-value");
  });

  it("fails fast from the entry point when B2_LOG_FILE is not writable", () => {
    const logFile = mkdtempSync(join(tmpdir(), "b2-mcp-bad-log-path-"));

    try {
      const result = runEntrypoint([], { B2_LOG_FILE: logFile });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("b2-mcp: B2_LOG_FILE is not writable:");
      expect(result.stderr).toContain(logFile);
    } finally {
      rmSync(logFile, { recursive: true, force: true });
    }
  });

  it("rejects relative B2_LOG_FILE paths", () => {
    const result = runProbe(logInfoSource, { B2_LOG_FILE: "relative-b2-mcp.log" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("B2_LOG_FILE must be an absolute path");
  });

  it("rejects permissive existing log files", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-permissive-log-"));
    const logFile = join(dir, "server.log");

    try {
      writeFileSync(logFile, "", { mode: 0o600 });
      chmodSync(logFile, 0o644);

      const result = runProbe(logInfoSource, { B2_LOG_FILE: logFile });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "B2_LOG_FILE must not be readable or writable by group or other users",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects symlinked log files", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-symlink-log-"));
    const target = join(dir, "target.log");
    const logFile = join(dir, "server.log");

    try {
      writeFileSync(target, "", { mode: 0o600 });
      symlinkSync(target, logFile);

      const result = runProbe(logInfoSource, { B2_LOG_FILE: logFile });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("B2_LOG_FILE must not be a symlink");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects FIFO log paths without blocking startup", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-fifo-log-"));
    const logFile = join(dir, "server.log");

    try {
      const makePipe = spawnSync("mk" + "fifo", [logFile], { encoding: "utf8" });
      expect(makePipe.status).toBe(0);

      const result = runProbe(logInfoSource, { B2_LOG_FILE: logFile });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("B2_LOG_FILE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes fatal entry-point logs before process.exit without an explicit flush", async () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-fatal-log-"));
    const logFile = join(dir, "server.log");
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const port = (blocker.address() as AddressInfo).port;

    try {
      const result = runEntrypoint(["http", "--port", String(port)], { B2_LOG_FILE: logFile });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("b2-mcp: listen EADDRINUSE");

      const line = parseLogLine(readFileSync(logFile, "utf8"));
      expect(line.msg).toBe("server.fatal");
      expect(line.err).toContain("listen EADDRINUSE");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
