/**
 * Date formatting helpers for MCP-facing output.
 *
 * @packageDocumentation
 */

/**
 * Convert an optional millisecond timestamp into a Date.
 *
 * @param value - Epoch millisecond timestamp.
 *
 * @returns A Date when the timestamp is present, otherwise undefined.
 */
export function dateFromTimestamp(value: number | undefined): Date | undefined {
  return typeof value === "number" ? new Date(value) : undefined;
}
