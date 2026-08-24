import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, expect, it } from "vitest";
import {
  createEvalServerEnv,
  llmEvalGate,
  runEval,
  type Driver,
  type DriverInput,
  type DriverOutput,
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

function signalListenerCounts(): Record<(typeof EVAL_SIGNALS)[number], number> {
  return Object.fromEntries(
    EVAL_SIGNALS.map((signal) => [signal, process.listenerCount(signal)]),
  ) as Record<(typeof EVAL_SIGNALS)[number], number>;
}

describe("LLM eval harness", () => {
  it("runs a bounded tool loop against the built stdio server", async () => {
    const run = await runEval({
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
  });

  it("removes process signal handlers after normal completion", async () => {
    const before = signalListenerCounts();

    await runEval({
      prompt: "Finish without tools.",
      toolNames: ["b2_create_key"],
      driver: new ScriptedDriver("no-tools", [{ text: "Done." }]),
      maxSteps: 1,
    });

    expect(signalListenerCounts()).toEqual(before);
  });

  it("rejects B2 credential overrides before spawning the eval server", () => {
    expect(() =>
      createEvalServerEnv({
        env: { B2_APPLICATION_KEY: "real-looking-credential" },
      }),
    ).toThrow(/non-marker B2 credential/);
  });

  it("rejects unsafe eval server policy overrides", () => {
    expect(() =>
      createEvalServerEnv({
        env: { B2_DESTRUCTIVE_POLICY: "allow" },
      }),
    ).toThrow(/B2_DESTRUCTIVE_POLICY=allow/);
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

  it("refuses local filePath tool calls without touching the target path", async () => {
    const targetPath = join(tmpdir(), `b2-mcp-eval-forbidden-${process.pid}`, "secret.txt");
    expect(existsSync(targetPath)).toBe(false);

    const run = await runEval({
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
  });

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
