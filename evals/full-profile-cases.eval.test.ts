import { describe, expect, it } from "vitest";
import { FULL_PROFILE_EVAL_CASES, evalCaseRunOptions, type EvalCase } from "./cases";
import { runEval, type Driver, type DriverInput, type DriverOutput } from "./harness";

class ScriptedCaseDriver implements Driver {
  readonly name = "scripted-full-profile";
  private step = 0;

  constructor(private readonly evalCase: EvalCase) {}

  async complete(_input: DriverInput): Promise<DriverOutput> {
    if (this.step > 0) return { text: "Done." };
    this.step += 1;
    return {
      text: `Calling ${this.evalCase.expected.toolName}.`,
      toolCalls: [
        {
          name: this.evalCase.expected.toolName,
          args: { ...this.evalCase.expected.args },
        },
      ],
    };
  }
}

describe("full-profile scripted eval cases", () => {
  it.each(FULL_PROFILE_EVAL_CASES)(
    "$name accepts the scripted expected tool call",
    async (evalCase) => {
      const run = await runEval(evalCaseRunOptions(evalCase, new ScriptedCaseDriver(evalCase)));

      expect(evalCase.passed(run), evalCase.failureSummary(run)).toBe(true);
    },
    30_000,
  );
});
