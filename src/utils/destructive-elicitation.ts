import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  PROTOCOL_VERSION_META_KEY,
  type ClientCapabilities,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";
import { createHmac, timingSafeEqual } from "crypto";
import { toolError } from "./errors.js";
import {
  destructiveEffect,
  getDestructivePolicy,
  runWithDestructiveElicitationConsent,
} from "./destructive-gate.js";
import { logger } from "./logger.js";
import type { SanitizerOptions } from "./secret-sanitizer.js";
import { sanitizeText, SECRET_SANITIZER_REDACTION } from "./secret-sanitizer.js";
import type { B2Config } from "./types.js";

export const DESTRUCTIVE_ELICITATION_RESPONSE_KEY = "destructiveConfirmation";
export const DESTRUCTIVE_ELICITATION_REQUEST_STATE = "b2-mcp-destructive-elicitation-v1";

export type ClientCapabilitiesProvider = () => ClientCapabilities | undefined;
export type ProtocolVersionProvider = () => string | undefined;

export interface DestructiveElicitationContextProviders {
  getClientCapabilities?: ClientCapabilitiesProvider;
  getProtocolVersion?: ProtocolVersionProvider;
}

interface McpRequestExtra {
  clientCapabilities?: ClientCapabilities;
  mcpReq?: {
    inputResponses?: Record<string, unknown>;
    requestState?: string | (() => unknown);
    clientCapabilities?: ClientCapabilities;
    envelope?: Record<string, unknown>;
  };
}

interface DestructiveElicitationState {
  v: 1;
  toolName: string;
  effect: string;
  argsDigest: string;
  issuedAt: number;
}

type ElicitationDecision = "requested" | "accepted" | "refused";
type StateVerification =
  | { ok: true; state: DestructiveElicitationState }
  | { ok: false; reason: string };

const DESTRUCTIVE_ELICITATION_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const DESTRUCTIVE_ELICITATION_ENV = "B2_DESTRUCTIVE_ELICITATION";
const RETURN_BASED_INPUT_PROTOCOL_VERSION = "2026-07-28";

// Prompt coverage is pinned by tests that enumerate DESTRUCTIVE_TOOL_NAMES and
// assert representative destructive args surface concrete, sanitized details.
const PROMPT_FIELDS = [
  ["Bucket ID", "bucketId"],
  ["Bucket", "bucket"],
  ["Object key", "key"],
  ["Version ID", "versionId"],
  ["File ID", "fileId"],
  ["File name", "fileName"],
  ["Application key ID", "applicationKeyId"],
  ["Admin account ID", "adminAccountId"],
  ["Group ID", "groupId"],
  ["Member account ID", "memberAccountId"],
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
  config: B2Config;
  sanitizerOptions: SanitizerOptions;
  contextProviders?: DestructiveElicitationContextProviders;
  runOriginal: () => T | Promise<T>;
}

type ToolErrorResult = ReturnType<typeof toolError>;

export async function maybeRequireDestructiveElicitation<T>({
  toolName,
  args,
  extra,
  config,
  sanitizerOptions,
  contextProviders,
  runOriginal,
}: DestructiveElicitationOptions<T>): Promise<T | InputRequiredResult | ToolErrorResult> {
  const effect = destructiveEffect(toolName, args);
  if (!effect) {
    return runOriginal();
  }

  const policy = getDestructivePolicy(config);
  const requestExtra = mcpRequestExtra(extra);
  const hasElicitationRetry =
    mcpInputResponses(requestExtra) !== undefined || mcpRequestState(requestExtra) !== undefined;
  if (
    policy !== "confirm" ||
    (args.confirm === true && !hasElicitationRetry) ||
    !destructiveElicitationEnabled() ||
    !clientCanUseReturnBasedElicitation(requestExtra, contextProviders)
  ) {
    return runOriginal();
  }

  const response = inputResponse(
    mcpInputResponses(requestExtra),
    DESTRUCTIVE_ELICITATION_RESPONSE_KEY,
  );
  if (response.kind === "missing") {
    if (mcpRequestState(requestExtra) !== undefined) {
      return destructiveElicitationRefused(toolName, effect, "human confirmation was not provided");
    }
    const requestState = mintDestructiveElicitationState(config, toolName, effect, args);
    logDestructiveElicitation(toolName, effect, "requested", sanitizerOptions);
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
      requestState,
    });
  }

  const state = verifyDestructiveElicitationState(
    config,
    mcpRequestState(requestExtra),
    toolName,
    effect,
    args,
  );
  if (!state.ok) {
    return destructiveElicitationRefused(toolName, effect, state.reason);
  }

  if (response.kind !== "elicit") {
    return destructiveElicitationRefused(
      toolName,
      effect,
      "human confirmation response was invalid",
    );
  }

  if (response.action !== "accept") {
    return destructiveElicitationRefused(
      toolName,
      effect,
      `human confirmation was ${response.action}`,
    );
  }

  if (response.content?.confirm !== true) {
    return destructiveElicitationRefused(toolName, effect, "human confirmation did not approve");
  }

  logDestructiveElicitation(toolName, effect, "accepted", sanitizerOptions);
  return runWithDestructiveElicitationConsent(toolName, effect, runOriginal);
}

export function clientCanUseReturnBasedElicitation(
  extra: unknown,
  contextProviders?: DestructiveElicitationContextProviders,
): boolean {
  const requestExtra = mcpRequestExtra(extra);
  return (
    requestSupportsReturnBasedInput(requestExtra, contextProviders) &&
    clientSupportsFormElicitation(requestExtra, contextProviders?.getClientCapabilities)
  );
}

export function clientSupportsFormElicitation(
  extra: McpRequestExtra | unknown,
  getClientCapabilities?: ClientCapabilitiesProvider,
): boolean {
  const requestExtra = mcpRequestExtra(extra);
  const capabilities = mcpClientCapabilities(requestExtra) ?? getClientCapabilities?.();
  const elicitation = capabilities?.elicitation;
  if (!elicitation || typeof elicitation !== "object" || Array.isArray(elicitation)) {
    return false;
  }
  const keys = Object.keys(elicitation);
  // SDK v2 treats a bare `elicitation: {}` as the default form mode.
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

function destructiveElicitationRefused(
  toolName: string,
  effect: string,
  reason: string,
): ToolErrorResult {
  logDestructiveElicitation(toolName, effect, "refused", undefined, reason);
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

function destructiveElicitationEnabled(): boolean {
  const value = process.env[DESTRUCTIVE_ELICITATION_ENV];
  return !value || !["0", "false", "off"].includes(value.trim().toLowerCase());
}

function mcpRequestExtra(extra: unknown): McpRequestExtra {
  if (!extra || typeof extra !== "object") return {};
  return extra as McpRequestExtra;
}

function mcpInputResponses(extra: McpRequestExtra): Record<string, unknown> | undefined {
  return extra?.mcpReq?.inputResponses;
}

function mcpClientCapabilities(extra: McpRequestExtra): ClientCapabilities | undefined {
  const mcpReq = extra?.mcpReq;
  return (
    mcpReq?.clientCapabilities ??
    (mcpReq?.envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined) ??
    extra?.clientCapabilities
  );
}

function mcpProtocolVersion(
  extra: McpRequestExtra,
  contextProviders?: DestructiveElicitationContextProviders,
): string | undefined {
  const version = extra?.mcpReq?.envelope?.[PROTOCOL_VERSION_META_KEY];
  return typeof version === "string" ? version : contextProviders?.getProtocolVersion?.();
}

function mcpRequestState(extra: McpRequestExtra): unknown {
  const requestState = extra?.mcpReq?.requestState;
  return typeof requestState === "function" ? requestState() : requestState;
}

function requestSupportsReturnBasedInput(
  extra: McpRequestExtra,
  contextProviders?: DestructiveElicitationContextProviders,
): boolean {
  return mcpProtocolVersion(extra, contextProviders) === RETURN_BASED_INPUT_PROTOCOL_VERSION;
}

function mintDestructiveElicitationState(
  config: B2Config,
  toolName: string,
  effect: string,
  args: Record<string, unknown>,
): string {
  const payload: DestructiveElicitationState = {
    v: 1,
    toolName,
    effect,
    argsDigest: destructiveArgsDigest(config, args),
    issuedAt: Date.now(),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${DESTRUCTIVE_ELICITATION_REQUEST_STATE}.${encodedPayload}.${destructiveStateSignature(
    config,
    encodedPayload,
  )}`;
}

function verifyDestructiveElicitationState(
  config: B2Config,
  requestState: unknown,
  toolName: string,
  effect: string,
  args: Record<string, unknown>,
): StateVerification {
  if (typeof requestState !== "string") return { ok: false, reason: "requestState is missing" };

  const [prefix, encodedPayload, signature, extra] = requestState.split(".");
  if (prefix !== DESTRUCTIVE_ELICITATION_REQUEST_STATE || !encodedPayload || !signature || extra) {
    return { ok: false, reason: "requestState was malformed" };
  }
  if (!safeEqual(signature, destructiveStateSignature(config, encodedPayload))) {
    return { ok: false, reason: "requestState integrity check failed" };
  }

  const state = parseDestructiveElicitationState(encodedPayload);
  if (!state) return { ok: false, reason: "requestState payload was invalid" };
  if (Date.now() - state.issuedAt > DESTRUCTIVE_ELICITATION_STATE_MAX_AGE_MS) {
    return { ok: false, reason: "requestState expired" };
  }
  if (
    state.toolName !== toolName ||
    state.effect !== effect ||
    state.argsDigest !== destructiveArgsDigest(config, args)
  ) {
    return { ok: false, reason: "approved destructive target did not match this call" };
  }

  return { ok: true, state };
}

function parseDestructiveElicitationState(
  encodedPayload: string,
): DestructiveElicitationState | null {
  try {
    const state = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as {
      v?: unknown;
      toolName?: unknown;
      effect?: unknown;
      argsDigest?: unknown;
      issuedAt?: unknown;
    };
    if (
      state?.v !== 1 ||
      typeof state.toolName !== "string" ||
      typeof state.effect !== "string" ||
      typeof state.argsDigest !== "string" ||
      typeof state.issuedAt !== "number"
    ) {
      return null;
    }
    return state as DestructiveElicitationState;
  } catch {
    return null;
  }
}

function destructiveStateSignature(config: B2Config, encodedPayload: string): string {
  return createHmac("sha256", destructiveElicitationKey(config))
    .update("b2-mcp-destructive-elicitation-state\0")
    .update(encodedPayload)
    .digest("base64url");
}

function destructiveArgsDigest(config: B2Config, args: Record<string, unknown>): string {
  return createHmac("sha256", destructiveElicitationKey(config))
    .update("b2-mcp-destructive-elicitation-args\0")
    .update(canonicalJson(securityRelevantArgs(args)))
    .digest("base64url");
}

function destructiveElicitationKey(config: B2Config): string {
  return [config.applicationKey, config.appKey, config.masterKey, config.credentialFingerprint]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\0");
}

function securityRelevantArgs(args: Record<string, unknown>): Record<string, unknown> {
  const relevant = { ...args };
  delete relevant.confirm;
  return relevant;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;

  const object = value as Record<string, unknown>;
  const entries = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${entries.join(",")}}`;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Uint8Array.from(Buffer.from(actual));
  const expectedBuffer = Uint8Array.from(Buffer.from(expected));
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function logDestructiveElicitation(
  toolName: string,
  effect: string,
  decision: ElicitationDecision,
  sanitizerOptions: SanitizerOptions = {},
  reason?: string,
): void {
  logger.info(
    {
      tool: toolName,
      effect: sanitizeText(effect, sanitizerOptions),
      decision,
      ...(reason && { reason }),
    },
    "destructive.elicitation",
  );
}
