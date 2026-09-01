/**
 * Error normalization and MCP tool-result helpers.
 *
 * @packageDocumentation
 */
import {
  currentSanitizerOptions,
  hasCurrentSanitizerOptions,
  sanitizeProviderCode,
  sanitizeProviderRequestId,
  sanitizeText,
} from "./secret-sanitizer.js";
import {
  serializeStructuredToolResult,
  serializeUnsanitizedStructuredToolResult,
  type StructuredToolResult,
} from "./result-serializer.js";
import { isAbortError, isTimeoutError } from "./named-error.js";

const SANITIZED_MCP_RESPONSE = Symbol("b2-mcp.sanitizedMcpResponse");
const REQUEST_TIMEOUT_STATUS = 504;
const REQUEST_TIMEOUT_CODE = "request_timeout";
const REQUEST_ABORTED_STATUS = 499;
const REQUEST_ABORTED_CODE = "request_aborted";
const OPERATION_STATUS_UNKNOWN_STATUS = 409;
const OPERATION_STATUS_UNKNOWN_CODE = "operation_status_unknown";

/** Normalized provider error shape used by MCP tool responses and audit logs. */
export interface B2ApiError {
  /** HTTP status associated with the provider or local error. */
  status: number;
  /** Stable provider or local error code. */
  code: string;
  /** Human-readable error message. */
  message: string;
  /** Provider request id (B2 native header or AWS SDK $metadata) — for support tickets. */
  requestId?: string;
  /** AWS SDK extended request id, when present. */
  extendedRequestId?: string;
}

/**
 * Build an error carrying its own HTTP status and code.
 *
 * parseB2Error reaches its internal_error/500 tail only for errors with no code
 * of their own, so a bare `new Error()` always reads as a server fault. Build
 * every *deliberate* refusal here instead, so the classification is chosen. It
 * stays an Error, so stack traces and `rejects.toThrow()` still work.
 *
 * @returns An Error carrying the given status and code.
 */
export function codedError(status: number, code: string, message: string): Error & B2ApiError {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Build an HTTP 400 bad_request error for a caller-input refusal — the server
 * understood the request and said no, so the caller needs a correctable 4xx.
 *
 * @returns An Error carrying status 400 and code `bad_request`.
 */
export function badRequestError(message: string): Error & B2ApiError {
  return codedError(400, "bad_request", message);
}

/**
 * Throw HTTP 400 bad_request.
 *
 * @param message - Error message exposed in the normalized response.
 *
 * @throws A normalized B2 API error object.
 */
export function badRequest(message: string): never {
  throw badRequestError(message);
}

/**
 * Build an error for a native B2 mutation whose final provider state is unknown.
 *
 * @param operation - B2 API endpoint name whose result is ambiguous.
 * @param cause - Timeout, abort, or transport error that hid the final response.
 *
 * @returns An Error carrying status 409 and code `operation_status_unknown`.
 */
export function operationStatusUnknownError(operation: string, cause: unknown): Error & B2ApiError {
  const causeMessage =
    cause instanceof Error && cause.message ? ` Last local error: ${cause.message}.` : "";
  const error = codedError(
    OPERATION_STATUS_UNKNOWN_STATUS,
    OPERATION_STATUS_UNKNOWN_CODE,
    `B2 native operation ${operation} was interrupted before the MCP server received B2's final response. The operation may have completed at B2; verify the resource state before retrying.${causeMessage}`,
  );
  Object.defineProperty(error, "cause", {
    value: cause,
    enumerable: false,
    configurable: true,
  });
  return error;
}

/** Pull a request id out of HTTP response headers (B2 native / S3 proxy variants). */
function headerRequestId(headers: unknown): string | undefined {
  if (typeof headers !== "object" || headers === null) return undefined;
  const h = headers as Record<string, unknown>;
  const id = h["x-bz-request-id"] ?? h["x-amz-request-id"] ?? h["x-amz-id-2"] ?? h["x-request-id"];
  return typeof id === "string" ? id : undefined;
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function messageOrFallback(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return fallback;
  try {
    const json = JSON.stringify(value);
    if (typeof json === "string") return json;
  } catch {
    // Fall through to String(value).
  }
  return String(value);
}

function numberOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function objectCause(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as { cause?: unknown }).cause;
}

function hasNamedErrorInChain(
  value: unknown,
  predicate: (error: unknown) => boolean,
  seen = new Set<unknown>(),
): boolean {
  if (predicate(value)) return true;
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  const cause = objectCause(value);
  return cause !== undefined && hasNamedErrorInChain(cause, predicate, seen);
}

function codedErrorInCauseChain(value: unknown, seen = new Set<unknown>()): B2ApiError | null {
  if (typeof value !== "object" || value === null || seen.has(value)) return null;
  seen.add(value);
  const cause = objectCause(value);
  if (typeof cause !== "object" || cause === null) return null;
  const e = cause as Record<string, unknown>;
  if (typeof e.status === "number" && typeof e.code === "string") {
    return {
      status: e.status,
      code: e.code,
      message: messageOrFallback(e.message, "An unknown error occurred"),
      requestId: typeof e.requestId === "string" ? e.requestId : undefined,
    };
  }
  return codedErrorInCauseChain(cause, seen);
}

/**
 * Parse an error from a B2 API call and return a structured error object.
 *
 * Handles both error shapes used in this codebase:
 *   - B2 SDK typed/native errors: `err.status` + `err.code` + `err.requestId`
 *   - S3 / AWS SDK v3:   `err.$metadata.httpStatusCode` + `err.name`/`err.Code`,
 *     with the trace id in `err.$metadata.requestId`.
 *   - Legacy HTTP-client response errors retained for compatibility in tests.
 *
 * Reading the AWS SDK shape is what lets us tell a genuine Backblaze 5xx apart
 * from a 4xx (e.g. NoSuchKey) and surface the requestId support needs.
 *
 * @param err - Error value thrown by B2 native, S3-compatible, or local code.
 *
 * @returns The normalized B2 API error object.
 */
export function parseB2Error(err: unknown): B2ApiError {
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;

    // Official B2 SDK typed errors.
    if (typeof e.status === "number" && typeof e.code === "string") {
      return {
        status: e.status,
        code: e.code,
        message: messageOrFallback(e.message, "An unknown error occurred"),
        requestId: typeof e.requestId === "string" ? e.requestId : undefined,
      };
    }

    // AWS SDK v3 error (S3 tools) — has a $metadata object.
    if (e.$metadata && typeof e.$metadata === "object") {
      const meta = e.$metadata as Record<string, unknown>;
      const status = typeof meta.httpStatusCode === "number" ? meta.httpStatusCode : 500;
      const code =
        (typeof e.Code === "string" && e.Code) ||
        (typeof e.name === "string" && e.name) ||
        "unknown_error";
      return {
        status,
        code,
        message: messageOrFallback(e.message, "An unknown error occurred"),
        requestId: typeof meta.requestId === "string" ? meta.requestId : undefined,
        extendedRequestId:
          typeof meta.extendedRequestId === "string" ? meta.extendedRequestId : undefined,
      };
    }

    // Legacy response-style error with a response body.
    if (e.response && typeof e.response === "object") {
      const resp = e.response as Record<string, unknown>;
      const data =
        resp.data && typeof resp.data === "object" ? (resp.data as Record<string, unknown>) : {};
      return {
        status: numberOrFallback(resp.status, 500),
        code: stringOrFallback(data.code, "unknown_error"),
        message: messageOrFallback(data.message, "An unknown error occurred"),
        requestId: headerRequestId(resp.headers),
      };
    }

    const codedCause = codedErrorInCauseChain(err);
    if (codedCause) return codedCause;

    if (hasNamedErrorInChain(err, isTimeoutError)) {
      return {
        status: REQUEST_TIMEOUT_STATUS,
        code: REQUEST_TIMEOUT_CODE,
        message: messageOrFallback(e.message, "The request timed out"),
      };
    }
    if (hasNamedErrorInChain(err, isAbortError)) {
      return {
        status: REQUEST_ABORTED_STATUS,
        code: REQUEST_ABORTED_CODE,
        message: messageOrFallback(e.message, "The request was aborted"),
      };
    }
    // Already a parsed B2 error.
    if (typeof e.code === "string" && typeof e.message === "string") {
      return {
        status: (e.status as number) ?? 500,
        code: e.code,
        message: e.message,
        requestId: typeof e.requestId === "string" ? e.requestId : undefined,
      };
    }
    if (e.message) {
      return {
        status: 500,
        code: "internal_error",
        message: messageOrFallback(e.message, "An unknown error occurred"),
      };
    }
  }
  return { status: 500, code: "internal_error", message: String(err) };
}

/** Parsed metadata extracted from a formatted B2 error string. */
export interface ParsedB2ErrorText {
  /** Stable provider or local error code. */
  code: string;
  /** HTTP status associated with the formatted error. */
  status: number;
  /** Provider request ID, when present in the formatted error. */
  requestId?: string;
}

/**
 * Parse a formatB2Error() string back into its parts. Used by the audit layer
 * to record error code/status/requestId from a tool's error response (the tool
 * surface only carries the formatted text). Returns null if the text isn't a
 * formatted B2 error.
 *
 * @param text - Error text produced by {@link formatB2Error}.
 *
 * @returns Parsed error metadata, or null when the text is not a formatted B2 error.
 */
export function parseErrorText(text: string | undefined): ParsedB2ErrorText | null {
  if (!text) return null;
  const m = text.match(/^B2 Error \[(.+)\] \(HTTP (\d+)\): [\s\S]*?(?: \(requestId: (.+?)\))?$/);
  if (!m) return null;
  return { code: m[1], status: Number(m[2]), requestId: m[3] };
}

/**
 * Format a B2 error into a human-readable string for MCP tool responses.
 * Includes the provider requestId when available — the field a Backblaze
 * support ticket needs to trace a server-side failure.
 *
 * @param err - Provider or normalized error to format.
 *
 * @returns The formatted, sanitized B2 error message.
 */
export function formatB2Error(err: unknown): string {
  const parsed = parseB2Error(err);
  const sanitizerOptions = currentSanitizerOptions();
  const code = sanitizeProviderCode(parsed.code, sanitizerOptions);
  const requestId = sanitizeProviderRequestId(parsed.requestId, sanitizerOptions);
  const base = `B2 Error [${code}] (HTTP ${parsed.status}): ${sanitizeText(parsed.message, sanitizerOptions)}${errorHint(parsed)}`;
  return requestId ? `${base} (requestId: ${requestId})` : base;
}

function markSanitizedMcpResponse<T extends object>(response: T): T {
  if (!hasCurrentSanitizerOptions()) return response;
  Object.defineProperty(response, SANITIZED_MCP_RESPONSE, {
    value: true,
    enumerable: false,
  });
  return response;
}

/**
 * Return whether an MCP response has already been sanitized.
 *
 * @param response - Candidate MCP response object.
 *
 * @returns `true` when the response was marked by this module.
 */
export function isSanitizedMcpResponse(response: unknown): boolean {
  return !!(
    response &&
    typeof response === "object" &&
    (response as Record<PropertyKey, unknown>)[SANITIZED_MCP_RESPONSE] === true
  );
}

/**
 * Extra guidance appended to otherwise-cryptic B2 errors.
 *
 * The big one: B2's S3-compatible API (every s3_* tool and the live insight
 * tools) rejects the account MASTER key — and any malformed key id — with
 * InvalidAccessKeyId / "Malformed Access Key Id". Connecting with a master key
 * is a natural mistake (it's the "full access" key), so the raw error is a
 * common dead end. Point the operator at a regular application key.
 */
function errorHint(parsed: B2ApiError): string {
  if (parsed.code === "InvalidAccessKeyId" || /malformed access key id/i.test(parsed.message)) {
    return (
      " — B2's S3-compatible API (used by the s3_* and insight tools) only accepts a regular " +
      "application key, not an account master key. If you're connecting with a master key, switch " +
      "B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY to a non-master application key for S3 tools."
    );
  }
  return "";
}

/** Text content block returned by simple MCP tool helpers. */
export interface ToolTextContent {
  /** MCP content block type. */
  type: "text";
  /** Text payload returned to the MCP client. */
  text: string;
}

/** Structured MCP response for a failed tool call. */
export interface ToolErrorResult {
  /** Marks the MCP tool result as an error. */
  isError: true;
  /** Error text content blocks. */
  content: ToolTextContent[];
}

/** Structured MCP response for a successful text-only tool call. */
export interface ToolSuccessResult {
  /** Success text content blocks. */
  content: ToolTextContent[];
}

/**
 * Return a structured MCP error content block for tool error responses.
 *
 * @param err - Provider or normalized error to format.
 *
 * @returns The structured MCP error response.
 */
export function toolError(err: unknown): ToolErrorResult {
  return markSanitizedMcpResponse({
    isError: true,
    content: [{ type: "text", text: formatB2Error(err) }],
  });
}

/**
 * Return a successful tool response with text content.
 *
 * @param text - Text payload to sanitize and return.
 *
 * @returns The structured MCP success response.
 */
export function toolSuccess(text: string): ToolSuccessResult {
  return markSanitizedMcpResponse({
    content: [{ type: "text", text: sanitizeText(text, currentSanitizerOptions()) }],
  });
}

/**
 * Return a successful tool response with a JSON object.
 *
 * @param data - JSON-compatible data to sanitize and serialize.
 *
 * @returns The structured MCP JSON response.
 */
export function toolJson(data: unknown): StructuredToolResult {
  return markSanitizedMcpResponse(serializeStructuredToolResult(data, currentSanitizerOptions()));
}

/**
 * Return an intentionally unsanitized JSON response for the explicit
 * B2_SECRET_SINK=inline escape hatch. Do not use for ordinary tool output.
 *
 * @param data - JSON-compatible data containing deliberate durable secrets.
 *
 * @returns The structured MCP JSON response with deliberate inline secrets.
 */
export function toolJsonInlineDurableSecret(data: unknown): StructuredToolResult {
  return markSanitizedMcpResponse(serializeUnsanitizedStructuredToolResult(data));
}
