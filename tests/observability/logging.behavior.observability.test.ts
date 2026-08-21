import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { MODERN_META, MODERN_PROTOCOL_VERSION, RawStdioSession } from "../protocol/support/clients";

const CANARY_PATTERN = /B2_MCP_CANARY_SECRET_[A-Za-z0-9_-]+/;
const tsxBin = join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    ...extra,
  };
  delete env.B2_LOG_FILE;
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

function runProbe(source: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(tsxBin, ["-e", source], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: probeEnv(env),
    timeout: 15_000,
  });
}

function expectProbeSucceeded(result: ReturnType<typeof runProbe>): void {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assertNoCanaries("probe output", output);
  expect(result.status, output).toBe(0);
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
    const result = runProbe(`
import { flushLogsSync, initLogging, logger } from "./src/utils/logger";

initLogging();
const err = Object.assign(
  new Error("provider failed B2_MCP_CANARY_SECRET_ERROR_MESSAGE"),
  {
    code: "B2_MCP_CANARY_SECRET_ERROR_CODE",
    status: 503,
    requestId: "B2_MCP_CANARY_SECRET_ERROR_REQUEST_ID",
  },
);
logger.error(
  {
    applicationKey: "B2_MCP_CANARY_SECRET_TOP_LEVEL_KEY",
    authorization: "Bearer B2_MCP_CANARY_SECRET_TOP_LEVEL_AUTH",
    headers: {
      authorization: "Bearer B2_MCP_CANARY_SECRET_HEADER_AUTH",
      "x-b2-key": "B2_MCP_CANARY_SECRET_HEADER_B2_KEY",
    },
    credentials: {
      appKey: "B2_MCP_CANARY_SECRET_NESTED_APP_KEY",
      nested: {
        masterKey: "B2_MCP_CANARY_SECRET_DEEP_MASTER_KEY",
        sessionToken: "B2_MCP_CANARY_SECRET_DEEP_SESSION_TOKEN",
      },
    },
    err,
  },
  "observability.redaction",
);
flushLogsSync();
`);
    expectProbeSucceeded(result);
    expect(result.stdout).toBe("");

    const log = findLog(parseLogLines(result.stderr), "observability.redaction");
    expect(log.level).toBe("error");
    expect(log.applicationKey).toBe("[redacted]");
    expect(log.authorization).toBe("[redacted]");
    expect(log.headers).toMatchObject({
      authorization: "[redacted]",
      "x-b2-key": "[redacted]",
    });
    expect(log.credentials).toMatchObject({
      appKey: "[redacted]",
      nested: {
        masterKey: "[redacted]",
        sessionToken: "[redacted]",
      },
    });
    expect(JSON.stringify(log.err)).toContain("[redacted]");
  });

  it("records retry budget warnings with bounded context", () => {
    const result = runProbe(`
import { flushLogsSync, initLogging } from "./src/utils/logger";
import { _consumeRetryToken, _resetRetryBudget, withRetry } from "./src/utils/retry";

initLogging();
async function main() {
  _resetRetryBudget();
  for (let i = 0; i < 100; i++) _consumeRetryToken();
  try {
    await withRetry(async () => {
      throw {
        message: "rate limited B2_MCP_CANARY_SECRET_RETRY_MESSAGE",
        response: {
          status: 429,
          headers: { authorization: "Bearer B2_MCP_CANARY_SECRET_RETRY_AUTH" },
          data: { applicationKey: "B2_MCP_CANARY_SECRET_RETRY_BODY_KEY" },
        },
      };
    }, 1);
  } catch (err) {
    process.stdout.write(JSON.stringify({ status: err.response.status }));
  }
  flushLogsSync();
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
`);
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
    const result = runProbe(`
import { createAuditedToolCallback } from "./src/server";
import { checkDestructive } from "./src/utils/destructive-gate";
import { toolError, toolSuccess } from "./src/utils/errors";
import { flushLogsSync, initLogging } from "./src/utils/logger";

initLogging();
const config = {
  applicationKeyId: "policy-key-id",
  applicationKey: "B2_MCP_CANARY_SECRET_POLICY_APPLICATION_KEY",
  appKeyId: "policy-key-id",
  appKey: "B2_MCP_CANARY_SECRET_POLICY_APP_KEY",
  masterKeyId: "policy-key-id",
  masterKey: "B2_MCP_CANARY_SECRET_POLICY_MASTER_KEY",
  region: "us-west-004",
  allowLocalFiles: false,
  fileRoot: null,
  destructivePolicy: "confirm",
  outputFormat: "json",
  transport: "stdio",
  credentialFingerprint: "policy-fingerprint",
};
const wrapped = createAuditedToolCallback(
  "b2_delete_bucket",
  async (args) => {
    const gate = checkDestructive("b2_delete_bucket", args, config);
    return gate.ok ? toolSuccess("deleted") : toolError(gate.error);
  },
  config,
);
async function main() {
  const result = await wrapped(
    {
      bucketId: "bucket-with-confirmation-required",
      confirm: false,
      nested: { applicationKey: "B2_MCP_CANARY_SECRET_POLICY_ARG" },
    },
    {},
  );
  process.stdout.write(JSON.stringify(result));
  flushLogsSync();
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
`);
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

  it("logs thrown tool failures as sanitized warnings", () => {
    const result = runProbe(`
import { createAuditedToolCallback } from "./src/server";
import { flushLogsSync, initLogging } from "./src/utils/logger";

initLogging();
const config = {
  applicationKeyId: "failure-key-id",
  applicationKey: "B2_MCP_CANARY_SECRET_FAILURE_APPLICATION_KEY",
  appKeyId: "failure-key-id",
  appKey: "B2_MCP_CANARY_SECRET_FAILURE_APP_KEY",
  masterKeyId: "failure-key-id",
  masterKey: "B2_MCP_CANARY_SECRET_FAILURE_MASTER_KEY",
  region: "us-west-004",
  allowLocalFiles: false,
  fileRoot: null,
  destructivePolicy: "confirm",
  outputFormat: "json",
  transport: "stdio",
  credentialFingerprint: "failure-fingerprint",
};
const wrapped = createAuditedToolCallback(
  "b2_list_buckets",
  async () => {
    throw Object.assign(
      new Error("upstream failed B2_MCP_CANARY_SECRET_THROWN_MESSAGE"),
      {
        code: "B2_MCP_CANARY_SECRET_THROWN_CODE",
        status: 503,
        requestId: "B2_MCP_CANARY_SECRET_THROWN_REQUEST",
      },
    );
  },
  config,
);
async function main() {
  try {
    await wrapped(
      {
        bucketName: "failure-bucket",
        secret: "B2_MCP_CANARY_SECRET_THROWN_ARG",
      },
      {},
    );
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        message: err.message,
        code: err.code,
        status: err.status,
        requestId: err.requestId,
      }),
    );
  }
  flushLogsSync();
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
`);
    expectProbeSucceeded(result);
    const thrown = JSON.parse(result.stdout);
    expect(thrown).toMatchObject({
      message: "upstream failed [redacted]",
      code: "[redacted]",
      status: 503,
      requestId: "[redacted]",
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
});
