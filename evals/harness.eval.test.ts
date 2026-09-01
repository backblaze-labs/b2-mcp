import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { describe, expect, it } from "vitest";
import {
  EVAL_SERVER_NETWORK_GUARD_ENV,
  createEvalServerEnv,
  llmEvalGate,
  runEval,
  type Driver,
  type DriverInput,
  type DriverOutput,
  type EvalTransport,
  type EvalToolCall,
} from "./harness";

class ScriptedDriver implements Driver {
  readonly name: string;
  private step = 0;

  constructor(
    name: string,
    private readonly responses: DriverOutput[],
  ) {
    this.name = name;
  }

  async complete(_input: DriverInput): Promise<DriverOutput> {
    const response = this.responses[this.step] ?? { text: "Done." };
    this.step += 1;
    return response;
  }
}

function oneStepDriver(name: string, toolCalls: EvalToolCall[]): Driver {
  return new ScriptedDriver(name, [{ text: `${name} step`, toolCalls }]);
}

const EVAL_SIGNALS = ["SIGINT", "SIGTERM"] as const;
const EVAL_TEST_TRANSPORTS = ["stdio", "http"] as const satisfies readonly EvalTransport[];

function signalListenerCounts(): Record<(typeof EVAL_SIGNALS)[number], number> {
  return Object.fromEntries(
    EVAL_SIGNALS.map((signal) => [signal, process.listenerCount(signal)]),
  ) as Record<(typeof EVAL_SIGNALS)[number], number>;
}

describe("LLM eval harness", () => {
  it.each(EVAL_TEST_TRANSPORTS)(
    "runs a bounded tool loop against the built %s server",
    async (transport) => {
      const run = await runEval({
        transport,
        prompt: "Check whether bucket deletion is guarded.",
        toolNames: ["b2_delete_bucket"],
        driver: oneStepDriver("destructive-block", [
          { name: "b2_delete_bucket", args: { bucketId: "bucket-id", confirm: true } },
        ]),
        maxSteps: 2,
      });

      expect(run.toolCalls).toEqual([
        { name: "b2_delete_bucket", args: { bucketId: "bucket-id", confirm: true } },
      ]);
      expect(run.toolResults).toHaveLength(1);
      expect(run.toolResults[0].isError).toBe(true);
      expect(JSON.stringify(run.toolResults[0])).toContain("destructive_policy_blocked");
      expect(run.text).toContain("destructive-block step");
    },
  );

  it.each(EVAL_TEST_TRANSPORTS)(
    "removes process signal handlers after normal %s completion",
    async (transport) => {
      const before = signalListenerCounts();

      await runEval({
        transport,
        prompt: "Finish without tools.",
        toolNames: ["b2_create_key"],
        driver: new ScriptedDriver("no-tools", [{ text: "Done." }]),
        maxSteps: 1,
      });

      expect(signalListenerCounts()).toEqual(before);
    },
  );

  it("rejects B2 credential overrides before spawning the eval server", () => {
    expect(() =>
      createEvalServerEnv({
        env: { B2_APPLICATION_KEY: "real-looking-credential" },
      }),
    ).toThrow(/non-marker B2 credential/);
  });

  it("allows explicit destructive-policy eval coverage only through the typed option", () => {
    expect(createEvalServerEnv({ destructivePolicy: "allow" }).B2_DESTRUCTIVE_POLICY).toBe("allow");
    expect(() =>
      createEvalServerEnv({
        env: { B2_DESTRUCTIVE_POLICY: "allow" },
      }),
    ).toThrow(/requires B2_DESTRUCTIVE_POLICY=block/);
    expect(() =>
      createEvalServerEnv({
        destructivePolicy: "confirm",
        env: { B2_DESTRUCTIVE_POLICY: "allow" },
      }),
    ).toThrow(/requires B2_DESTRUCTIVE_POLICY=confirm/);
  });

  it("rejects unsafe eval server filesystem and secret-sink overrides", () => {
    expect(() =>
      createEvalServerEnv({
        env: { B2_ALLOW_LOCAL_FILES: "true" },
      }),
    ).toThrow(/B2_ALLOW_LOCAL_FILES=false/);
    expect(() =>
      createEvalServerEnv({
        env: { B2_SECRET_SINK: "file" },
      }),
    ).toThrow(/B2_SECRET_SINK=off/);
  });

  it("can block outbound network in the eval server child process", () => {
    const previous = process.env[EVAL_SERVER_NETWORK_GUARD_ENV];
    process.env[EVAL_SERVER_NETWORK_GUARD_ENV] = "1";
    try {
      const env = createEvalServerEnv();

      expect(env.NODE_OPTIONS).toContain("--import");
      expect(env.NODE_OPTIONS).toContain("scripts/no-network-guard.mjs");

      const blocked = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", 'await fetch("https://example.com")'],
        { env, encoding: "utf8" },
      );
      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain("MCP_CLIENT_SMOKE_NETWORK_BLOCKED:fetch");

      const missingGuard = spawnSync(process.execPath, ["-e", 'console.log("unguarded")'], {
        env: {
          ...env,
          NODE_OPTIONS: env.NODE_OPTIONS.replace(
            "scripts/no-network-guard.mjs",
            "scripts/missing-no-network-guard.mjs",
          ),
        },
        encoding: "utf8",
      });
      expect(missingGuard.status).not.toBe(0);
      expect(missingGuard.stdout).not.toContain("unguarded");
    } finally {
      if (previous === undefined) {
        delete process.env[EVAL_SERVER_NETWORK_GUARD_ENV];
      } else {
        process.env[EVAL_SERVER_NETWORK_GUARD_ENV] = previous;
      }
    }
  });

  it("rejects unexposed tool calls before execution", async () => {
    await expect(
      runEval({
        prompt: "Try an unexposed tool.",
        toolNames: ["b2_create_key"],
        driver: oneStepDriver("unexposed", [
          { name: "b2_delete_bucket", args: { bucketId: "bucket-id", confirm: true } },
        ]),
        maxSteps: 1,
      }),
    ).rejects.toThrow(/requested unexposed tool: b2_delete_bucket/);
  });

  it("rejects per-step tool-call budget excess before execution", async () => {
    await expect(
      runEval({
        prompt: "Try too many calls.",
        toolNames: ["b2_create_key"],
        driver: oneStepDriver("over-budget", [
          { name: "b2_create_key", args: { confirm: true } },
          { name: "b2_create_key", args: { confirm: true } },
        ]),
        maxSteps: 1,
        maxToolCallsPerStep: 1,
      }),
    ).rejects.toThrow(/exceeded maxToolCallsPerStep/);
  });

  it("rejects total tool-call budget excess before execution", async () => {
    await expect(
      runEval({
        prompt: "Try too many calls across steps.",
        toolNames: ["b2_create_key"],
        driver: new ScriptedDriver("over-total", [
          {
            text: "first",
            toolCalls: [{ name: "b2_create_key", args: { confirm: true } }],
          },
          {
            text: "second",
            toolCalls: [{ name: "b2_create_key", args: { confirm: true } }],
          },
        ]),
        maxSteps: 2,
        maxToolCallsTotal: 1,
      }),
    ).rejects.toThrow(/exceeded maxToolCallsTotal/);
  });

  it.each(EVAL_TEST_TRANSPORTS)(
    "refuses local filePath tool calls over %s without touching the target path",
    async (transport) => {
      const targetPath = join(tmpdir(), `b2-mcp-eval-forbidden-${process.pid}`, "secret.txt");
      expect(existsSync(targetPath)).toBe(false);

      const run = await runEval({
        transport,
        prompt: "Try a local file upload.",
        toolNames: ["s3_put_object"],
        driver: oneStepDriver("local-file", [
          {
            name: "s3_put_object",
            args: {
              bucket: "bucket",
              key: "secret.txt",
              filePath: targetPath,
              contentType: "application/octet-stream",
            },
          },
        ]),
        maxSteps: 1,
      });

      expect(run.toolResults[0].isError).toBe(true);
      expect(JSON.stringify(run.toolResults[0])).toContain("Local filesystem access is disabled");
      expect(existsSync(targetPath)).toBe(false);
    },
  );

  it("times out stalled driver steps with a phase-specific error", async () => {
    const before = signalListenerCounts();
    const stalledDriver: Driver = {
      name: "stalled",
      async complete() {
        return new Promise<DriverOutput>(() => undefined);
      },
    };

    await expect(
      runEval({
        prompt: "Stall.",
        toolNames: ["b2_create_key"],
        driver: stalledDriver,
        maxSteps: 1,
        timeouts: { driverStepMs: 10 },
      }),
    ).rejects.toThrow(/Timed out during driver step 1/);
    expect(signalListenerCounts()).toEqual(before);
  });

  it("keeps provider key requirements outside the shared gate default", () => {
    expect(llmEvalGate({ RUN_LLM_EVALS: "1" }).enabled).toBe(true);
    expect(
      llmEvalGate(
        { RUN_LLM_EVALS: "1" },
        { providerKeyEnvNames: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] },
      ),
    ).toEqual({
      enabled: false,
      reason: "missing provider key (OPENAI_API_KEY or ANTHROPIC_API_KEY)",
    });
    expect(
      llmEvalGate(
        { RUN_LLM_EVALS: "1", OPENAI_API_KEY: "test-key" },
        { providerKeyEnvNames: ["OPENAI_API_KEY"] },
      ).enabled,
    ).toBe(true);
  });
});
