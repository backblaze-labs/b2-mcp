/**
 * Structured MCP result serialization helpers.
 *
 * @packageDocumentation
 */
import { AsyncLocalStorage } from "async_hooks";
import { sanitizeForMcpOutput, type SanitizerOptions } from "./secret-sanitizer.js";
import { encodeToon } from "./toon-encoder.js";
import { logger } from "./logger.js";

/** TOON format version used when `B2_MCP_OUTPUT_FORMAT=toon`. */
export const TOON_SPEC_VERSION = "4.1";

/** Identifier for the local TOON encoder implementation. */
export const TOON_IMPLEMENTATION = "repo-owned";

/** Maximum JSON text length eligible for TOON text serialization. */
export const MAX_TOON_INPUT_JSON_CHARS = 200_000;

/** Maximum JSON depth eligible for TOON text serialization. */
export const MAX_TOON_INPUT_DEPTH = 64;

/** Maximum JSON node count eligible for TOON text serialization. */
export const MAX_TOON_INPUT_NODES = 50_000;

/** Supported LLM-facing text formats for structured MCP tool results. */
export const MCP_OUTPUT_FORMATS = ["json", "toon"] as const;

/** Supported LLM-facing text format for structured MCP tool results. */
export type McpOutputFormat = (typeof MCP_OUTPUT_FORMATS)[number];

/** Default structured tool result text format. */
export const DEFAULT_MCP_OUTPUT_FORMAT: McpOutputFormat = "json";

/** JSON-compatible value accepted by MCP `structuredContent`. */
export type JsonCompatible = null | boolean | number | string | JsonCompatible[] | JsonObject;

/** JSON-compatible object accepted by MCP `structuredContent`. */
export interface JsonObject {
  /** JSON object property value. */
  [key: string]: JsonCompatible;
}

/** Async-local structured-result serialization options. */
export interface ResultSerializationOptions {
  /** Text serialization format used for MCP content blocks. */
  outputFormat: McpOutputFormat;
}

const resultSerializationOptionsStorage = new AsyncLocalStorage<
  ResultSerializationOptions | undefined
>();

/** Text content block returned alongside structured MCP content. */
export interface StructuredToolTextContent {
  /** MCP content block type. */
  type: "text";
  /** Serialized text payload. */
  text: string;
}

/** Successful MCP tool result with text content and JSON structured content. */
export interface StructuredToolResult {
  /** LLM-facing text content blocks. */
  content: StructuredToolTextContent[];
  /** Canonical JSON-compatible structured content. */
  structuredContent: JsonCompatible;
}

const loggedToonFallbackReasons = new Set<string>();

/**
 * Parse the configured structured-output text format.
 *
 * @param raw - Raw `B2_MCP_OUTPUT_FORMAT` value.
 *
 * @returns Parsed output format.
 *
 * @throws Error when the value is not `json` or `toon`.
 */
export function parseMcpOutputFormat(raw: string | undefined): McpOutputFormat {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MCP_OUTPUT_FORMAT;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "toon" || normalized === "json") return normalized;
  throw new Error('Invalid B2_MCP_OUTPUT_FORMAT. Expected "json" or "toon".');
}

/**
 * Validate that the selected output format is available at startup.
 *
 * @param format - Output format to check.
 *
 * @throws Error when the TOON encoder does not produce the expected baseline.
 */
export function preflightMcpOutputFormat(format: McpOutputFormat): void {
  if (format !== "toon") return;
  const text = encodeToon({ ok: true });
  if (text !== "ok: true") {
    throw new Error("TOON serializer preflight failed");
  }
}

/**
 * Run a callback with AsyncLocalStorage-backed serialization options.
 *
 * @param options - Serialization options for nested tool response helpers.
 * @param callback - Work to execute in that serialization context.
 *
 * @returns The callback result.
 */
export function runWithResultSerializationOptions<T>(
  options: ResultSerializationOptions,
  callback: () => T,
): T {
  return resultSerializationOptionsStorage.run(options, callback);
}

/**
 * Return the current structured-output text format.
 *
 * @returns Active output format, falling back to JSON.
 */
export function currentMcpOutputFormat(): McpOutputFormat {
  return resultSerializationOptionsStorage.getStore()?.outputFormat ?? DEFAULT_MCP_OUTPUT_FORMAT;
}

/**
 * Build the MCP server instruction text describing result serialization.
 *
 * @param format - Active output format.
 *
 * @returns Human-readable instruction sentence for the server prompt.
 */
export function outputFormatInstructions(format: McpOutputFormat): string {
  if (format === "json") {
    return [
      "Structured successful tool results include canonical JSON in structuredContent and one compact JSON TextContent block in content.",
      "MCP messages remain JSON-RPC JSON; errors and concise status messages remain plain text.",
    ].join(" ");
  }
  return [
    `Structured successful tool results include canonical JSON in structuredContent and one TOON TextContent block in content (repo-owned encoder, spec ${TOON_SPEC_VERSION}).`,
    "TextContent has no media-type field, so this is not protocol-level TOON negotiation; MCP messages remain JSON-RPC JSON.",
    "Errors and concise status messages remain plain text.",
  ].join(" ");
}

/**
 * Sanitize and serialize successful structured tool data.
 *
 * @param data - Tool result data to sanitize and serialize.
 * @param sanitizerOptions - Secret redaction options.
 * @param format - Text serialization format for the MCP content block.
 *
 * @returns Structured MCP tool result.
 */
export function serializeStructuredToolResult(
  data: unknown,
  sanitizerOptions: SanitizerOptions = {},
  format: McpOutputFormat = currentMcpOutputFormat(),
): StructuredToolResult {
  const structuredContent = sanitizeJsonCompatible(data, sanitizerOptions);
  const jsonText = JSON.stringify(structuredContent);
  return {
    content: [{ type: "text", text: serializeStructuredText(structuredContent, jsonText, format) }],
    structuredContent,
  };
}

/**
 * Serialize structured data without secret sanitization.
 *
 * @remarks
 * This is reserved for the explicit inline durable-secret escape hatch. Normal
 * tool handlers should use {@link serializeStructuredToolResult}.
 *
 * @param data - JSON-compatible data to serialize.
 * @param format - Text serialization format for the MCP content block.
 *
 * @returns Structured MCP tool result.
 *
 * @throws TypeError when the value cannot be represented as JSON.
 */
export function serializeUnsanitizedStructuredToolResult(
  data: unknown,
  format: McpOutputFormat = currentMcpOutputFormat(),
): StructuredToolResult {
  const json = JSON.stringify(data);
  if (json === undefined) {
    throw new TypeError("MCP structured tool output must be JSON-compatible");
  }
  const structuredContent = JSON.parse(json) as JsonCompatible;
  return {
    content: [{ type: "text", text: serializeStructuredText(structuredContent, json, format) }],
    structuredContent,
  };
}

function serializeStructuredText(
  value: JsonCompatible,
  jsonText: string,
  format: McpOutputFormat,
): string {
  if (format === "json") return jsonText;
  if (!withinToonEncodingBounds(value, jsonText)) {
    logToonFallback("bounds");
    return jsonText;
  }
  let text: string;
  try {
    text = encodeToon(value);
  } catch {
    logToonFallback("encode_error");
    return jsonText;
  }
  // The TOON 4.1 empty object representation is an empty string; keep the
  // MCP text block visible and unambiguous by emitting JSON's "{}" spelling.
  return text === "" && isEmptyObject(value) ? "{}" : text;
}

function sanitizeJsonCompatible(data: unknown, sanitizerOptions: SanitizerOptions): JsonCompatible {
  const sanitized = sanitizeForMcpOutput(data, sanitizerOptions);
  const json = JSON.stringify(sanitized);
  if (json === undefined) {
    throw new TypeError("MCP structured tool output must be JSON-compatible");
  }
  return JSON.parse(json) as JsonCompatible;
}

function isEmptyObject(value: JsonCompatible): value is { [key: string]: JsonCompatible } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).length === 0
    : false;
}

function withinToonEncodingBounds(value: JsonCompatible, jsonText: string): boolean {
  if (jsonText.length > MAX_TOON_INPUT_JSON_CHARS) return false;

  let nodes = 0;
  const stack: Array<{ value: JsonCompatible; depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    nodes++;
    if (nodes > MAX_TOON_INPUT_NODES || current.depth > MAX_TOON_INPUT_DEPTH) return false;
    const currentValue = current.value;
    if (currentValue === null || typeof currentValue !== "object") continue;
    const children = Array.isArray(currentValue) ? currentValue : Object.values(currentValue);
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
  return true;
}

function logToonFallback(reason: "bounds" | "encode_error"): void {
  if (loggedToonFallbackReasons.has(reason)) return;
  loggedToonFallbackReasons.add(reason);
  logger.warn(
    {
      outputFormat: "toon",
      fallbackOutputFormat: "json",
      reason,
    },
    "tool.output_format.toon_fallback",
  );
}
