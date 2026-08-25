import type { NotificationRulesResult } from "./client.js";

const REDACTED = "[redacted]";

/**
 * Redact webhook secrets from a notification-rules API response before it reaches
 * the model. B2 echoes back webhook URLs, signing secrets, and custom-header
 * values on get/set; the host is redacted too so internal webhook infrastructure
 * is not exposed as read-only context.
 *
 * @returns A redacted URL marker, or undefined when the input is undefined.
 */
export function redactWebhookUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${REDACTED}`;
  } catch {
    return REDACTED;
  }
}

function redactCustomHeaders(
  customHeaders: unknown,
): Array<{ name: string; value: string }> | Record<string, string> | undefined {
  if (customHeaders === undefined) return undefined;
  if (Array.isArray(customHeaders)) {
    return customHeaders.flatMap((header) => {
      if (!header || typeof header !== "object" || Array.isArray(header)) return [];
      const name = (header as { name?: unknown }).name;
      return typeof name === "string" ? [{ name, value: REDACTED }] : [];
    });
  }
  if (customHeaders && typeof customHeaders === "object") {
    return Object.fromEntries(Object.keys(customHeaders).map((name) => [name, REDACTED]));
  }
  return undefined;
}

/**
 * Redact notification-rule secrets while preserving non-secret rule structure.
 *
 * @returns A cloned notification-rules result with webhook secrets redacted.
 */
export function redactNotificationSecrets(
  result: NotificationRulesResult,
): NotificationRulesResult {
  return {
    ...result,
    eventNotificationRules: result.eventNotificationRules.map((rule) => {
      const customHeaders = redactCustomHeaders(rule.targetConfiguration.customHeaders);
      return {
        ...rule,
        targetConfiguration: {
          ...rule.targetConfiguration,
          url: redactWebhookUrl(rule.targetConfiguration.url) ?? rule.targetConfiguration.url,
          ...(rule.targetConfiguration.hmacSha256SigningSecret !== undefined
            ? { hmacSha256SigningSecret: REDACTED }
            : {}),
          ...(customHeaders !== undefined ? { customHeaders } : {}),
        },
      };
    }),
  };
}
