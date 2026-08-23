import { describe, expect, it } from "vitest";
import { llmEvalGate, runEval, type Driver } from "./harness";

const gate = llmEvalGate();
const describeIfEnabled = gate.enabled ? describe : describe.skip;

class ScriptedDriver implements Driver {
  readonly name = "scripted";
  private step = 0;

  async complete() {
    this.step += 1;
    if (this.step === 1) {
      return {
        text: "Checking durable-secret policy behavior.",
        toolCalls: [{ name: "b2_create_key", args: { confirm: true } }],
      };
    }
    return { text: "Done." };
  }
}

describeIfEnabled("LLM eval harness", () => {
  it("runs a bounded tool loop against the built stdio server", async () => {
    const run = await runEval({
      prompt: "Check whether durable key creation is available.",
      toolNames: ["b2_create_key"],
      driver: new ScriptedDriver(),
      maxSteps: 2,
    });

    expect(run.toolCalls).toEqual([{ name: "b2_create_key", args: { confirm: true } }]);
    expect(run.toolResults).toHaveLength(1);
    expect(run.text).toContain("Checking durable-secret policy behavior.");
  });
});
