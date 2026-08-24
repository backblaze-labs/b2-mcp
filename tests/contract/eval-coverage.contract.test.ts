import { FULL_PROFILE_EVAL_CASES, type EvalCase } from "../../evals/cases";
import { checkDestructive } from "../../src/utils/destructive-gate";
import type { B2Config } from "../../src/utils/types";
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
const gateConfig = {
  applicationKeyId: "eval-application-key-id",
  applicationKey: "eval-application-key-secret",
  appKeyId: "eval-app-key-id",
  appKey: "eval-app-key-secret",
  masterKeyId: "eval-master-key-id",
  masterKey: "eval-master-key-secret",
  region: "us-west-004",
  allowLocalFiles: false,
  fileRoot: null,
} satisfies B2Config;

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

function caseFor(toolName: string): EvalCase {
  const evalCase = FULL_PROFILE_EVAL_CASES.find(
    (candidate) => candidate.expected.toolName === toolName,
  );
  if (!evalCase) throw new Error(`Missing eval case for ${toolName}`);
  return evalCase;
}

function argsWithoutConfirm(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const copy = { ...args };
  delete copy.confirm;
  return copy;
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

  it("pins every MCP error result to non-empty text snippets", () => {
    for (const evalCase of FULL_PROFILE_EVAL_CASES) {
      const { result } = evalCase.expected;
      if (result.kind !== "mcp-error") continue;
      expect(result.textIncludes.length).toBeGreaterThanOrEqual(2);
      for (const snippet of result.textIncludes) {
        expect(snippet.trim()).toBe(snippet);
        expect(snippet.length).toBeGreaterThan(0);
      }
    }
  });

  it("uses allow policy only for destructive tool-shape coverage", () => {
    for (const evalCase of FULL_PROFILE_EVAL_CASES) {
      if (!confirmTools.has(evalCase.expected.toolName)) continue;
      expect(evalCase.server?.destructivePolicy).toBe("allow");
      expect(evalCase.expected.args.confirm).toBe(true);
    }
  });

  it("blocks every confirmTool under the default block policy", () => {
    for (const toolName of fullProfile.confirmTools) {
      const evalCase = caseFor(toolName);
      const decision = checkDestructive(toolName, evalCase.expected.args, {
        ...gateConfig,
        destructivePolicy: "block",
      });

      expect(decision).toMatchObject({
        ok: false,
        error: { status: 403, code: "destructive_policy_blocked" },
      });
    }
  });

  it("requires confirmation for every confirmTool under confirm policy", () => {
    for (const toolName of fullProfile.confirmTools) {
      const evalCase = caseFor(toolName);
      const decision = checkDestructive(toolName, argsWithoutConfirm(evalCase.expected.args), {
        ...gateConfig,
        destructivePolicy: "confirm",
      });

      expect(decision).toMatchObject({
        ok: false,
        error: { status: 409, code: "destructive_confirmation_required" },
      });
    }
  });
});
