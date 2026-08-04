import { AsyncLocalStorage } from "async_hooks";
import { createRequire } from "module";
import type { decode as decodeType, encode as encodeType } from "@toon-format/toon";
import { sanitizeForMcpOutput, type SanitizerOptions } from "./secret-sanitizer.js";

const nodeRequire = createRequire(__filename);
const toon = nodeRequire("@toon-format/toon") as {
  encode: typeof encodeType;
  decode: typeof decodeType;
};

export const TOON_PACKAGE_VERSION = "4.1.0";
export const TOON_SPEC_VERSION = "4.1";

export const MCP_OUTPUT_FORMATS = ["toon", "json"] as const;
export type McpOutputFormat = (typeof MCP_OUTPUT_FORMATS)[number];

export const DEFAULT_MCP_OUTPUT_FORMAT: McpOutputFormat = "toon";

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

export function parseMcpOutputFormat(raw: string | undefined): McpOutputFormat {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MCP_OUTPUT_FORMAT;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "toon" || normalized === "json") return normalized;
  throw new Error('Invalid B2_MCP_OUTPUT_FORMAT. Expected "toon" or "json".');
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
    `Structured successful tool results include canonical JSON in structuredContent and one TOON TextContent block in content (TOON package ${TOON_PACKAGE_VERSION}, spec ${TOON_SPEC_VERSION}).`,
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
  return {
    content: [{ type: "text", text: serializeStructuredText(structuredContent, format) }],
    structuredContent,
  };
}

export function decodeToonForTests(text: string): JsonCompatible {
  return toon.decode(text) as JsonCompatible;
}

function serializeStructuredText(value: JsonCompatible, format: McpOutputFormat): string {
  if (format === "json") return JSON.stringify(value);
  return toon.encode(value);
}

function sanitizeJsonCompatible(data: unknown, sanitizerOptions: SanitizerOptions): JsonCompatible {
  const sanitized = sanitizeForMcpOutput(data, sanitizerOptions);
  const json = JSON.stringify(sanitized);
  if (json === undefined) {
    throw new TypeError("MCP structured tool output must be JSON-compatible");
  }
  return JSON.parse(json) as JsonCompatible;
}
