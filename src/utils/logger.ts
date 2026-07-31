import pino from "pino";
import { VERSION } from "../version.js";
import { LOGGER_SECRET_REDACTION_PATHS, SECRET_SANITIZER_REDACTION } from "./secret-sanitizer.js";

const isTest = process.env.NODE_ENV === "test";

/**
 * Structured logger shared across the server. JSON output to stderr so:
 *   - The stdio transport's MCP protocol channel (stdout) stays clean.
 *   - systemd's journal captures it and the CloudWatch agent ships it.
 *
 * Sensitive fields (auth tokens, B2 keys) are redacted at the logger
 * level — callers can pass full objects without worrying about leaks.
 */
export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? (isTest ? "silent" : "info"),
    base: { service: "backblaze-b2-mcp", version: VERSION },
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: LOGGER_SECRET_REDACTION_PATHS,
      censor: SECRET_SANITIZER_REDACTION,
    },
  },
  pino.destination({ dest: 2, sync: false }),
);
