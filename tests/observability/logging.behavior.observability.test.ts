import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { MODERN_META, MODERN_PROTOCOL_VERSION, RawStdioSession } from "../support/protocol";

const CANARY_PATTERN = /B2_MCP_CANARY_SECRET_[A-Za-z0-9_-]+/;
const tsxBin = join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const fixturePath = join(process.cwd(), "tests/observability/support/logging-probe-fixture.ts");
const SAFE_ENV_NAMES = [
  "PATH",
  "Path",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
] as const;

type ProbeName =
  | "accessor-safety"
  | "environment"
  | "policy-confirm-fallback"
  | "policy-confirmation"
  | "redaction"
  | "retry-budget"
  | "thrown-failure";

function assertNoCanaries(label: string, text: string): void {
  const leaked = text.match(CANARY_PATTERN)?.[0];
  if (leaked) throw new Error(`${label} leaked ${leaked}`);
}

function nonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseLogLines(stderr: string): Array<Record<string, unknown>> {
  return nonEmptyLines(stderr).map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Expected stderr log line to be JSON, got ${JSON.stringify(line)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}

function findLog(logs: Array<Record<string, unknown>>, message: string): Record<string, unknown> {
  const log = logs.find((entry) => entry.msg === message);
  expect(log, `expected log message ${message}`).toBeTruthy();
  return log as Record<string, unknown>;
}

function expectNoIncidentLogs(logs: Array<Record<string, unknown>>): void {
  const incidentMessages = logs
    .map((entry) => entry.msg)
    .filter((msg) => msg === "server.error" || msg === "server.fatal" || msg === "tool.error");
  expect(incidentMessages).toEqual([]);
}

function probeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    SAFE_ENV_NAMES.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name] as string]],
    ),
  );
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    ...extra,
  };
  delete env.B2_LOG_FILE;
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

function runProbe(probe: ProbeName, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(tsxBin, [fixturePath, probe], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: probeEnv(env),
    timeout: 15_000,
  });
}

function expectProbeSucceeded(result: ReturnType<typeof runProbe>): void {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assertNoCanaries("probe output", output);
  expect(result.status).toBe(0);
}

function resultOf(frame: any): any {
  expect(frame.error).toBeUndefined();
  expect(frame.result).toBeDefined();
  return frame.result;
}

describe("observability logging behavior", () => {
  let raw: RawStdioSession | null = null;

  afterEach(async () => {
    await raw?.close();
    raw = null;
  });

  it("detects raw logging canaries in captured output", () => {
    expect(() =>
      assertNoCanaries("fixture", "leaked B2_MCP_CANARY_SECRET_ASSERTION_CHECK"),
    ).toThrow("B2_MCP_CANARY_SECRET_ASSERTION_CHECK");
  });

  it("keeps stdio protocol frames on stdout and lifecycle logs on stderr", async () => {
    raw = new RawStdioSession();
    raw.start({
      B2_APPLICATION_KEY: "B2_MCP_CANARY_SECRET_PROTOCOL_KEY",
      LOG_LEVEL: "info",
    });

    const discover = resultOf(
      await raw.request("server/discover", {
        _meta: MODERN_META,
      }),
    );
    expect(discover.supportedVersions).toEqual([MODERN_PROTOCOL_VERSION]);

    const listed = resultOf(
      await raw.request("tools/list", {
        _meta: MODERN_META,
      }),
    );
    expect(listed.tools.length).toBeGreaterThan(0);

    const stdout = raw.stdoutLines.join("\n");
    const stderr = raw.stderrChunks.join("");
    assertNoCanaries("stdio stdout", stdout);
    assertNoCanaries("stdio stderr", stderr);

    for (const line of raw.stdoutLines) {
      const frame = JSON.parse(line) as { jsonrpc?: unknown };
      expect(frame.jsonrpc).toBe("2.0");
      expect(line).not.toMatch(/server\.(started|ready)|tool\.call/);
    }
    expect(stdout).toContain('"jsonrpc":"2.0"');
    expect(stderr).toMatch(/server\.(started|ready)/);
    expect(stderr).not.toContain('"method":"server/discover"');
    expect(stderr).not.toContain('"method":"tools/list"');

    const logs = parseLogLines(stderr);
    const started = findLog(logs, "server.started");
    expect(started).toMatchObject({ level: "info", transport: "stdio" });

    const ready = findLog(logs, "server.ready");
    expect(ready.level).toBe("info");
    expect(ready.version).toEqual(expect.any(String));
    expect(ready.outputFormat).toBe("json");
    expect(ready.toolCount).toEqual(expect.any(Number));
    expect(Number(ready.toolCount)).toBeGreaterThan(0);
  });

  it("redacts top-level, nested, header, token, B2 key, and error fields", () => {
    const result = runProbe("redaction");
    expectProbeSucceeded(result);
    expect(result.stdout).toBe("");

    const log = findLog(parseLogLines(result.stderr), "observability.redaction");
    expect(log.level).toBe("error");
    expect(log.applicationKey).toBe("[redacted]");
    expect(log.authorization).toBe("[redacted]");
    expect(log.headers).toMatchObject({
      authorization: "[redacted]",
      "x-b2-mcp-key": "[redacted]",
    });
    expect(log.credentials).toMatchObject({
      appKey: "[redacted]",
      nested: {
        masterKey: "[redacted]",
        sessionToken: "[redacted]",
      },
    });
    expect(log.err).toMatchObject({
      code: "[redacted]",
      errno: -2,
      path: "/tmp/b2-mcp-observability-safe-path",
      requestId: "[redacted]",
      syscall: "open",
    });
    expect(JSON.stringify(log.err)).toContain("[redacted]");
  });

  it("records retry budget warnings with bounded context", () => {
    const result = runProbe("retry-budget");
    expectProbeSucceeded(result);
    expect(JSON.parse(result.stdout)).toEqual({ status: 429 });

    const logs = parseLogLines(result.stderr);
    const warning = findLog(logs, "retry.budgetExhausted");
    expect(warning).toMatchObject({ level: "warn", attempt: 0, status: 429 });
    expect(Object.keys(warning).sort()).toEqual(
      expect.arrayContaining(["attempt", "level", "msg", "status", "time"]),
    );
  });

  it("logs expected confirmation outcomes as tool calls, not incidents", () => {
    const result = runProbe("policy-confirmation");
    expectProbeSucceeded(result);
    const response = JSON.parse(result.stdout) as { isError?: boolean; content?: unknown[] };
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toContain("destructive_confirmation_required");

    const logs = parseLogLines(result.stderr);
    const call = findLog(logs, "tool.call");
    expect(call).toMatchObject({
      level: "info",
      tool: "b2_delete_bucket",
      credential: "policy-fingerprint",
      error: true,
      resultType: "complete",
      code: "destructive_confirmation_required",
      status: 409,
    });
    expect(call.argKeys).toEqual(["bucketId", "confirm", "nested"]);
    expectNoIncidentLogs(logs);
  });

  it("attributes legacy confirm fallback in the tool audit record", () => {
    const result = runProbe("policy-confirm-fallback");
    expectProbeSucceeded(result);
    const response = JSON.parse(result.stdout) as { isError?: boolean; content?: unknown[] };
    expect(response.isError).not.toBe(true);
    expect(JSON.stringify(response.content)).toContain("deleted");

    const logs = parseLogLines(result.stderr);
    const call = findLog(logs, "tool.call");
    expect(call).toMatchObject({
      level: "info",
      tool: "b2_delete_bucket",
      credential: "fallback-fingerprint",
      error: false,
      resultType: "complete",
      elicitationOutcome: "fallback_accepted",
      handlerRan: true,
      destructiveConfirmationSource: "model_confirm_parameter",
      destructiveConfirmationFallbackReason: "client_cannot_elicit",
    });
    expect(call.argKeys).toEqual(["bucketId", "confirm", "nested"]);
    expect(findLog(logs, "destructive.elicitation")).toMatchObject({
      decision: "fallback_accepted",
      outcome: "fallback_accepted",
      destructiveConfirmationSource: "model_confirm_parameter",
      destructiveConfirmationFallbackReason: "client_cannot_elicit",
    });
    expectNoIncidentLogs(logs);
  });

  it("logs thrown tool failures as sanitized warnings", () => {
    const result = runProbe("thrown-failure");
    expectProbeSucceeded(result);
    const thrown = JSON.parse(result.stdout);
    expect(thrown).toMatchObject({
      message: "upstream failed [redacted]",
      code: "[redacted]",
      status: 503,
      requestId: "[redacted]",
      errno: -2,
      syscall: "open",
      path: "/tmp/b2-mcp-observability-safe-path",
    });

    const logs = parseLogLines(result.stderr);
    const failure = findLog(logs, "tool.error");
    expect(failure).toMatchObject({
      level: "warn",
      tool: "b2_list_buckets",
      credential: "failure-fingerprint",
      err: "upstream failed [redacted]",
    });
    expect(failure.argKeys).toEqual(["bucketName", "secret"]);
    expect(logs.map((entry) => entry.msg)).not.toContain("server.error");
    expect(logs.map((entry) => entry.msg)).not.toContain("server.fatal");
  });

  it("does not invoke hostile accessors while logging", () => {
    const result = runProbe("accessor-safety");
    expectProbeSucceeded(result);
    expect(JSON.parse(result.stdout)).toEqual({ getterReads: 0 });

    const logs = parseLogLines(result.stderr);
    const accessor = findLog(logs, "observability.accessor");
    expect(accessor).toMatchObject({
      authorization: "[redacted]",
      metadata: "[accessor]",
    });

    const failure = findLog(logs, "observability.sanitizerFailure");
    expect(failure).toMatchObject({
      logSanitizer: "[log_sanitizer_failed]",
    });
  });

  it("does not inherit unrelated developer or CI secrets into probes", () => {
    const previous = {
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      NPM_TOKEN: process.env.NPM_TOKEN,
      SERVICE_SECRET: process.env.SERVICE_SECRET,
      SERVICE_TOKEN: process.env.SERVICE_TOKEN,
    };
    const sentinel = "sentinel-non-b2-secret";
    process.env.AWS_SECRET_ACCESS_KEY = sentinel;
    process.env.GH_TOKEN = sentinel;
    process.env.GITHUB_TOKEN = sentinel;
    process.env.NPM_TOKEN = sentinel;
    process.env.SERVICE_SECRET = sentinel;
    process.env.SERVICE_TOKEN = sentinel;

    try {
      const result = runProbe("environment");
      const output = `${result.stdout}${result.stderr}`;
      expect(output).not.toContain(sentinel);
      expectProbeSucceeded(result);
      expect(JSON.parse(result.stdout)).toEqual({
        aws: null,
        gh: null,
        github: null,
        npm: null,
        serviceSecret: null,
        serviceToken: null,
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
