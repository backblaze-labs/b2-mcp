import { AsyncLocalStorage } from "async_hooks";
import { createRequire } from "module";
import type { decode as decodeType, encode as encodeType } from "@toon-format/toon";
import { sanitizeForMcpOutput, type SanitizerOptions } from "./secret-sanitizer.js";

const nodeRequire = createRequire(__filename);
interface ToonModule {
  encode: typeof encodeType;
  decode: typeof decodeType;
}

let toonModule: ToonModule | null = null;

export const TOON_PACKAGE_VERSION = "4.1.0";
export const TOON_SPEC_VERSION = "4.1";

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

export function parseMcpOutputFormat(raw: string | undefined): McpOutputFormat {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MCP_OUTPUT_FORMAT;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "toon" || normalized === "json") return normalized;
  throw new Error('Invalid B2_MCP_OUTPUT_FORMAT. Expected "json" or "toon".');
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

function serializeStructuredText(value: JsonCompatible, format: McpOutputFormat): string {
  if (format === "json") return JSON.stringify(value);
  const text = loadToonModule().encode(value);
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

function loadToonModule(): ToonModule {
  if (toonModule) return toonModule;
  // @toon-format/toon 4.1.0 is ESM-only while this project still emits and
  // tests CommonJS, so static importing would compile to an incompatible
  // require(). Keep the runtime load lazy so JSON mode never executes it.
  toonModule = nodeRequire("@toon-format/toon") as ToonModule;
  return toonModule;
}
