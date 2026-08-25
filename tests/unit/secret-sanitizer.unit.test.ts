import { createAuditedToolCallback } from "../../src/server";
import { logger } from "../../src/utils/logger";
import { toolError, toolJson } from "../../src/utils/errors";
import {
  configuredSecretValuesFromConfig,
  LOGGER_SECRET_REDACTION_PATHS,
  LOG_SANITIZER_FAILURE,
  sanitizeForMcpOutput,
  sanitizeError,
  sanitizeProviderCode,
  sanitizeProviderRequestId,
  sanitizeStructuredLogValue,
  sanitizeText,
  SECRET_SANITIZER_REDACTION,
  STRUCTURED_SECRET_FIELD_NAMES,
  TEXT_SECRET_LABELS,
} from "../../src/utils/secret-sanitizer";
import { B2Config } from "../../src/utils/types";

const CANARY = "B2_MCP_CANARY_SECRET_issue_58_do_not_leak";
const CONFIGURED_APPLICATION_KEY = "configured-application-key-value";
const CONFIGURED_APP_KEY = "configured-app-key-value";
const CONFIGURED_MASTER_KEY = "configured-master-key-value";
const cfg = {
  applicationKeyId: "test-key-id",
  applicationKey: CONFIGURED_APPLICATION_KEY,
  appKeyId: "test-app-key-id",
  appKey: CONFIGURED_APP_KEY,
  masterKeyId: "test-master-key-id",
  masterKey: CONFIGURED_MASTER_KEY,
} as B2Config;

function expectNoCanary(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(CANARY);
}

describe("secret sanitizer canary policy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("redacts sensitive B2/API response fields from MCP JSON content", async () => {
    const result = await toolJson({
      applicationKeyId: "key-id-is-non-secret",
      applicationKey: CANARY,
      appKey: CANARY,
      masterKey: CANARY,
      masterApplicationKey: CANARY,
      authorizationToken: CANARY,
      password: CANARY,
      uploadAuthToken: CANARY,
      uploadAuthorizationToken: CANARY,
      uploadUrl: CANARY,
      targetConfiguration: {
        hmacSha256SigningSecret: CANARY,
        customHeaders: [{ name: "X-Auth", value: CANARY }],
      },
      nested: {
        secretAccessKey: CANARY,
        continuationToken: "page-2",
        nextContinuationToken: "page-3",
      },
    });
    const parsed = result.structuredContent as any;

    expectNoCanary(result);
    expect(result.content[0].text).not.toContain(CANARY);
    expect(parsed.applicationKeyId).toBe("key-id-is-non-secret");
    expect(parsed.applicationKey).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.appKey).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.masterKey).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.masterApplicationKey).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.authorizationToken).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.password).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.uploadAuthToken).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.uploadAuthorizationToken).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.uploadUrl).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.targetConfiguration.hmacSha256SigningSecret).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.targetConfiguration.customHeaders[0].value).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.nested.secretAccessKey).toBe(SECRET_SANITIZER_REDACTION);
    expect(parsed.nested.continuationToken).toBe("page-2");
    expect(parsed.nested.nextContinuationToken).toBe("page-3");
  });

  it("does not redact allowed short-lived presigned URL bearer fields", async () => {
    const url =
      "https://example.s3.us-west-004.backblazeb2.com/bucket/object?X-Amz-Signature=abc123";
    const result = await toolJson({ url, operation: "GetObject", expiresIn: 3600 });
    const parsed = result.structuredContent as any;
    expect(parsed.url).toBe(url);
  });

  it("redacts every shared text secret label", () => {
    for (const label of TEXT_SECRET_LABELS) {
      expect(sanitizeText(`${label}=${CANARY}`)).not.toContain(CANARY);
      expect(sanitizeText(`${label}: "${CANARY}"`)).not.toContain(CANARY);
    }
  });

  it("redacts bearer and basic authorization values after an authorization label", () => {
    expect(sanitizeText("Authorization: Bearer bearer-token-secret")).not.toContain(
      "bearer-token-secret",
    );
    expect(sanitizeText("authorization: Basic basic-token-secret")).not.toContain(
      "basic-token-secret",
    );
  });

  it("redacts JSON-formatted sensitive fields in text without parsing the whole string", () => {
    const json = `{"applicationKey":"json-application-secret","authorizationToken":"json-auth-secret","metadata":"keep"}`;

    expect(sanitizeText(json)).toBe(
      `{"applicationKey":"${SECRET_SANITIZER_REDACTION}","authorizationToken":"${SECRET_SANITIZER_REDACTION}","metadata":"keep"}`,
    );
  });

  it("redacts JSON-formatted sensitive fields from sanitized Error objects", () => {
    const safe = sanitizeError(
      new Error(`{"applicationKey":"${CANARY}","authorizationToken":"${CONFIGURED_APP_KEY}"}`),
      { secrets: [CONFIGURED_APP_KEY] },
    );

    expect(safe.message).not.toContain(CANARY);
    expect(safe.message).not.toContain(CONFIGURED_APP_KEY);
  });

  it("sanitizes log objects without invoking accessors", () => {
    const payload: Record<string, unknown> = {};
    let getterReads = 0;
    Object.defineProperty(payload, "authorization", {
      enumerable: true,
      get() {
        getterReads++;
        throw new Error(CANARY);
      },
    });
    Object.defineProperty(payload, "metadata", {
      enumerable: true,
      get() {
        getterReads++;
        throw new Error(CANARY);
      },
    });

    const safe = sanitizeStructuredLogValue(payload);

    expect(getterReads).toBe(0);
    expect(safe).toEqual({
      authorization: SECRET_SANITIZER_REDACTION,
      metadata: "[accessor]",
    });
    expectNoCanary(safe);
  });

  it("sanitizes log arrays without invoking accessors", () => {
    const payload: unknown[] = [];
    let getterReads = 0;
    Object.defineProperty(payload, "0", {
      enumerable: true,
      get() {
        getterReads++;
        throw new Error(CANARY);
      },
    });
    payload[1] = {
      applicationKey: CANARY,
    };

    const safe = sanitizeStructuredLogValue(payload) as unknown[];

    expect(getterReads).toBe(0);
    expect(Array.isArray(safe)).toBe(true);
    expect(safe[0]).toBe("[accessor]");
    expect(safe[1]).toEqual({ applicationKey: SECRET_SANITIZER_REDACTION });
    expectNoCanary(safe);
  });

  it("redacts nested MCP output values without invoking hostile accessors", () => {
    const overlappingSecret = "configured-overlap-secret";
    const longerOverlappingSecret = `${overlappingSecret}-extended`;
    const payload: Record<string, unknown> = {
      headers: {
        cookie: longerOverlappingSecret,
        "set-cookie": "session=configured-cookie-secret",
        "x-b2-key": "configured-header-secret",
      },
      nested: {
        secretName: "public-secret-name",
        temporarySecret: CANARY,
        uploadToken: "configured-upload-token-secret",
        nextToken: "page-token",
      },
    };
    const arrayPayload = [longerOverlappingSecret, { note: CANARY }];
    Object.defineProperty(arrayPayload, "authorization", {
      enumerable: true,
      value: "Bearer configured-array-token-secret",
    });
    payload.arrayPayload = arrayPayload;
    payload.self = payload;
    let getterReads = 0;
    Object.defineProperty(payload, "hostile", {
      enumerable: true,
      get() {
        getterReads++;
        throw new Error(CANARY);
      },
    });
    Object.defineProperty(payload, "nonEnumerableSecret", {
      enumerable: false,
      value: CANARY,
    });

    const safe = sanitizeForMcpOutput(payload, {
      secrets: [
        overlappingSecret,
        longerOverlappingSecret,
        "configured-cookie-secret",
        "configured-header-secret",
        "configured-upload-token-secret",
        "configured-array-token-secret",
      ],
    }) as Record<string, any>;

    expect(getterReads).toBe(0);
    expect(safe.hostile).toBe("[accessor]");
    expect(safe.self).toBe("[circular]");
    expect(safe.nested.secretName).toBe("public-secret-name");
    expect(safe.nested.temporarySecret).toBe(SECRET_SANITIZER_REDACTION);
    expect(safe.nested.uploadToken).toBe(SECRET_SANITIZER_REDACTION);
    expect(safe.nested.nextToken).toBe("page-token");
    expect(safe.arrayPayload.authorization).toBe(SECRET_SANITIZER_REDACTION);
    expect(safe.arrayPayload[0]).toBe(SECRET_SANITIZER_REDACTION);
    expectNoCanary(safe);
    expect(JSON.stringify(safe)).not.toContain(overlappingSecret);
    expect(JSON.stringify(safe)).not.toContain(longerOverlappingSecret);
  });

  it("sanitizes proxied log arrays without reading length getters", () => {
    const payload = [{ applicationKey: CANARY }];
    let lengthReads = 0;
    const proxied = new Proxy(payload, {
      get(target, property, receiver) {
        if (property === "length") {
          lengthReads++;
          throw new Error(CANARY);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const safe = sanitizeStructuredLogValue(proxied) as unknown[];

    expect(lengthReads).toBe(0);
    expect(Array.isArray(safe)).toBe(true);
    expect(safe).toHaveLength(1);
    expect(safe[0]).toEqual({ applicationKey: SECRET_SANITIZER_REDACTION });
    expectNoCanary(safe);
  });

  it("returns inert log values for callables and built-ins", () => {
    const createdAt = new Date("2026-08-21T00:00:00.000Z");
    Object.defineProperty(createdAt, "toJSON", {
      enumerable: true,
      value: () => CANARY,
    });
    const bytes = Buffer.from(CANARY);
    let byteLengthReads = 0;
    for (const key of ["byteLength", "length"] as const) {
      Object.defineProperty(bytes, key, {
        enumerable: true,
        get() {
          byteLengthReads++;
          throw new Error(CANARY);
        },
      });
    }
    Object.defineProperty(bytes, "toJSON", {
      enumerable: true,
      value: () => ({ applicationKey: CANARY }),
    });

    const safe = sanitizeStructuredLogValue({
      toJSON: () => CANARY,
      fn: () => CANARY,
      createdAt,
      bytes,
    }) as {
      bytes: { byteLength: number; type: string };
      createdAt: string;
      fn: string;
      toJSON: string;
    };

    expect(safe.toJSON).toBe("[function]");
    expect(safe.fn).toBe("[function]");
    expect(safe.createdAt).toBe("2026-08-21T00:00:00.000Z");
    expect(safe.bytes).toEqual({ type: "Buffer", byteLength: Buffer.byteLength(CANARY) });
    expect(byteLengthReads).toBe(0);
    expect(JSON.stringify(safe)).not.toContain(CANARY);
  });

  it("sanitizes proxied log buffers without reading length traps", () => {
    const bytes = Buffer.from(CANARY);
    let lengthReads = 0;
    const proxied = new Proxy(bytes, {
      get(target, property, receiver) {
        if (property === "byteLength" || property === "length") {
          lengthReads++;
          throw new Error(CANARY);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const safe = sanitizeStructuredLogValue(proxied);

    expect(lengthReads).toBe(0);
    expect(safe).toEqual({ type: "Buffer", byteLength: 0 });
    expectNoCanary(safe);
  });

  it("handles configured secret edge values and non-string text inputs", () => {
    const secret = "configured-edge-secret";
    const longerSecret = `${secret}-extended`;

    const sanitized = sanitizeText(
      {
        toString: () => `applicationKey=${longerSecret} ${secret} appKey=[redacted] not-json-token`,
      },
      {
        secrets: [undefined, "", "   ", "short", SECRET_SANITIZER_REDACTION, secret, longerSecret],
      },
    );

    expect(sanitized).not.toContain(secret);
    expect(sanitized).not.toContain(longerSecret);
    expect(sanitized).toContain(`appKey=${SECRET_SANITIZER_REDACTION}`);
    expect(sanitizeText("applicationKey=[redacted]")).toBe(
      `applicationKey=${SECRET_SANITIZER_REDACTION}`,
    );
    expect(sanitizeText(404)).toBe("404");
    expect(sanitizeError({ toString: () => `failed ${CANARY}` }).message).not.toContain(CANARY);
  });

  it("keeps MCP output representations for callables and built-ins", () => {
    const safe = sanitizeForMcpOutput({
      createdAt: new Date("2026-08-21T00:00:00.000Z"),
      invalidDate: new Date(Number.NaN),
      bytes: Buffer.from("ok"),
      fn: () => "ignored",
    }) as {
      bytes: unknown;
      createdAt: unknown;
      fn?: unknown;
      invalidDate: unknown;
    };

    expect(safe.createdAt).toBeInstanceOf(Date);
    expect(safe.invalidDate).toBeInstanceOf(Date);
    expect(Buffer.isBuffer(safe.bytes)).toBe(true);
    expect(typeof safe.fn).toBe("function");
    expect(JSON.stringify(safe)).toBe(
      '{"createdAt":"2026-08-21T00:00:00.000Z","invalidDate":null,"bytes":{"type":"Buffer","data":[111,107]}}',
    );
  });

  it("preserves safe Error metadata in structured logs", () => {
    const err = Object.assign(new Error(`failed with ${CANARY}`), {
      code: "ENOENT",
      errno: -2,
      syscall: "open",
      path: "/tmp/b2-mcp-safe-metadata",
      authorizationToken: CANARY,
      details: {
        applicationKey: CANARY,
      },
    });

    const safe = sanitizeStructuredLogValue(err) as Error & {
      authorizationToken?: unknown;
      code?: unknown;
      details?: { applicationKey?: unknown };
      errno?: unknown;
      path?: unknown;
      syscall?: unknown;
    };

    expect(safe).toBeInstanceOf(Error);
    expect(safe.message).toBe("failed with [redacted]");
    expect(safe.code).toBe("ENOENT");
    expect(safe.errno).toBe(-2);
    expect(safe.syscall).toBe("open");
    expect(safe.path).toBe("/tmp/b2-mcp-safe-metadata");
    expect(safe.authorizationToken).toBe(SECRET_SANITIZER_REDACTION);
    expect(safe.details?.applicationKey).toBe(SECRET_SANITIZER_REDACTION);
    expectNoCanary(safe);
  });

  it("reads Error core fields without invoking accessors", () => {
    const err = new Error("placeholder");
    let getterReads = 0;
    for (const key of ["message", "name", "stack"] as const) {
      Object.defineProperty(err, key, {
        configurable: true,
        enumerable: true,
        get() {
          getterReads++;
          throw new Error(CANARY);
        },
      });
    }

    const safe = sanitizeStructuredLogValue(err) as Error;

    expect(getterReads).toBe(0);
    expect(safe.message).toBe("[accessor]");
    expect(safe.name).toBe("[accessor]");
    expect(safe.stack).toBe("[accessor]");
    expectNoCanary(safe);
  });

  it("sanitizes circular Error metadata and non-string Error core fields", () => {
    const err = new Error("placeholder");
    Object.defineProperty(err, "message", {
      configurable: true,
      enumerable: true,
      value: 404,
    });
    Object.defineProperty(err, "name", {
      configurable: true,
      enumerable: true,
      value: true,
    });
    Object.defineProperty(err, "stack", {
      configurable: true,
      enumerable: true,
      value: 123n,
    });
    (err as any).self = err;
    const circularDetails: Record<string, unknown> = {};
    circularDetails.self = circularDetails;
    (err as any).details = circularDetails;

    const safe = sanitizeStructuredLogValue(err) as Error & {
      details?: { self?: unknown };
      self?: unknown;
    };

    expect(safe.message).toBe("404");
    expect(safe.name).toBe("true");
    expect(safe.stack).toBe("123");
    expect(safe.self).toBe("[circular]");
    expect(safe.details?.self).toBe("[circular]");
  });

  it("keeps constructor stack fallback when the original Error stack is missing", () => {
    const err = new Error("no stack");
    delete err.stack;

    const safe = sanitizeStructuredLogValue(err) as Error;

    expect(safe.message).toBe("no stack");
    expect(safe.stack).toContain("Error: no stack");
  });

  it("redacts logger-only credential handles at arbitrary log depths", () => {
    const safe = sanitizeStructuredLogValue({
      outer: {
        inner: {
          details: {
            accessKeyId: "safe-to-hide-access-key-id",
            appKeyId: "safe-to-hide-app-key-id",
            applicationKeyId: "safe-to-hide-application-key-id",
            masterKeyId: "safe-to-hide-master-key-id",
          },
        },
      },
    });

    expect(safe).toEqual({
      outer: {
        inner: {
          details: {
            accessKeyId: SECRET_SANITIZER_REDACTION,
            appKeyId: SECRET_SANITIZER_REDACTION,
            applicationKeyId: SECRET_SANITIZER_REDACTION,
            masterKeyId: SECRET_SANITIZER_REDACTION,
          },
        },
      },
    });
    expect(sanitizeForMcpOutput({ applicationKeyId: "key-id-is-non-secret" })).toEqual({
      applicationKeyId: "key-id-is-non-secret",
    });
  });

  it("leaves non-secret JSON-valued strings byte-for-byte unchanged", () => {
    const metadata = `{"plain":"value","nested":{"count":2}}`;
    const largeJsonLookingString = `[${Array.from({ length: 2000 }, (_, i) => `"item-${i}"`).join(
      ",",
    )}]`;
    const result = sanitizeForMcpOutput({ metadata, largeJsonLookingString });

    expect(result).toEqual({ metadata, largeJsonLookingString });
  });

  it("redacts supported configured secret env aliases from text", () => {
    const oldEnv = {
      B2_APPLICATION_KEY: process.env.B2_APPLICATION_KEY,
      B2_APP_KEY: process.env.B2_APP_KEY,
      B2_MASTER_KEY: process.env.B2_MASTER_KEY,
      B2_CREDENTIAL_TENANT_APPLICATION_KEY: process.env.B2_CREDENTIAL_TENANT_APPLICATION_KEY,
      B2_CREDENTIAL_TENANT_APP_KEY: process.env.B2_CREDENTIAL_TENANT_APP_KEY,
      B2_CREDENTIAL_TENANT_MASTER_KEY: process.env.B2_CREDENTIAL_TENANT_MASTER_KEY,
    };
    process.env.B2_APPLICATION_KEY = "env-application-secret-value";
    process.env.B2_APP_KEY = "env-app-secret-value";
    process.env.B2_MASTER_KEY = "env-master-secret-value";
    process.env.B2_CREDENTIAL_TENANT_APPLICATION_KEY = "env-tenant-secret-value";
    process.env.B2_CREDENTIAL_TENANT_APP_KEY = "env-tenant-app-secret-value";
    process.env.B2_CREDENTIAL_TENANT_MASTER_KEY = "env-tenant-master-secret-value";

    try {
      const text = sanitizeText(
        [
          process.env.B2_APPLICATION_KEY,
          process.env.B2_APP_KEY,
          process.env.B2_MASTER_KEY,
          process.env.B2_CREDENTIAL_TENANT_APPLICATION_KEY,
          process.env.B2_CREDENTIAL_TENANT_APP_KEY,
          process.env.B2_CREDENTIAL_TENANT_MASTER_KEY,
        ].join(" "),
      );
      expect(text).not.toContain("env-application-secret-value");
      expect(text).not.toContain("env-app-secret-value");
      expect(text).not.toContain("env-master-secret-value");
      expect(text).not.toContain("env-tenant-secret-value");
      expect(text).not.toContain("env-tenant-app-secret-value");
      expect(text).not.toContain("env-tenant-master-secret-value");
    } finally {
      for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("redacts sensitive provider error messages from MCP error content", () => {
    const result = toolError({
      response: {
        status: 400,
        data: {
          code: "bad_request",
          message: `{"applicationKey":"${CANARY}","authorizationToken":"${CANARY}"}`,
        },
      },
    });
    expect(result.isError).toBe(true);
    expectNoCanary(result);
  });

  it("redacts configured secret values from wrapped tool results", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const wrapped = createAuditedToolCallback(
      "t",
      vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: `${CONFIGURED_APPLICATION_KEY} ${CONFIGURED_APP_KEY} ${CONFIGURED_MASTER_KEY}`,
          },
        ],
      }),
      cfg,
    );

    const result = await wrapped({}, {});

    expect(JSON.stringify(result)).not.toContain(CONFIGURED_APPLICATION_KEY);
    expect(JSON.stringify(result)).not.toContain(CONFIGURED_APP_KEY);
    expect(JSON.stringify(result)).not.toContain(CONFIGURED_MASTER_KEY);
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(CONFIGURED_APPLICATION_KEY);
  });

  it("redacts JSON-formatted sensitive fields from wrapped response strings", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const wrapped = createAuditedToolCallback(
      "t",
      vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: `{"applicationKey":"${CANARY}","authorizationToken":"${CONFIGURED_APPLICATION_KEY}"}`,
          },
        ],
      }),
      cfg,
    );

    const result = await wrapped({}, {});

    expectNoCanary(result);
    expect(JSON.stringify(result)).not.toContain(CONFIGURED_APPLICATION_KEY);
    expectNoCanary(infoSpy.mock.calls);
  });

  it("redacts configured secret values from wrapped tool errors", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const wrapped = createAuditedToolCallback(
      "t",
      vi.fn().mockResolvedValue(toolError(new Error(`failed with ${CONFIGURED_APPLICATION_KEY}`))),
      cfg,
    );

    const result = await wrapped({}, {});

    expect(JSON.stringify(result)).not.toContain(CONFIGURED_APPLICATION_KEY);
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(CONFIGURED_APPLICATION_KEY);
  });

  it("redacts structured logs and rethrown handler errors", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const wrapped = createAuditedToolCallback(
      "t",
      vi
        .fn()
        .mockRejectedValue(
          new Error(
            `{"applicationKey":"${CANARY}","authorizationToken":"${CONFIGURED_APPLICATION_KEY}"}`,
          ),
        ),
      cfg,
    );

    try {
      await wrapped({}, {});
      throw new Error("expected handler to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(CANARY);
      expect((err as Error).message).not.toContain(CONFIGURED_APPLICATION_KEY);
    }

    expectNoCanary(warnSpy.mock.calls);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(CONFIGURED_APPLICATION_KEY);
  });

  it("redacts snapshots and CI artifact strings before persistence", () => {
    const snapshotPayload = sanitizeForMcpOutput({
      tool: "canary",
      applicationKey: CANARY,
    });
    const ciArtifactLog = sanitizeText(`authorizationToken=${CANARY}`);

    expectNoCanary(snapshotPayload);
    expect(ciArtifactLog).not.toContain(CANARY);
  });

  it("extracts configured secret values from the active config", () => {
    expect(configuredSecretValuesFromConfig(cfg)).toEqual([
      CONFIGURED_APPLICATION_KEY,
      CONFIGURED_APP_KEY,
      CONFIGURED_MASTER_KEY,
    ]);
    expect(configuredSecretValuesFromConfig()).toEqual([]);
  });

  it("sanitizes provider identifiers by configured secrets and allowed shapes", () => {
    expect(sanitizeProviderCode("valid.code-1")).toBe("valid.code-1");
    expect(sanitizeProviderCode("bad code")).toBe(SECRET_SANITIZER_REDACTION);
    expect(
      sanitizeProviderCode(CONFIGURED_APPLICATION_KEY, { secrets: [CONFIGURED_APPLICATION_KEY] }),
    ).toBe(SECRET_SANITIZER_REDACTION);
    expect(sanitizeProviderCode(undefined)).toBe("unknown_error");
    expect(sanitizeProviderRequestId("request/id:1")).toBe("request/id:1");
    expect(sanitizeProviderRequestId(undefined)).toBeUndefined();
    expect(sanitizeProviderRequestId(`request-${CANARY}`)).toBe(SECRET_SANITIZER_REDACTION);
  });

  it("keeps sanitizer and logger secret field vocabularies aligned", () => {
    for (const field of STRUCTURED_SECRET_FIELD_NAMES) {
      expect(LOGGER_SECRET_REDACTION_PATHS).toContain(field);
    }
    expect(LOG_SANITIZER_FAILURE).toBe("[log_sanitizer_failed]");
  });
});
