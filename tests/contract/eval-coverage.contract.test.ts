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
const allowedAnyMcpErrorTools = [
  "b2_authorize_account",
  "b2_create_bucket",
  "b2_delete_bucket",
  "b2_delete_key",
  "b2_egress_leaders",
  "b2_eject_group_member",
  "b2_get_bucket_notification_rules",
  "b2_largest_files",
  "b2_list_buckets",
  "b2_list_group_members",
  "b2_list_groups",
  "b2_list_keys",
  "b2_set_bucket_notification_rules",
  "b2_unfinished_uploads",
  "b2_update_bucket",
  "b2_update_file_legal_hold",
  "b2_update_file_retention",
  "b2_usage_growth",
  "s3_abort_multipart_upload",
  "s3_complete_multipart_upload",
  "s3_copy_object",
  "s3_create_multipart_upload",
  "s3_delete_object",
  "s3_get_bucket_location",
  "s3_get_object",
  "s3_head_bucket",
  "s3_head_object",
  "s3_list_multipart_uploads",
  "s3_list_object_versions",
  "s3_list_objects_v2",
  "s3_list_parts",
  "s3_put_bucket_lifecycle",
  "s3_put_object",
  "s3_upload_part_copy",
];
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
      expect(["any-mcp-error", "mcp-error", "structured-json"]).toContain(expected.result.kind);
    }
  });

  it("limits broad any-MCP-error matching to reviewed marker-credential cases", () => {
    const broadMatcherTools: string[] = [];
    for (const evalCase of FULL_PROFILE_EVAL_CASES) {
      const { result } = evalCase.expected;
      if (result.kind !== "any-mcp-error") continue;
      expect(result.reason).toContain("Marker credentials");
      broadMatcherTools.push(evalCase.expected.toolName);
    }

    expect(sorted(broadMatcherTools)).toEqual(allowedAnyMcpErrorTools);
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
