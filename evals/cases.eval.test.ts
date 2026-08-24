import { describe, expect, it } from "vitest";
import { FULL_PROFILE_EVAL_CASES, type EvalCase } from "./cases";
import type { EvalRun } from "./harness";

function caseFor(toolName: string): EvalCase {
  const evalCase = FULL_PROFILE_EVAL_CASES.find(
    (candidate) => candidate.expected.toolName === toolName,
  );
  if (!evalCase) throw new Error(`Missing eval case for ${toolName}`);
  return evalCase;
}

function runFor(evalCase: EvalCase, extraArgs: Record<string, unknown>): EvalRun {
  const { result } = evalCase.expected;
  return {
    toolCalls: [
      {
        name: evalCase.expected.toolName,
        args: { ...evalCase.expected.args, ...extraArgs },
      },
    ],
    toolResults:
      result.kind === "structured-json"
        ? [
            {
              structuredContent: {
                ...(result.structuredFields ?? {}),
              },
              content: [
                {
                  type: "text",
                  text: [
                    JSON.stringify(result.structuredFields ?? {}),
                    ...(result.textIncludes ?? []),
                  ].join(" "),
                },
              ],
            },
          ]
        : [
            {
              isError: true,
              content: [{ type: "text", text: result.textIncludes.join(" ") }],
            },
          ],
    text: "Done.",
  };
}

describe("eval case assertions", () => {
  it("rejects local file upload mass-assignment arguments", () => {
    const evalCase = caseFor("s3_put_object");

    expect(evalCase.passed(runFor(evalCase, {}))).toBe(true);
    expect(evalCase.passed(runFor(evalCase, { filePath: "/etc/passwd" }))).toBe(false);
  });

  it("rejects local file download mass-assignment arguments", () => {
    const evalCase = caseFor("s3_get_object");

    expect(evalCase.passed(runFor(evalCase, {}))).toBe(true);
    expect(evalCase.passed(runFor(evalCase, { saveToPath: "/tmp/b2-leak" }))).toBe(false);
  });

  it("rejects destructive scope-expansion arguments", () => {
    const evalCase = caseFor("s3_delete_objects");

    expect(evalCase.passed(runFor(evalCase, {}))).toBe(true);
    expect(evalCase.passed(runFor(evalCase, { bypassGovernance: true }))).toBe(false);
  });
});
