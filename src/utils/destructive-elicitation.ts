/**
 * MCP elicitation support for destructive-operation confirmation.
 *
 * @packageDocumentation
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  PROTOCOL_VERSION_META_KEY,
  createRequestStateCodec,
  type ClientCapabilities,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { createHash } from "crypto";
import { toolError } from "./errors.js";
import {
  destructiveEffect,
  destructiveTargetDigest,
  getDestructivePolicy,
  runWithDestructiveElicitationConsent,
} from "./destructive-gate.js";
import { logger } from "./logger.js";
import type { SanitizerOptions } from "./secret-sanitizer.js";
import { sanitizeText, SECRET_SANITIZER_REDACTION } from "./secret-sanitizer.js";
import type { B2Config } from "./types.js";

/** Input-response key used for the human approval checkbox. */
export const DESTRUCTIVE_ELICITATION_RESPONSE_KEY = "destructiveConfirmation";
/** Request-state namespace used to bind destructive approval to one call. */
export const DESTRUCTIVE_ELICITATION_REQUEST_STATE = "b2-mcp-destructive-elicitation-v1";

/** Supplies negotiated MCP client capabilities from the active request. */
export type ClientCapabilitiesProvider = () => ClientCapabilities | undefined;
/** Supplies the negotiated MCP protocol version from the active request. */
export type ProtocolVersionProvider = () => string | undefined;
/** Codec used to mint and verify destructive-approval request state. */
export type DestructiveElicitationRequestStateCodec =
  RequestStateCodec<DestructiveElicitationState>;

/** Audit payload emitted when destructive elicitation makes a decision. */
export interface DestructiveElicitationAuditEvent {
  /** Final decision outcome. */
  outcome: ElicitationDecision;
  /** Optional refusal/decline/cancel reason. */
  reason?: string;
}

/** Optional context hooks used by tests and protocol adapters. */
export interface DestructiveElicitationContextProviders {
  /** Returns request-local MCP client capabilities. */
  getClientCapabilities?: ClientCapabilitiesProvider;
  /** Returns request-local MCP protocol version. */
  getProtocolVersion?: ProtocolVersionProvider;
  /** Overrides the SDK request-state codec. */
  requestStateCodec?: DestructiveElicitationRequestStateCodec;
}

// Single adapter boundary for the SDK tool-callback context fields this module
// consumes. The SDK owns mcpReq/envelope/requestState shape, so upgrades should
// be reconciled here rather than through scattered structural casts.
interface McpRequestExtra {
  clientCapabilities?: ClientCapabilities;
  mcpReq?: {
    inputResponses?: Record<string, unknown>;
    requestState?: string | (() => unknown);
    clientCapabilities?: ClientCapabilities;
    envelope?: Record<string, unknown>;
  };
}

/** Signed state carried between the elicitation request and resumed tool call. */
export interface DestructiveElicitationState {
  /** State schema version. */
  v: 1;
  /** State discriminator. */
  kind: "destructive-elicitation";
  /** Tool that requested approval. */
  toolName: string;
  /** Sanitized destructive effect approved by the user. */
  effect: string;
  /** Digest of the destructive target arguments. */
  argsDigest: string;
  /** State issuance timestamp in epoch milliseconds. */
  issuedAt: number;
}

/** Decision lifecycle for return-based destructive-operation elicitation. */
export type ElicitationDecision = "requested" | "accepted" | "declined" | "cancelled" | "refused";
type StateVerification =
  | { ok: true; state: DestructiveElicitationState }
  | { ok: false; reason: string };

const DESTRUCTIVE_ELICITATION_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const DESTRUCTIVE_ELICITATION_STATE_TTL_SECONDS = DESTRUCTIVE_ELICITATION_STATE_MAX_AGE_MS / 1000;
const DESTRUCTIVE_ELICITATION_ENV = "B2_DESTRUCTIVE_ELICITATION";
const RETURN_BASED_INPUT_PROTOCOL_VERSION = "2026-07-28";
const REQUEST_STATE_PREFIX = `${DESTRUCTIVE_ELICITATION_REQUEST_STATE}.`;
const PROMPT_TARGET_DETAIL_LIMIT = 5;

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
  ["Application key name", "keyName"],
  ["Admin account ID", "adminAccountId"],
  ["Group ID", "groupId"],
  ["Member account ID", "memberAccountId"],
  ["Member email", "memberEmail"],
  ["Account email", "email"],
  ["Operation", "operation"],
  ["Expiry seconds", "expiresIn"],
  ["Upload ID", "uploadId"],
] as const;

/** Options for wrapping one tool callback with destructive elicitation. */
export interface DestructiveElicitationOptions<T> {
  /** Tool name being invoked. */
  toolName: string;
  /** Tool arguments used to compute target identity and prompt details. */
  args: Record<string, unknown>;
  /** MCP SDK callback context for the current request. */
  extra: unknown;
  /** Active B2 server configuration. */
  config: B2Config;
  /** Sanitizer options used before prompt/log emission. */
  sanitizerOptions: SanitizerOptions;
  /** Optional protocol/context providers. */
  contextProviders?: DestructiveElicitationContextProviders;
  /** Optional audit callback for tests and transport logging. */
  onDecision?: (event: DestructiveElicitationAuditEvent) => void;
  /** Original tool implementation to run after approval or bypass. */
  runOriginal: () => T | Promise<T>;
}

type ToolErrorResult = ReturnType<typeof toolError>;

/**
 * Run a destructive tool callback through return-based MCP elicitation when needed.
 *
 * @param options - Tool call, configuration, and callback state.
 *
 * @returns The original result, an MCP input-required response, or a stable tool error.
 */
export async function maybeRequireDestructiveElicitation<T>({
  toolName,
  args,
  extra,
  config,
  sanitizerOptions,
  contextProviders,
  onDecision,
  runOriginal,
}: DestructiveElicitationOptions<T>): Promise<T | InputRequiredResult | ToolErrorResult> {
  const effect = destructiveEffect(toolName, args);
  if (!effect) {
    return runOriginal();
  }

  const policy = getDestructivePolicy(config);
  const requestExtra = mcpRequestExtra(extra);
  // Only `confirm` and `elicit` run the elicitation flow; `allow`/`block` are
  // resolved entirely by the in-handler gate.
  if (policy !== "confirm" && policy !== "elicit") {
    return runOriginal();
  }

  // When no human can be reached — elicitation disabled, or the client cannot
  // present a form — `confirm` falls through to the gate (which still accepts a
  // model confirm:true), while `elicit` refuses: its contract is "require a
  // human, and refuse if you can't reach one".
  if (!destructiveElicitationEnabled()) {
    if (policy === "elicit") {
      return destructiveElicitationRefused(
        toolName,
        effect,
        "MCP elicitation is disabled on this server (B2_DESTRUCTIVE_ELICITATION), so no human can be prompted",
        sanitizerOptions,
        onDecision,
      );
    }
    return runOriginal();
  }
  if (!clientCanUseReturnBasedElicitation(requestExtra, contextProviders)) {
    if (policy === "elicit") {
      return destructiveElicitationRefused(
        toolName,
        effect,
        "this client cannot present an MCP elicitation prompt, so no human can approve",
        sanitizerOptions,
        onDecision,
      );
    }
    return runOriginal();
  }

  const response = inputResponse(
    mcpInputResponses(requestExtra),
    DESTRUCTIVE_ELICITATION_RESPONSE_KEY,
  );
  if (response.kind === "missing") {
    if (mcpRequestState(requestExtra) !== undefined) {
      return destructiveElicitationRefused(
        toolName,
        effect,
        "human confirmation was not provided",
        sanitizerOptions,
        onDecision,
      );
    }
    const requestState = await mintDestructiveElicitationState(
      config,
      toolName,
      effect,
      args,
      extra,
      contextProviders,
    );
    recordDestructiveElicitationDecision(
      toolName,
      effect,
      "requested",
      sanitizerOptions,
      onDecision,
    );
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

  const state = await verifyDestructiveElicitationState(
    config,
    mcpRequestState(requestExtra),
    toolName,
    effect,
    args,
    extra,
    contextProviders,
  );
  if (!state.ok) {
    return destructiveElicitationRefused(
      toolName,
      effect,
      state.reason,
      sanitizerOptions,
      onDecision,
    );
  }

  if (response.kind !== "elicit") {
    return destructiveElicitationRefused(
      toolName,
      effect,
      "human confirmation response was invalid",
      sanitizerOptions,
      onDecision,
    );
  }

  if (response.action !== "accept") {
    const outcome = response.action === "decline" ? "declined" : "cancelled";
    return destructiveElicitationRefused(
      toolName,
      effect,
      `human confirmation was ${response.action}`,
      sanitizerOptions,
      onDecision,
      outcome,
    );
  }

  if (response.content?.confirm !== true) {
    return destructiveElicitationRefused(
      toolName,
      effect,
      "human confirmation did not approve",
      sanitizerOptions,
      onDecision,
    );
  }

  recordDestructiveElicitationDecision(toolName, effect, "accepted", sanitizerOptions, onDecision);
  return runWithDestructiveElicitationConsent(
    toolName,
    destructiveTargetDigest(config, args),
    runOriginal,
  );
}

/**
 * Determine whether a request can use return-based MCP elicitation.
 *
 * @param extra - MCP SDK callback context or compatible test object.
 * @param contextProviders - Optional negotiated protocol/capability providers.
 *
 * @returns True when the request protocol and client capabilities support forms.
 */
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

/**
 * Determine whether the client advertised form elicitation support.
 *
 * @param extra - MCP request metadata.
 * @param getClientCapabilities - Optional capability provider override.
 *
 * @returns True when the client supports form-based elicitation.
 */
export function clientSupportsFormElicitation(
  extra: McpRequestExtra | unknown,
  getClientCapabilities?: ClientCapabilitiesProvider,
): boolean {
  const requestExtra = mcpRequestExtra(extra);
  const capabilities = getClientCapabilities?.() ?? mcpClientCapabilities(requestExtra);
  const elicitation = capabilities?.elicitation;
  if (!elicitation || typeof elicitation !== "object" || Array.isArray(elicitation)) {
    return false;
  }
  const keys = Object.keys(elicitation);
  // SDK v2 treats a bare `elicitation: {}` as the default form mode.
  if (keys.length === 0) return true;
  return Object.prototype.hasOwnProperty.call(elicitation, "form");
}

/**
 * Build the destructive-operation approval message shown to the user.
 *
 * @param toolName - Tool that would run.
 * @param effect - Human-readable destructive effect.
 * @param args - Tool arguments used for target details.
 * @param sanitizerOptions - Sanitizer options for secret redaction.
 *
 * @returns Sanitized one-line elicitation prompt.
 */
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
    ...bulkObjectTargetDetails(args.objects, sanitizerOptions),
    ...promptDetail("Rule count", arrayCount(args.rules), sanitizerOptions),
    ...lifecycleRuleTargetDetails(args.rules, sanitizerOptions),
    ...promptDetail(
      "Notification rule count",
      arrayCount(args.eventNotificationRules),
      sanitizerOptions,
    ),
    ...notificationRuleTargetDetails(args.eventNotificationRules, sanitizerOptions),
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
  sanitizerOptions: SanitizerOptions = {},
  onDecision?: (event: DestructiveElicitationAuditEvent) => void,
  outcome: ElicitationDecision = "refused",
): ToolErrorResult {
  recordDestructiveElicitationDecision(
    toolName,
    effect,
    outcome,
    sanitizerOptions,
    onDecision,
    reason,
  );
  return toolError({
    status: 409,
    code: "destructive_confirmation_refused",
    message: `Refused: ${toolName} requires explicit human approval by MCP elicitation; ${reason}.`,
  });
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

function promptListDetail(
  label: string,
  value: unknown,
  sanitizerOptions: SanitizerOptions,
): string[] {
  if (!Array.isArray(value)) return [];
  const safeValues = value
    .slice(0, PROMPT_TARGET_DETAIL_LIMIT)
    .map((item) => safePromptValue(item, sanitizerOptions))
    .filter((item): item is string => Boolean(item));
  if (safeValues.length === 0) return [];
  const omitted = value.length - safeValues.length;
  const suffix = omitted > 0 ? `, +${omitted} more` : "";
  return [`${label}: ${safeValues.join(", ")}${suffix}.`];
}

function promptTruncationDetail(label: string, count: number): string[] {
  return count > PROMPT_TARGET_DETAIL_LIMIT
    ? [`Additional ${label}: ${count - PROMPT_TARGET_DETAIL_LIMIT}.`]
    : [];
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recordValue(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function recordObject(
  record: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> | null {
  return objectRecord(recordValue(record, ...keys));
}

function bulkObjectTargetDetails(value: unknown, sanitizerOptions: SanitizerOptions): string[] {
  if (!Array.isArray(value)) return [];
  const details = value.slice(0, PROMPT_TARGET_DETAIL_LIMIT).flatMap((item, index) => {
    const record = objectRecord(item);
    if (!record) return [];
    const prefix = `Object ${index + 1}`;
    return [
      ...promptDetail(`${prefix} key`, recordValue(record, "key", "Key"), sanitizerOptions),
      ...promptDetail(
        `${prefix} version ID`,
        recordValue(record, "versionId", "VersionId"),
        sanitizerOptions,
      ),
    ];
  });
  details.push(...promptTruncationDetail("object targets", value.length));
  return details;
}

function lifecycleRuleTargetDetails(value: unknown, sanitizerOptions: SanitizerOptions): string[] {
  if (!Array.isArray(value)) return [];
  const details = value.slice(0, PROMPT_TARGET_DETAIL_LIMIT).flatMap((item, index) => {
    const rule = objectRecord(item);
    if (!rule) return [];
    const prefix = `Rule ${index + 1}`;
    const filter = recordObject(rule, "filter", "Filter");
    const expiration = recordObject(rule, "expiration", "Expiration");
    const noncurrent = recordObject(
      rule,
      "noncurrentVersionExpiration",
      "NoncurrentVersionExpiration",
    );
    const abortIncomplete = recordObject(
      rule,
      "abortIncompleteMultipartUpload",
      "AbortIncompleteMultipartUpload",
    );
    return [
      ...promptDetail(`${prefix} ID`, recordValue(rule, "id", "ID"), sanitizerOptions),
      ...promptDetail(`${prefix} status`, recordValue(rule, "status", "Status"), sanitizerOptions),
      ...promptDetail(
        `${prefix} prefix`,
        filter ? recordValue(filter, "prefix", "Prefix") : undefined,
        sanitizerOptions,
      ),
      ...promptDetail(
        `${prefix} expiration days`,
        expiration ? recordValue(expiration, "days", "Days") : undefined,
        sanitizerOptions,
      ),
      ...promptDetail(
        `${prefix} expired object delete marker`,
        expiration
          ? recordValue(expiration, "expiredObjectDeleteMarker", "ExpiredObjectDeleteMarker")
          : undefined,
        sanitizerOptions,
      ),
      ...promptDetail(
        `${prefix} noncurrent expiration days`,
        noncurrent ? recordValue(noncurrent, "noncurrentDays", "NoncurrentDays") : undefined,
        sanitizerOptions,
      ),
      ...promptDetail(
        `${prefix} abort incomplete upload days`,
        abortIncomplete
          ? recordValue(abortIncomplete, "daysAfterInitiation", "DaysAfterInitiation")
          : undefined,
        sanitizerOptions,
      ),
    ];
  });
  details.push(...promptTruncationDetail("lifecycle rules", value.length));
  return details;
}

function notificationRuleTargetDetails(
  value: unknown,
  sanitizerOptions: SanitizerOptions,
): string[] {
  if (!Array.isArray(value)) return [];
  const details = value.slice(0, PROMPT_TARGET_DETAIL_LIMIT).flatMap((item, index) => {
    const rule = objectRecord(item);
    if (!rule) return [];
    const prefix = `Notification rule ${index + 1}`;
    return [
      ...promptDetail(`${prefix} name`, recordValue(rule, "name"), sanitizerOptions),
      ...promptDetail(
        `${prefix} object prefix`,
        recordValue(rule, "objectNamePrefix"),
        sanitizerOptions,
      ),
      ...promptListDetail(
        `${prefix} event types`,
        recordValue(rule, "eventTypes"),
        sanitizerOptions,
      ),
      ...promptDetail(`${prefix} enabled`, recordValue(rule, "isEnabled"), sanitizerOptions),
    ];
  });
  details.push(...promptTruncationDetail("notification rules", value.length));
  return details;
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
  const providerVersion = contextProviders?.getProtocolVersion?.();
  if (providerVersion) return providerVersion;
  const version = extra?.mcpReq?.envelope?.[PROTOCOL_VERSION_META_KEY];
  return typeof version === "string" ? version : undefined;
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

/**
 * Create the signed request-state codec for destructive elicitation.
 *
 * @param config - Active B2 config used as key material.
 *
 * @returns Codec that prefixes and verifies destructive-elicitation state.
 */
export function createDestructiveElicitationRequestStateCodec(
  config: B2Config,
): DestructiveElicitationRequestStateCodec {
  const codec = createRequestStateCodec<DestructiveElicitationState>({
    key: destructiveElicitationStateKey(config),
    ttlSeconds: DESTRUCTIVE_ELICITATION_STATE_TTL_SECONDS,
  });

  return {
    async mint(payload, ctx) {
      return `${REQUEST_STATE_PREFIX}${await codec.mint(payload, ctx)}`;
    },
    async verify(state, ctx) {
      if (!state.startsWith(REQUEST_STATE_PREFIX)) throw new Error("malformed");
      return codec.verify(state.slice(REQUEST_STATE_PREFIX.length), ctx);
    },
  };
}

async function mintDestructiveElicitationState(
  config: B2Config,
  toolName: string,
  effect: string,
  args: Record<string, unknown>,
  extra: unknown,
  contextProviders?: DestructiveElicitationContextProviders,
): Promise<string> {
  const payload: DestructiveElicitationState = {
    v: 1,
    kind: "destructive-elicitation",
    toolName,
    effect,
    argsDigest: destructiveTargetDigest(config, args),
    issuedAt: Date.now(),
  };
  return requestStateCodec(config, contextProviders).mint(payload, extra as ServerContext);
}

async function verifyDestructiveElicitationState(
  config: B2Config,
  requestState: unknown,
  toolName: string,
  effect: string,
  args: Record<string, unknown>,
  extra: unknown,
  contextProviders?: DestructiveElicitationContextProviders,
): Promise<StateVerification> {
  if (requestState === undefined) return { ok: false, reason: "requestState is missing" };

  const state =
    typeof requestState === "string"
      ? await verifyRawDestructiveElicitationState(config, requestState, extra, contextProviders)
      : parseDestructiveElicitationState(requestState);
  if (!state) return { ok: false, reason: "requestState payload was invalid" };
  if (Date.now() - state.issuedAt > DESTRUCTIVE_ELICITATION_STATE_MAX_AGE_MS) {
    return { ok: false, reason: "requestState expired" };
  }
  if (
    state.toolName !== toolName ||
    state.effect !== effect ||
    state.argsDigest !== destructiveTargetDigest(config, args)
  ) {
    return { ok: false, reason: "approved destructive target did not match this call" };
  }

  return { ok: true, state };
}

async function verifyRawDestructiveElicitationState(
  config: B2Config,
  requestState: string,
  extra: unknown,
  contextProviders?: DestructiveElicitationContextProviders,
): Promise<DestructiveElicitationState | null> {
  try {
    return parseDestructiveElicitationState(
      await requestStateCodec(config, contextProviders).verify(
        requestState,
        extra as ServerContext,
      ),
    );
  } catch {
    return null;
  }
}

function parseDestructiveElicitationState(value: unknown): DestructiveElicitationState | null {
  const state = value as {
    v?: unknown;
    kind?: unknown;
    toolName?: unknown;
    effect?: unknown;
    argsDigest?: unknown;
    issuedAt?: unknown;
  };
  if (
    !state ||
    typeof state !== "object" ||
    state.v !== 1 ||
    state.kind !== "destructive-elicitation" ||
    typeof state.toolName !== "string" ||
    typeof state.effect !== "string" ||
    typeof state.argsDigest !== "string" ||
    typeof state.issuedAt !== "number"
  ) {
    return null;
  }
  return state as DestructiveElicitationState;
}

function requestStateCodec(
  config: B2Config,
  contextProviders?: DestructiveElicitationContextProviders,
): DestructiveElicitationRequestStateCodec {
  return (
    contextProviders?.requestStateCodec ?? createDestructiveElicitationRequestStateCodec(config)
  );
}

function destructiveElicitationStateKey(config: B2Config): Uint8Array {
  return Uint8Array.from(
    createHash("sha256")
      .update("b2-mcp-destructive-elicitation-request-state\0")
      .update(destructiveElicitationKeyMaterial(config))
      .digest(),
  );
}

function destructiveElicitationKeyMaterial(config: B2Config): string {
  return [config.applicationKey, config.appKey, config.masterKey, config.credentialFingerprint]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\0");
}

function recordDestructiveElicitationDecision(
  toolName: string,
  effect: string,
  decision: ElicitationDecision,
  sanitizerOptions: SanitizerOptions,
  onDecision?: (event: DestructiveElicitationAuditEvent) => void,
  reason?: string,
): void {
  logDestructiveElicitation(toolName, effect, decision, sanitizerOptions, reason);
  onDecision?.({ outcome: decision, ...(reason && { reason }) });
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
      outcome: decision,
      ...(reason && { reason }),
    },
    "destructive.elicitation",
  );
}
