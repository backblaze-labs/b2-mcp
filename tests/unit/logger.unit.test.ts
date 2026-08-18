import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tsxBin = join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

const probeSource = `
import { logger } from "./src/utils/logger";

void (async () => {
  logger.info({ applicationKey: "logger-secret-value" }, "logger.probe");
  await new Promise((resolve, reject) => logger.flush((err) => (err ? reject(err) : resolve())));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
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

function runLoggerProbe(env: NodeJS.ProcessEnv = {}) {
  return spawnSync(tsxBin, ["-e", probeSource], {
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
  it("writes redacted JSON logs to B2_LOG_FILE instead of stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-logger-file-"));
    const logFile = join(dir, "server.log");

    try {
      const result = runLoggerProbe({ B2_LOG_FILE: logFile });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(existsSync(logFile)).toBe(true);

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
    const result = runLoggerProbe();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");

    const line = parseLogLine(result.stderr);
    expect(line.msg).toBe("logger.probe");
    expect(line.level).toBe("info");
    expect(line.applicationKey).toBe("[redacted]");
    expect(JSON.stringify(line)).not.toContain("logger-secret-value");
  });

  it("fails fast with a clear message when B2_LOG_FILE is not writable", () => {
    const logFile = mkdtempSync(join(tmpdir(), "b2-mcp-bad-log-path-"));

    try {
      const result = runLoggerProbe({ B2_LOG_FILE: logFile });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("b2-mcp: B2_LOG_FILE is not writable:");
      expect(result.stderr).toContain(logFile);
    } finally {
      rmSync(logFile, { recursive: true, force: true });
    }
  });
});
