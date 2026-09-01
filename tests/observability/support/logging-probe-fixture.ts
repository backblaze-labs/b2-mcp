import { createAuditedToolCallback } from "../../../src/server";
import { checkDestructive } from "../../../src/utils/destructive-gate";
import { toolError, toolSuccess } from "../../../src/utils/errors";
import { flushLogsSync, initLogging, logger } from "../../../src/utils/logger";
import { _consumeRetryToken, _resetRetryBudget, withRetry } from "../../../src/utils/retry";
import type { B2Config } from "../../../src/utils/types";

type ProbeName =
  | "accessor-safety"
  | "policy-confirm-fallback"
  | "environment"
  | "policy-confirmation"
  | "redaction"
  | "retry-budget"
  | "thrown-failure";

function testConfig(prefix: string): B2Config {
  return {
    applicationKeyId: `${prefix}-key-id`,
    applicationKey: `B2_MCP_CANARY_SECRET_${prefix.toUpperCase()}_APPLICATION_KEY`,
    appKeyId: `${prefix}-key-id`,
    appKey: `B2_MCP_CANARY_SECRET_${prefix.toUpperCase()}_APP_KEY`,
    masterKeyId: `${prefix}-key-id`,
    masterKey: `B2_MCP_CANARY_SECRET_${prefix.toUpperCase()}_MASTER_KEY`,
    region: "us-west-004",
    allowLocalFiles: false,
    fileRoot: null,
    destructivePolicy: "confirm",
    outputFormat: "json",
    transport: "stdio",
    credentialFingerprint: `${prefix}-fingerprint`,
  };
}

function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

function defineThrowingGetter(target: object, key: string, message: string): void {
  Object.defineProperty(target, key, {
    enumerable: true,
    get() {
      throw new Error(message);
    },
  });
}

async function redactionProbe(): Promise<void> {
  initLogging();
  const err = Object.assign(new Error("provider failed B2_MCP_CANARY_SECRET_ERROR_MESSAGE"), {
    code: "B2_MCP_CANARY_SECRET_ERROR_CODE",
    status: 503,
    requestId: "B2_MCP_CANARY_SECRET_ERROR_REQUEST_ID",
    errno: -2,
    syscall: "open",
    path: "/tmp/b2-mcp-observability-safe-path",
    authorizationToken: "B2_MCP_CANARY_SECRET_ERROR_AUTH_TOKEN",
    details: {
      applicationKey: "B2_MCP_CANARY_SECRET_ERROR_NESTED_KEY",
    },
  });
  logger.error(
    {
      applicationKey: "B2_MCP_CANARY_SECRET_TOP_LEVEL_KEY",
      authorization: "Bearer B2_MCP_CANARY_SECRET_TOP_LEVEL_AUTH",
      headers: {
        authorization: "Bearer B2_MCP_CANARY_SECRET_HEADER_AUTH",
        "x-b2-key": "B2_MCP_CANARY_SECRET_HEADER_B2_KEY",
      },
      credentials: {
        appKey: "B2_MCP_CANARY_SECRET_NESTED_APP_KEY",
        nested: {
          masterKey: "B2_MCP_CANARY_SECRET_DEEP_MASTER_KEY",
          sessionToken: "B2_MCP_CANARY_SECRET_DEEP_SESSION_TOKEN",
        },
      },
      err,
    },
    "observability.redaction",
  );
  flushLogsSync();
}

async function retryBudgetProbe(): Promise<void> {
  initLogging();
  _resetRetryBudget();
  for (let i = 0; i < 100; i++) _consumeRetryToken();
  try {
    await withRetry(async () => {
      throw {
        message: "rate limited B2_MCP_CANARY_SECRET_RETRY_MESSAGE",
        response: {
          status: 429,
          headers: { authorization: "Bearer B2_MCP_CANARY_SECRET_RETRY_AUTH" },
          data: { applicationKey: "B2_MCP_CANARY_SECRET_RETRY_BODY_KEY" },
        },
      };
    }, 1);
  } catch (err) {
    writeJson({ status: (err as { response: { status: number } }).response.status });
  }
  flushLogsSync();
}

async function policyConfirmationProbe(): Promise<void> {
  initLogging();
  const config = testConfig("policy");
  const wrapped = createAuditedToolCallback(
    "b2_delete_bucket",
    async (args) => {
      const gate = checkDestructive("b2_delete_bucket", args, config);
      return gate.ok ? toolSuccess("deleted") : toolError(gate.error);
    },
    config,
  );
  const result = await wrapped(
    {
      bucketId: "bucket-with-confirmation-required",
      confirm: false,
      nested: { applicationKey: "B2_MCP_CANARY_SECRET_POLICY_ARG" },
    },
    {},
  );
  writeJson(result);
  flushLogsSync();
}

async function policyConfirmFallbackProbe(): Promise<void> {
  initLogging();
  const config = testConfig("fallback");
  const wrapped = createAuditedToolCallback(
    "b2_delete_bucket",
    async (args) => {
      const gate = checkDestructive("b2_delete_bucket", args, config);
      return gate.ok ? toolSuccess("deleted") : toolError(gate.error);
    },
    config,
  );
  const result = await wrapped(
    {
      bucketId: "bucket-with-model-confirm",
      confirm: true,
      nested: { applicationKey: "B2_MCP_CANARY_SECRET_FALLBACK_ARG" },
    },
    {},
  );
  writeJson(result);
  flushLogsSync();
}

async function thrownFailureProbe(): Promise<void> {
  initLogging();
  const config = testConfig("failure");
  const wrapped = createAuditedToolCallback(
    "b2_list_buckets",
    async () => {
      throw Object.assign(new Error("upstream failed B2_MCP_CANARY_SECRET_THROWN_MESSAGE"), {
        code: "B2_MCP_CANARY_SECRET_THROWN_CODE",
        status: 503,
        requestId: "B2_MCP_CANARY_SECRET_THROWN_REQUEST",
        errno: -2,
        syscall: "open",
        path: "/tmp/b2-mcp-observability-safe-path",
      });
    },
    config,
  );
  try {
    await wrapped(
      {
        bucketName: "failure-bucket",
        secret: "B2_MCP_CANARY_SECRET_THROWN_ARG",
      },
      {},
    );
  } catch (err) {
    const failure = err as Error & {
      code?: unknown;
      errno?: unknown;
      path?: unknown;
      requestId?: unknown;
      status?: unknown;
      syscall?: unknown;
    };
    writeJson({
      message: failure.message,
      code: failure.code,
      status: failure.status,
      requestId: failure.requestId,
      errno: failure.errno,
      syscall: failure.syscall,
      path: failure.path,
    });
  }
  flushLogsSync();
}

async function accessorSafetyProbe(): Promise<void> {
  initLogging();
  const payload: Record<string, unknown> = {};
  let getterReads = 0;
  defineThrowingGetter(payload, "authorization", "B2_MCP_CANARY_SECRET_AUTH_GETTER");
  Object.defineProperty(payload, "metadata", {
    enumerable: true,
    get() {
      getterReads++;
      throw new Error("B2_MCP_CANARY_SECRET_METADATA_GETTER");
    },
  });

  logger.info(payload, "observability.accessor");

  const hostileProxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("B2_MCP_CANARY_SECRET_PROXY_KEYS");
      },
    },
  );
  logger.info(hostileProxy, "observability.sanitizerFailure");

  writeJson({ getterReads });
  flushLogsSync();
}

async function environmentProbe(): Promise<void> {
  writeJson({
    npm: process.env.NPM_TOKEN ?? null,
    gh: process.env.GH_TOKEN ?? null,
    github: process.env.GITHUB_TOKEN ?? null,
    aws: process.env.AWS_SECRET_ACCESS_KEY ?? null,
    serviceToken: process.env.SERVICE_TOKEN ?? null,
    serviceSecret: process.env.SERVICE_SECRET ?? null,
  });
}

const probes: Record<ProbeName, () => Promise<void>> = {
  "accessor-safety": accessorSafetyProbe,
  environment: environmentProbe,
  "policy-confirm-fallback": policyConfirmFallbackProbe,
  "policy-confirmation": policyConfirmationProbe,
  redaction: redactionProbe,
  "retry-budget": retryBudgetProbe,
  "thrown-failure": thrownFailureProbe,
};

const probeName = process.argv[2] as ProbeName | undefined;

if (!probeName || !(probeName in probes)) {
  process.stderr.write(`Unknown logging probe: ${probeName ?? "(missing)"}\n`);
  process.exit(2);
}

probes[probeName]().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
