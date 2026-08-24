import { FULL_PROFILE_EVAL_CASES, type EvalCase } from "../../evals/cases";
import { readJson } from "./support";

interface EvalCoverageContract {
  readonly profiles: {
    readonly full: {
      readonly names: string[];
      readonly requiredFields: Record<string, string[]>;
      readonly confirmTools: string[];
    };
  };
}

const contract = readJson<EvalCoverageContract>("docs/tool-profile-contract.json");
const fullProfile = contract.profiles.full;
const fullToolNames = new Set(fullProfile.names);
const confirmTools = new Set(fullProfile.confirmTools);

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function toolNamesFromCases(cases: readonly EvalCase[]): Set<string> {
  return new Set(cases.map((evalCase) => evalCase.expected.toolName));
}

function missingFullProfileTools(cases: readonly EvalCase[]): string[] {
  const covered = toolNamesFromCases(cases);
  return fullProfile.names.filter((name) => !covered.has(name));
}

function orphanCaseToolNames(cases: readonly EvalCase[]): string[] {
  const referenced = new Set<string>();
  for (const evalCase of cases) {
    referenced.add(evalCase.expected.toolName);
    for (const toolName of evalCase.toolNames) referenced.add(toolName);
  }
  return sorted([...referenced].filter((toolName) => !fullToolNames.has(toolName)));
}

describe("full-profile LLM eval coverage", () => {
  it("has at least one eval case for every full-profile tool", () => {
    expect(missingFullProfileTools(FULL_PROFILE_EVAL_CASES)).toEqual([]);
  });

  it("does not reference tools outside the full profile", () => {
    expect(orphanCaseToolNames(FULL_PROFILE_EVAL_CASES)).toEqual([]);
  });

  it("keeps each case bound to one expected tool and its required arguments", () => {
    for (const evalCase of FULL_PROFILE_EVAL_CASES) {
      const { expected } = evalCase;
      expect(evalCase.toolNames).toEqual([expected.toolName]);
      expect(sorted(expected.requiredArgs)).toEqual(fullProfile.requiredFields[expected.toolName]);
      for (const requiredArg of expected.requiredArgs) {
        expect(expected.args).toHaveProperty(requiredArg);
      }
      expect(["mcp-error", "structured-json"]).toContain(expected.result.kind);
    }
  });

  it("runs destructive full-profile cases with the eval allow policy", () => {
    for (const evalCase of FULL_PROFILE_EVAL_CASES) {
      if (!confirmTools.has(evalCase.expected.toolName)) continue;
      expect(evalCase.server?.destructivePolicy).toBe("allow");
      expect(evalCase.expected.args.confirm).toBe(true);
    }
  });
});
