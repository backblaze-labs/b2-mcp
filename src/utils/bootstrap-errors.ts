import { sanitizeText } from "./secret-sanitizer.js";

export function bootstrapErrorMessage(err: unknown): string {
  return sanitizeText(err instanceof Error ? err.message : String(err));
}
