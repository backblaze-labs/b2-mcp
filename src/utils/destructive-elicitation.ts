import {
  inputRequired,
  inputResponse,
  type ClientCapabilities,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";
import { toolError } from "./errors.js";
import { destructiveEffect, runWithDestructiveElicitationConsent } from "./destructive-gate.js";
import type { SanitizerOptions } from "./secret-sanitizer.js";
import { sanitizeText, SECRET_SANITIZER_REDACTION } from "./secret-sanitizer.js";

export const DESTRUCTIVE_ELICITATION_RESPONSE_KEY = "destructiveConfirmation";
export const DESTRUCTIVE_ELICITATION_REQUEST_STATE = "b2-mcp-destructive-elicitation-v1";

export type ClientCapabilitiesProvider = () => ClientCapabilities | undefined;

const PROMPT_FIELDS = [
  ["Bucket ID", "bucketId"],
  ["Bucket", "bucket"],
  ["Object key", "key"],
  ["Version ID", "versionId"],
  ["File ID", "fileId"],
  ["File name", "fileName"],
  ["Application key ID", "applicationKeyId"],
  ["Member ID", "memberId"],
  ["Member email", "memberEmail"],
  ["Account email", "email"],
  ["Operation", "operation"],
  ["Expiry seconds", "expiresIn"],
  ["Upload ID", "uploadId"],
] as const;

interface DestructiveElicitationOptions<T> {
  toolName: string;
  args: Record<string, unknown>;
  extra: unknown;
  sanitizerOptions: SanitizerOptions;
  getClientCapabilities?: ClientCapabilitiesProvider;
  runOriginal: () => T | Promise<T>;
}

type ToolErrorResult = ReturnType<typeof toolError>;

export async function maybeRequireDestructiveElicitation<T>({
  toolName,
  args,
  extra,
  sanitizerOptions,
  getClientCapabilities,
  runOriginal,
}: DestructiveElicitationOptions<T>): Promise<T | InputRequiredResult | ToolErrorResult> {
  const effect = destructiveEffect(toolName, args);
  if (!effect || !clientSupportsFormElicitation(extra, getClientCapabilities)) {
    return runOriginal();
  }

  const response = inputResponse(mcpInputResponses(extra), DESTRUCTIVE_ELICITATION_RESPONSE_KEY);
  if (response.kind === "missing") {
    if (hasPendingDestructiveElicitationState(extra)) {
      return destructiveElicitationRefused(toolName, "human confirmation was not provided");
    }
    return inputRequired({
      inputRequests: {
        [DESTRUCTIVE_ELICITATION_RESPONSE_KEY]: inputRequired.elicit({
          message: destructiveElicitationMessage(toolName, effect, args, sanitizerOptions),
          requestedSchema: {
            type: "object",
            properties: {
              confirm: {
                type: "boolean",
                title: "Approve",
                description: "Approve this destructive B2 operation.",
                default: false,
              },
            },
            required: ["confirm"],
          },
        }),
      },
      requestState: DESTRUCTIVE_ELICITATION_REQUEST_STATE,
    });
  }

  if (response.kind !== "elicit") {
    return destructiveElicitationRefused(toolName, "human confirmation response was invalid");
  }

  if (response.action !== "accept") {
    return destructiveElicitationRefused(toolName, `human confirmation was ${response.action}`);
  }

  if (response.content?.confirm !== true) {
    return destructiveElicitationRefused(toolName, "human confirmation did not approve");
  }

  return runWithDestructiveElicitationConsent(toolName, effect, runOriginal);
}

export function clientSupportsFormElicitation(
  extra: unknown,
  getClientCapabilities?: ClientCapabilitiesProvider,
): boolean {
  const capabilities = mcpClientCapabilities(extra) ?? getClientCapabilities?.();
  const elicitation = capabilities?.elicitation;
  if (!elicitation || typeof elicitation !== "object" || Array.isArray(elicitation)) {
    return false;
  }
  const keys = Object.keys(elicitation);
  if (keys.length === 0) return true;
  return Object.prototype.hasOwnProperty.call(elicitation, "form");
}

export function destructiveElicitationMessage(
  toolName: string,
  effect: string,
  args: Record<string, unknown>,
  sanitizerOptions: SanitizerOptions = {},
): string {
  const parts = [
    `${toolName} would ${sanitizeText(effect, sanitizerOptions)}.`,
    ...destructiveElicitationDetails(args, sanitizerOptions),
    "Approve this destructive B2 operation?",
  ];
  return parts.join(" ");
}

function destructiveElicitationDetails(
  args: Record<string, unknown>,
  sanitizerOptions: SanitizerOptions,
): string[] {
  const details = PROMPT_FIELDS.flatMap(([label, key]) =>
    promptDetail(label, args[key], sanitizerOptions),
  );
  details.push(
    ...promptDetail("Object count", arrayCount(args.objects), sanitizerOptions),
    ...promptDetail("Rule count", arrayCount(args.rules), sanitizerOptions),
    ...promptDetail(
      "Notification rule count",
      arrayCount(args.eventNotificationRules),
      sanitizerOptions,
    ),
    ...promptDetail(
      "Deletion rule count",
      lifecycleDeletionRuleCount(args.rules),
      sanitizerOptions,
    ),
  );
  if (args.bypassGovernance === true) details.push("Governance bypass requested.");

  return details;
}

function destructiveElicitationRefused(toolName: string, reason: string): ToolErrorResult {
  return toolError(
    new Error(
      `Refused: ${toolName} requires explicit human approval by MCP elicitation; ${reason}.`,
    ),
  );
}

function safePromptValue(value: unknown, sanitizerOptions: SanitizerOptions): string | null {
  if (value === undefined || value === null) return null;
  if (!["string", "number", "boolean"].includes(typeof value)) return null;
  const text = sanitizeText(String(value), sanitizerOptions).replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.includes(SECRET_SANITIZER_REDACTION)) return SECRET_SANITIZER_REDACTION;
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function promptDetail(label: string, value: unknown, sanitizerOptions: SanitizerOptions): string[] {
  const safe = safePromptValue(value, sanitizerOptions);
  return safe ? [`${label}: ${safe}.`] : [];
}

function arrayCount(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function lifecycleDeletionRuleCount(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (rule) =>
      rule &&
      typeof rule === "object" &&
      ("expiration" in rule || "noncurrentVersionExpiration" in rule),
  ).length;
}

function mcpInputResponses(extra: unknown): Record<string, unknown> | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const mcpReq = (extra as { mcpReq?: { inputResponses?: Record<string, unknown> } }).mcpReq;
  return mcpReq?.inputResponses;
}

function mcpClientCapabilities(extra: unknown): ClientCapabilities | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const mcpReq = (
    extra as {
      mcpReq?: {
        clientCapabilities?: ClientCapabilities;
        envelope?: Record<string, unknown>;
      };
      clientCapabilities?: ClientCapabilities;
    }
  ).mcpReq;
  return (
    mcpReq?.clientCapabilities ??
    (mcpReq?.envelope?.["io.modelcontextprotocol/clientCapabilities"] as
      | ClientCapabilities
      | undefined) ??
    (extra as { clientCapabilities?: ClientCapabilities }).clientCapabilities
  );
}

function hasPendingDestructiveElicitationState(extra: unknown): boolean {
  if (!extra || typeof extra !== "object") return false;
  const requestState = (extra as { mcpReq?: { requestState?: () => unknown } }).mcpReq
    ?.requestState;
  return requestState?.() === DESTRUCTIVE_ELICITATION_REQUEST_STATE;
}
