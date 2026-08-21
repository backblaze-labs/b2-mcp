export type RuntimeSecurityRuntime = "node-http" | "vercel" | "cloudflare-worker";
export type ServerlessRuntimeName = Exclude<RuntimeSecurityRuntime, "node-http">;

type RuntimeSecurityApplicability = {
  readonly runtime: RuntimeSecurityRuntime;
  readonly adapter: string;
  readonly decision: "required" | "required-shared-serverless-runtime";
  readonly coverage: readonly string[];
};

/**
 * Applicability fixture for issue #197. Tests consume this data to construct
 * the runtime matrix so coverage claims stay adjacent to executable cases.
 */
export const runtimeApplicability = {
  "node-http": {
    runtime: "node-http",
    adapter: "buildHttpServer",
    decision: "required",
    coverage: [
      "malformed-json-rpc",
      "oversized-json-rpc",
      "host-origin-binding",
      "rate-limit",
      "in-flight-limit",
      "secret-safe-errors-and-logs",
      "destructive-gate",
    ],
  },
  vercel: {
    runtime: "vercel",
    adapter: "vercelMcpFetch",
    decision: "required-shared-serverless-runtime",
    coverage: [
      "oauth-token-fail-closed",
      "resource-binding",
      "introspection-redirect",
      "jwks-redirect",
      "unsafe-oauth-endpoint",
    ],
  },
  "cloudflare-worker": {
    runtime: "cloudflare-worker",
    adapter: "cloudflareWorkerFetch",
    decision: "required-shared-serverless-runtime",
    coverage: [
      "oauth-token-fail-closed",
      "resource-binding",
      "introspection-redirect",
      "jwks-redirect",
      "unsafe-oauth-endpoint",
    ],
  },
} as const satisfies Record<RuntimeSecurityRuntime, RuntimeSecurityApplicability>;

export const serverlessRuntimeNames = [
  "vercel",
  "cloudflare-worker",
] as const satisfies readonly ServerlessRuntimeName[];
