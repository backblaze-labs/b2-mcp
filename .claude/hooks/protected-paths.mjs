#!/usr/bin/env node

/* global console, process */

// PreToolUse hook: ask the person running the session before Claude edits a
// security, supply-chain or release policy file. CODEOWNERS review at the PR is
// the gate for every other tool and contributor.

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const protectedPaths = [
  {
    pattern: /^(audit-policy|supply-chain-denylist|package-budget|runtime-policy)\.json$/,
    reason:
      "is a supply-chain or runtime policy file. Exceptions need a dated reason, an expiry and Quality Keeper review (docs/design-docs/supply-chain-security.md).",
  },
  {
    pattern: /^\.github\/(workflows\/|CODEOWNERS$|branch-protection-main\.json$|dependabot\.yml$)/,
    reason:
      "is a CI, release or review gate. Keep pinned action SHAs with version comments, least-privilege permissions and the Dependabot job guard, and update tests/contract/ci-workflow-policy.contract.test.ts.",
  },
  {
    pattern: /^zizmor\.yml$/,
    reason:
      "suppresses workflow-security findings. Each suppression needs a tight scope and a reason.",
  },
  {
    pattern: /^\.claude\/(settings\.json|hooks\/)/,
    reason:
      "configures the hooks that guard agent sessions. An agent must not weaken its own gate.",
  },
];

function decide(decision, reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  decide("ask", "protected-paths hook could not parse the tool call; confirm this edit by hand.");
}

const filePath = input?.tool_input?.file_path;
if (typeof filePath !== "string") process.exit(0);

const rel = relative(root, resolve(root, filePath)).split("\\").join("/");
const match = protectedPaths.find(({ pattern }) => pattern.test(rel));
if (match) decide("ask", `${rel} ${match.reason} Approve only if this change is intended.`);
process.exit(0);
