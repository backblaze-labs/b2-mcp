import { AsyncLocalStorage } from "async_hooks";
import { sanitizeForMcpOutput, type SanitizerOptions } from "./secret-sanitizer.js";
import { encodeToon } from "./toon-encoder.js";
import { logger } from "./logger.js";

export const TOON_SPEC_VERSION = "4.1";
export const TOON_IMPLEMENTATION = "repo-owned";
export const MAX_TOON_INPUT_JSON_CHARS = 200_000;
export const MAX_TOON_INPUT_DEPTH = 64;
export const MAX_TOON_INPUT_NODES = 50_000;

export const MCP_OUTPUT_FORMATS = ["json", "toon"] as const;
export type McpOutputFormat = (typeof MCP_OUTPUT_FORMATS)[number];

export const DEFAULT_MCP_OUTPUT_FORMAT: McpOutputFormat = "json";

export type JsonCompatible =
  null | boolean | number | string | JsonCompatible[] | { [key: string]: JsonCompatible };

interface ResultSerializationOptions {
  outputFormat: McpOutputFormat;
}

const resultSerializationOptionsStorage = new AsyncLocalStorage<
  ResultSerializationOptions | undefined
>();

export interface StructuredToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: JsonCompatible;
}

const loggedToonFallbackReasons = new Set<string>();

export function parseMcpOutputFormat(raw: string | undefined): McpOutputFormat {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MCP_OUTPUT_FORMAT;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "toon" || normalized === "json") return normalized;
  throw new Error('Invalid B2_MCP_OUTPUT_FORMAT. Expected "json" or "toon".');
}

export function preflightMcpOutputFormat(format: McpOutputFormat): void {
  if (format !== "toon") return;
  const text = encodeToon({ ok: true });
  if (text !== "ok: true") {
    throw new Error("TOON serializer preflight failed");
  }
}

export function runWithResultSerializationOptions<T>(
  options: ResultSerializationOptions,
  callback: () => T,
): T {
  return resultSerializationOptionsStorage.run(options, callback);
}

export function currentMcpOutputFormat(): McpOutputFormat {
  return resultSerializationOptionsStorage.getStore()?.outputFormat ?? DEFAULT_MCP_OUTPUT_FORMAT;
}

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
