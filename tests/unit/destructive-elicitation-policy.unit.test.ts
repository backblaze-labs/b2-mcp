import {
  CLIENT_CAPABILITIES_META_KEY,
  type ClientCapabilities,
  createRequestStateCodec,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import type {
  DestructiveElicitationContextProviders,
  DestructiveElicitationState,
} from "../../src/utils/destructive-elicitation";
import type { B2Config } from "../../src/utils/types";

let elicitation: typeof import("../../src/utils/destructive-elicitation");
let gate: typeof import("../../src/utils/destructive-gate");
let info: ReturnType<typeof vi.spyOn>;
const savedEnv = process.env;
const now = Date.parse("2026-11-21T12:00:00Z");
const tool = "s3_delete_object";
const args = { bucket: "photos", key: "old.jpg" };
const effect = "permanently delete an object";
const modern = "2026-07-28";
const form: ClientCapabilities = { elicitation: { form: {} } };
const config = (): B2Config =>
  ({
    applicationKeyId: "application-id",
    applicationKey: "application-secret",
    appKeyId: "application-id",
    appKey: "legacy-secret",
    masterKeyId: "master-id",
    masterKey: "master-secret",
    credentialFingerprint: "tenant-fingerprint",
    destructivePolicy: "elicit",
  }) as B2Config;

beforeEach(async () => {
  process.env = { ...savedEnv };
  delete process.env.B2_DESTRUCTIVE_ELICITATION;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.resetModules();
  elicitation = await import("../../src/utils/destructive-elicitation");
  gate = await import("../../src/utils/destructive-gate");
  const { logger } = await import("../../src/utils/logger");
  info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = savedEnv;
});

function extra(response?: unknown, state?: unknown) {
  return {
    mcpReq: {
      clientCapabilities: form,
      envelope: { [PROTOCOL_VERSION_META_KEY]: modern },
      ...(response === undefined ? {} : { inputResponses: { destructiveConfirmation: response } }),
      ...(state === undefined ? {} : { requestState: state }),
    },
  };
}

function state(overrides: Record<string, unknown> = {}): DestructiveElicitationState {
  return {
    v: 1,
    kind: "destructive-elicitation",
    toolName: tool,
    effect,
    argsDigest: gate.destructiveTargetDigest(config(), args),
    issuedAt: now,
    ...overrides,
  } as DestructiveElicitationState;
}

interface Result {
  isError?: boolean;
  resultType?: string;
  requestState?: string;
  inputRequests?: Record<string, unknown>;
  content?: Array<{ text?: string }>;
}

async function run(
  options: {
    extra?: unknown;
    config?: B2Config;
    original?: () => unknown;
    providers?: DestructiveElicitationContextProviders;
    onDecision?: (event: unknown) => void;
  } = {},
): Promise<Result> {
  return (await elicitation.maybeRequireDestructiveElicitation({
    toolName: tool,
    args,
    config: options.config ?? config(),
    extra: options.extra ?? extra(),
    sanitizerOptions: {},
    contextProviders: options.providers,
    onDecision: options.onDecision,
    runOriginal: options.original ?? (() => ({ content: [{ type: "text", text: "ran" }] })),
  })) as Result;
}

function expectRefusal(result: Result, reason: string) {
  expect(result.isError).toBe(true);
  expect(result.content?.[0]?.text).toContain("destructive_confirmation_refused");
  expect(result.content?.[0]?.text).toContain(reason);
}

describe("destructive elicitation request and response policy", () => {
  it("passes a non-destructive call through without requesting approval", async () => {
    const original = vi.fn(() => ({ content: [{ type: "text", text: "read-only result" }] }));
    const decision = vi.fn();
    const result = await elicitation.maybeRequireDestructiveElicitation({
      toolName: "s3_get_presigned_url",
      args: { operation: "GetObject" },
      extra: extra(),
      config: config(),
      sanitizerOptions: {},
      onDecision: decision,
      runOriginal: original,
    });
    expect(result).toEqual({ content: [{ type: "text", text: "read-only result" }] });
    expect(original).toHaveBeenCalledTimes(1);
    expect(decision).not.toHaveBeenCalled();
  });

  it.each(["allow", "block"] as const)(
    "delegates %s policy to the real inner gate",
    async (policy) => {
      const cfg = { ...config(), destructivePolicy: policy };
      const original = vi.fn(() => gate.checkDestructive(tool, args, cfg));
      const decision = vi.fn();
      const result = await run({ config: cfg, original, onDecision: decision });
      expect(result).toEqual(
        policy === "allow"
          ? { ok: true }
          : expect.objectContaining({
              ok: false,
              error: expect.objectContaining({ code: "destructive_policy_blocked" }),
            }),
      );
      expect(original).toHaveBeenCalledTimes(1);
      expect(decision).not.toHaveBeenCalled();
    },
  );

  it.each(["elicitation_disabled", "client_cannot_elicit"] as const)(
    "records %s fallback only after explicit model confirmation",
    async (reason) => {
      const cfg = { ...config(), destructivePolicy: "confirm" as const };
      if (reason === "elicitation_disabled") process.env.B2_DESTRUCTIVE_ELICITATION = "false";
      const context = reason === "client_cannot_elicit" ? {} : extra();
      for (const confirmed of [false, true]) {
        const callArgs = { ...args, ...(confirmed ? { confirm: true } : {}) };
        const original = vi.fn(() => gate.checkDestructive(tool, callArgs, cfg));
        const decision = vi.fn();
        info.mockClear();
        const result = await elicitation.maybeRequireDestructiveElicitation({
          toolName: tool,
          args: callArgs,
          extra: context,
          config: cfg,
          sanitizerOptions: {},
          onDecision: decision,
          runOriginal: original,
        });
        expect(result).toMatchObject({ ok: confirmed });
        expect(original).toHaveBeenCalledTimes(1);
        if (confirmed) {
          expect(decision).toHaveBeenCalledExactlyOnceWith({
            outcome: "fallback_accepted",
            confirmationSource: "model_confirm_parameter",
            confirmationFallbackReason: reason,
          });
          expect(info).toHaveBeenCalledWith(
            expect.objectContaining({
              destructiveConfirmationSource: "model_confirm_parameter",
              destructiveConfirmationFallbackReason: reason,
            }),
            "destructive.elicitation",
          );
        } else {
          expect(decision).not.toHaveBeenCalled();
          expect(info).not.toHaveBeenCalled();
        }
      }
    },
  );

  it("requests an unchecked approval checkbox with the complete literal schema", async () => {
    const original = vi.fn();
    const decision = vi.fn();
    const result = await run({ original, onDecision: decision });
    expect(elicitation.DESTRUCTIVE_ELICITATION_RESPONSE_KEY).toBe("destructiveConfirmation");
    expect(elicitation.DESTRUCTIVE_ELICITATION_REQUEST_STATE).toBe(
      "b2-mcp-destructive-elicitation-v1",
    );
    expect(result.resultType).toBe("input_required");
    expect(result.requestState).toMatch(/^b2-mcp-destructive-elicitation-v1\./);
    expect(result.inputRequests).toEqual({
      destructiveConfirmation: {
        method: "elicitation/create",
        params: {
          mode: "form",
          message:
            "s3_delete_object would permanently delete an object. Bucket: photos. Object key: old.jpg. Approve this destructive B2 operation?",
          requestedSchema: {
            type: "object",
            properties: {
              confirm: {
                type: "boolean",
                title: "Approve",
                description: "Approve this destructive B2 operation.",
                default: false,
              },
            },
            required: ["confirm"],
          },
        },
      },
    });
    expect(decision).toHaveBeenCalledExactlyOnceWith({ outcome: "requested" });
    expect(original).not.toHaveBeenCalled();
  });

  it.each(["decline", "cancel"] as const)(
    "records the exact %s refusal and reason without executing",
    async (action) => {
      const original = vi.fn();
      const decision = vi.fn();
      const result = await run({
        extra: extra({ action }, () => state()),
        original,
        onDecision: decision,
      });
      expectRefusal(result, `human confirmation was ${action}`);
      expect(decision).toHaveBeenCalledExactlyOnceWith({
        outcome: action === "decline" ? "declined" : "cancelled",
        reason: `human confirmation was ${action}`,
      });
      const log = JSON.parse(JSON.stringify(info.mock.calls.at(-1)?.[0]));
      expect(log).toMatchObject({
        reason: `human confirmation was ${action}`,
        outcome: action === "decline" ? "declined" : "cancelled",
      });
      expect(original).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, {}, { confirm: false }, { confirm: "true" }])(
    "requires an explicit boolean approval %#",
    async (content) => {
      const original = vi.fn();
      const result = await run({
        extra: extra({ action: "accept", ...(content === undefined ? {} : { content }) }, () =>
          state(),
        ),
        original,
      });
      expectRefusal(result, "human confirmation did not approve");
      expect(original).not.toHaveBeenCalled();
    },
  );

  it("runs with scoped gate consent after an accepted response and restores the context", async () => {
    const cfg = config();
    const original = vi.fn(() => {
      expect(gate.checkDestructive(tool, args, cfg)).toEqual({ ok: true });
      return { content: [{ type: "text", text: "approved" }] };
    });
    const decision = vi.fn();
    const result = await run({
      extra: extra({ action: "accept", content: { confirm: true } }, () => state()),
      original,
      config: cfg,
      onDecision: decision,
    });
    expect(result.content).toEqual([{ type: "text", text: "approved" }]);
    expect(original).toHaveBeenCalledTimes(1);
    expect(decision).toHaveBeenCalledExactlyOnceWith({
      outcome: "accepted",
      confirmationSource: "human_mcp_elicitation",
    });
    expect(gate.checkDestructive(tool, args, cfg).ok).toBe(false);
  });

  it.each(["0", " false ", " OFF "])(
    "refuses when elicitation is disabled by %s",
    async (value) => {
      process.env.B2_DESTRUCTIVE_ELICITATION = value;
      const original = vi.fn();
      expectRefusal(
        await run({ original }),
        "MCP elicitation is disabled on this server (B2_DESTRUCTIVE_ELICITATION), so no human can be prompted",
      );
      expect(original).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "true", "1"])("keeps elicitation enabled for %s", async (value) => {
    if (value !== undefined) process.env.B2_DESTRUCTIVE_ELICITATION = value;
    expect((await run()).resultType).toBe("input_required");
  });
});

describe("state structure, binding, and lifetime", () => {
  it.each([
    ["null", null],
    ["primitive", 7],
    ["version", { v: 2 }],
    ["kind", { kind: "other" }],
    ["tool", { toolName: 4 }],
    ["effect", { effect: null }],
    ["digest", { argsDigest: [] }],
    ["timestamp", { issuedAt: "now" }],
  ] as const)("refuses malformed %s decoded state before executing", async (name, change) => {
    const original = vi.fn();
    const payload =
      name === "null" || name === "primitive" ? change : state(change as Record<string, unknown>);
    const result = await run({
      extra: extra({ action: "accept", content: { confirm: true } }, () => payload),
      original,
    });
    expectRefusal(result, "requestState payload was invalid");
    expect(original).not.toHaveBeenCalled();
  });

  it.each([
    { toolName: "b2_delete_bucket" },
    { effect: "a different approved effect" },
    { argsDigest: "different-target-digest" },
  ])("refuses a changed state binding %#", async (change) => {
    const original = vi.fn();
    expectRefusal(
      await run({
        extra: extra({ action: "accept", content: { confirm: true } }, () => state(change)),
        original,
      }),
      "approved destructive target did not match this call",
    );
    expect(original).not.toHaveBeenCalled();
  });

  it.each([
    [599999, true],
    [600000, true],
    [600001, false],
  ] as const)(
    "enforces the decoded-state age boundary at %s milliseconds",
    async (age, allowed) => {
      const original = vi.fn(() => ({ content: [{ type: "text", text: "ran" }] }));
      const result = await run({
        extra: extra({ action: "accept", content: { confirm: true } }, () =>
          state({ issuedAt: now - age }),
        ),
        original,
      });
      if (allowed) expect(original).toHaveBeenCalledTimes(1);
      else {
        expectRefusal(result, "requestState expired");
        expect(original).not.toHaveBeenCalled();
      }
    },
  );

  it("contains codec verification failures without invoking the original callback", async () => {
    const original = vi.fn();
    const verify = vi.fn().mockRejectedValue(new Error("private-codec-detail"));
    const result = await run({
      extra: extra({ action: "accept", content: { confirm: true } }, "opaque-state"),
      original,
      providers: { requestStateCodec: { mint: vi.fn(), verify } },
    });
    expectRefusal(result, "requestState payload was invalid");
    expect(JSON.stringify(result)).not.toContain("private-codec-detail");
    expect(verify).toHaveBeenCalledTimes(1);
    expect(original).not.toHaveBeenCalled();
  });

  it("records malformed state as a refused decision with its public reason", async () => {
    const original = vi.fn();
    const decision = vi.fn();
    const result = await run({
      extra: extra({ action: "accept", content: { confirm: true } }, () => state({ v: 2 })),
      original,
      onDecision: decision,
    });
    expectRefusal(result, "requestState payload was invalid");
    expect(decision).toHaveBeenCalledExactlyOnceWith({
      outcome: "refused",
      reason: "requestState payload was invalid",
    });
    expect(JSON.parse(JSON.stringify(info.mock.calls.at(-1)?.[0]))).toEqual({
      tool,
      effect,
      decision: "refused",
      outcome: "refused",
      reason: "requestState payload was invalid",
    });
    expect(original).not.toHaveBeenCalled();
  });

  it.each(["applicationKey", "appKey", "masterKey", "credentialFingerprint"] as const)(
    "binds the real signed codec to %s",
    async (part) => {
      const cfg = config();
      const first = elicitation.createDestructiveElicitationRequestStateCodec(cfg);
      const token = await first.mint(state(), {} as never);
      const changed = elicitation.createDestructiveElicitationRequestStateCodec({
        ...cfg,
        [part]: `${cfg[part]}-changed`,
      });
      await expect(first.verify(token, {} as never)).resolves.toMatchObject({
        toolName: tool,
        issuedAt: now,
      });
      await expect(changed.verify(token, {} as never)).rejects.toThrow();
    },
  );

  it("normalizes missing and empty interior key parts in the real codec", async () => {
    const cfg = { applicationKey: "application-secret", masterKey: "master-secret" } as B2Config;
    const first = elicitation.createDestructiveElicitationRequestStateCodec(cfg);
    const token = await first.mint(state(), {} as never);
    const same = elicitation.createDestructiveElicitationRequestStateCodec({
      ...cfg,
      appKey: "",
      credentialFingerprint: "",
    });
    await expect(same.verify(token, {} as never)).resolves.toMatchObject({ toolName: tool });
    const key = Uint8Array.from(
      Buffer.from("7dc74044338f42179fcda5c313f8dcdd97e6c5c2187b5e199337417bd957b1a7", "hex"),
    );
    const sdk = createRequestStateCodec<DestructiveElicitationState>({ key, ttlSeconds: 600 });
    await expect(
      sdk.verify(token.slice("b2-mcp-destructive-elicitation-v1.".length), {} as never),
    ).resolves.toMatchObject({ toolName: tool });
  });

  it("rejects a valid signed token under a different same-length namespace prefix", async () => {
    const codec = elicitation.createDestructiveElicitationRequestStateCodec(config());
    const token = await codec.mint(state(), {} as never);
    await expect(codec.verify(`x${token.slice(1)}`, {} as never)).rejects.toThrow(/malformed/);
  });

  it("expires real codec tokens after ten minutes", async () => {
    const codec = elicitation.createDestructiveElicitationRequestStateCodec(config());
    const token = await codec.mint(state(), {} as never);
    vi.setSystemTime(now + 601000);
    await expect(codec.verify(token, {} as never)).rejects.toThrow();
  });

  it("interoperates with the SDK codec using an independently derived domain key", async () => {
    // Python hashlib SHA-256 vector for the elicitation-state domain prefix
    // and four NUL-separated credential parts from config().
    const key = Uint8Array.from(
      Buffer.from("e92dcf6b37e00dd3f302e116e2277b8827e1f4522f7f25e6ce7a4bd78e54e0aa", "hex"),
    );
    const sdk = createRequestStateCodec<DestructiveElicitationState>({ key, ttlSeconds: 600 });
    const codec = elicitation.createDestructiveElicitationRequestStateCodec(config());
    const token = await codec.mint(state(), {} as never);
    const prefix = "b2-mcp-destructive-elicitation-v1.";
    expect(token.startsWith(prefix)).toBe(true);
    await expect(sdk.verify(token.slice(prefix.length), {} as never)).resolves.toMatchObject(
      state(),
    );
    const raw = await sdk.mint(state(), {} as never);
    await expect(codec.verify(`${prefix}${raw}`, {} as never)).resolves.toMatchObject(state());
  });
});

describe("negotiated capability and protocol precedence", () => {
  it("treats an absent request envelope as lacking return-based input support", () => {
    expect(
      elicitation.clientCanUseReturnBasedElicitation({ mcpReq: { clientCapabilities: form } }),
    ).toBe(false);
  });
  it.each([
    { mcpReq: { clientCapabilities: form, envelope: { [PROTOCOL_VERSION_META_KEY]: modern } } },
    {
      mcpReq: {
        envelope: { [PROTOCOL_VERSION_META_KEY]: modern, [CLIENT_CAPABILITIES_META_KEY]: form },
      },
    },
    { clientCapabilities: form, mcpReq: { envelope: { [PROTOCOL_VERSION_META_KEY]: modern } } },
  ])("reads form support from each SDK metadata location %#", (context) => {
    expect(elicitation.clientSupportsFormElicitation(context)).toBe(true);
    expect(elicitation.clientCanUseReturnBasedElicitation(context)).toBe(true);
  });

  it.each([
    [undefined, false],
    [null, false],
    [false, false],
    ["form", false],
    [42, false],
    [true, false],
    [[], false],
    [{}, true],
    [{ form: {} }, true],
    [{ url: {} }, false],
  ])("recognizes only object form capabilities %#", (capabilities, expected) => {
    expect(
      elicitation.clientSupportsFormElicitation({
        clientCapabilities: { elicitation: capabilities },
      }),
    ).toBe(expected);
  });

  it("uses provider capabilities first and falls back only when absent", () => {
    const context = { mcpReq: { clientCapabilities: form } };
    expect(
      elicitation.clientSupportsFormElicitation(context, () => ({ elicitation: { url: {} } })),
    ).toBe(false);
    expect(elicitation.clientSupportsFormElicitation(context, () => undefined)).toBe(true);
    expect(
      elicitation.clientSupportsFormElicitation(
        { clientCapabilities: { elicitation: { url: {} } } },
        () => form,
      ),
    ).toBe(true);
  });

  it.each([
    [undefined, true],
    ["", true],
    [modern, true],
    ["2025-11-25", false],
  ])("uses provider protocol version %s with envelope fallback", (version, expected) => {
    expect(
      elicitation.clientCanUseReturnBasedElicitation(extra(), {
        getProtocolVersion: () => version,
      }),
    ).toBe(expected);
  });

  it.each([undefined, null, 42, "", "2025-11-25"])(
    "rejects missing or unsupported envelope version %s",
    (version) => {
      expect(
        elicitation.clientCanUseReturnBasedElicitation({
          mcpReq: { clientCapabilities: form, envelope: { [PROTOCOL_VERSION_META_KEY]: version } },
        }),
      ).toBe(false);
    },
  );

  it("does not inherit a form capability from an object's prototype", () => {
    const elicitationCapability = Object.create({ form: {} });
    Object.assign(elicitationCapability, { url: {} });
    expect(
      elicitation.clientSupportsFormElicitation({
        clientCapabilities: { elicitation: elicitationCapability },
      }),
    ).toBe(false);
  });
});

describe("independent bounded prompt content", () => {
  it("omits malformed records and event lists without adding unrelated prompt text", () => {
    const message = elicitation.destructiveElicitationMessage(
      "test-tool",
      "review targets",
      {
        objects: [null, 42, "not-object", [], { key: "visible-object" }],
        rules: [
          null,
          42,
          "not-object",
          [],
          { id: "visible-rule", filter: { prefix: null, Prefix: "archive/" } },
        ],
        eventNotificationRules: [
          null,
          42,
          "not-object",
          { name: "bad-list", eventTypes: "not-a-list" },
          { name: "empty-list", eventTypes: [null, {}, [], " "] },
        ],
      },
      { env: {} },
    );
    expect(message).toBe(
      "test-tool would review targets. Object count: 5. Object 5 key: visible-object. Rule count: 5. Rule 5 ID: visible-rule. Rule 5 prefix: archive/. Notification rule count: 5. Notification rule 4 name: bad-list. Notification rule 5 name: empty-list. Deletion rule count: 0. Approve this destructive B2 operation?",
    );
  });

  it.each([
    { expiration: { days: 1 } },
    { Expiration: { Days: 1 } },
    { noncurrentVersionExpiration: { noncurrentDays: 1 } },
    { NoncurrentVersionExpiration: { NoncurrentDays: 1 } },
  ])("counts a rule with a single supported expiration field %#", (rule) => {
    expect(
      elicitation.destructiveElicitationMessage(
        "test-tool",
        "review targets",
        { rules: [rule] },
        { env: {} },
      ),
    ).toContain("Deletion rule count: 1.");
  });

  it("renders every scalar field with its independent public label", () => {
    expect(
      elicitation.destructiveElicitationMessage(
        "test-tool",
        "perform the operation",
        {
          bucketId: "bucket-id",
          bucket: "bucket",
          key: "object",
          versionId: "version",
          fileId: "file-id",
          fileName: "file-name",
          applicationKeyId: "application-id",
          keyName: "application-name",
          adminAccountId: "admin-id",
          groupId: "group-id",
          memberAccountId: "member-id",
          memberEmail: "member@example.com",
          email: "account@example.com",
          operation: "PutObject",
          expiresIn: 60,
          uploadId: "upload-id",
          bypassGovernance: true,
        },
        { env: {} },
      ),
    ).toBe(
      "test-tool would perform the operation. Bucket ID: bucket-id. Bucket: bucket. Object key: object. Version ID: version. File ID: file-id. File name: file-name. Application key ID: application-id. Application key name: application-name. Admin account ID: admin-id. Group ID: group-id. Member account ID: member-id. Member email: member@example.com. Account email: account@example.com. Operation: PutObject. Expiry seconds: 60. Upload ID: upload-id. Governance bypass requested. Approve this destructive B2 operation?",
    );
  });

  it("normalizes whitespace and truncates only values longer than 120 characters", () => {
    expect(
      elicitation.destructiveElicitationMessage(
        "test-tool",
        "perform the operation",
        { bucket: "  two\n\t words  ", key: "x".repeat(120), versionId: "y".repeat(121) },
        { env: {} },
      ),
    ).toBe(
      `test-tool would perform the operation. Bucket: two words. Object key: ${"x".repeat(120)}. Version ID: ${"y".repeat(117)}.... Approve this destructive B2 operation?`,
    );
  });

  it("redacts ordinary configured secret values in both effects and detail strings", () => {
    expect(
      elicitation.destructiveElicitationMessage(
        "test-tool",
        "expose ordinary-private-value",
        { key: "prefix-ordinary-private-value-suffix" },
        { env: {}, secrets: ["ordinary-private-value"] },
      ),
    ).toBe(
      "test-tool would expose [redacted]. Object key: [redacted]. Approve this destructive B2 operation?",
    );
  });

  it("renders five bulk object targets and only the number of omitted targets", () => {
    const objects = Array.from({ length: 6 }, (_, i) => ({
      Key: `object-${i + 1}`,
      VersionId: `version-${i + 1}`,
    }));
    expect(
      elicitation.destructiveElicitationMessage(
        "test-tool",
        "delete objects",
        { objects },
        { env: {} },
      ),
    ).toBe(
      "test-tool would delete objects. Object count: 6. Object 1 key: object-1. Object 1 version ID: version-1. Object 2 key: object-2. Object 2 version ID: version-2. Object 3 key: object-3. Object 3 version ID: version-3. Object 4 key: object-4. Object 4 version ID: version-4. Object 5 key: object-5. Object 5 version ID: version-5. Additional object targets: 1. Approve this destructive B2 operation?",
    );
    expect(
      elicitation.destructiveElicitationMessage(
        "test-tool",
        "delete objects",
        { objects: objects.slice(0, 5) },
        { env: {} },
      ),
    ).not.toContain("Additional object targets:");
  });

  it("renders both lifecycle field spellings including false marker values", () => {
    const lower = {
      id: "lower",
      status: "Enabled",
      filter: { prefix: "archive/" },
      expiration: { days: 7, expiredObjectDeleteMarker: false },
      noncurrentVersionExpiration: { noncurrentDays: 8 },
      abortIncompleteMultipartUpload: { daysAfterInitiation: 9 },
    };
    const upper = {
      ID: "upper",
      Status: "Disabled",
      Filter: { Prefix: "incoming/" },
      Expiration: { Days: 10, ExpiredObjectDeleteMarker: true },
      NoncurrentVersionExpiration: { NoncurrentDays: 11 },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 12 },
    };
    expect(
      elicitation.destructiveElicitationMessage(
        "test-tool",
        "replace lifecycle rules",
        { rules: [lower, upper] },
        { env: {} },
      ),
    ).toBe(
      "test-tool would replace lifecycle rules. Rule count: 2. Rule 1 ID: lower. Rule 1 status: Enabled. Rule 1 prefix: archive/. Rule 1 expiration days: 7. Rule 1 expired object delete marker: false. Rule 1 noncurrent expiration days: 8. Rule 1 abort incomplete upload days: 9. Rule 2 ID: upper. Rule 2 status: Disabled. Rule 2 prefix: incoming/. Rule 2 expiration days: 10. Rule 2 expired object delete marker: true. Rule 2 noncurrent expiration days: 11. Rule 2 abort incomplete upload days: 12. Deletion rule count: 2. Approve this destructive B2 operation?",
    );
  });

  it("counts each lifecycle deletion rule once across supported field aliases", () => {
    const message = elicitation.destructiveElicitationMessage(
      "test-tool",
      "replace lifecycle rules",
      {
        rules: [
          {
            expiration: { days: 1 },
            Expiration: { Days: 1 },
            noncurrentVersionExpiration: { noncurrentDays: 2 },
          },
          { NoncurrentVersionExpiration: { NoncurrentDays: 3 } },
          { abortIncompleteMultipartUpload: { daysAfterInitiation: 4 } },
        ],
      },
      { env: {} },
    );
    expect(message).toContain("Deletion rule count: 2.");
  });

  it("bounds lifecycle and notification rule lists without dropping counts", () => {
    const rules = Array.from({ length: 6 }, (_, i) => ({ id: `rule-${i + 1}` }));
    const eventNotificationRules = Array.from({ length: 6 }, (_, i) => ({
      name: `notification-${i + 1}`,
    }));
    const message = elicitation.destructiveElicitationMessage(
      "test-tool",
      "replace rules",
      { rules, eventNotificationRules },
      { env: {} },
    );
    expect(message).toContain("Rule count: 6.");
    expect(message).toContain("Notification rule count: 6.");
    expect(message).toContain("Additional lifecycle rules: 1.");
    expect(message).toContain("Additional notification rules: 1.");
    expect(message).not.toContain("rule-6");
    expect(message).not.toContain("notification-6");
  });

  it("renders bounded notification event lists with distinct delimiters", () => {
    expect(
      elicitation.destructiveElicitationMessage(
        "test-tool",
        "replace notifications",
        {
          eventNotificationRules: [
            {
              name: "incoming",
              objectNamePrefix: "upload/",
              isEnabled: false,
              eventTypes: ["one", "two", "three", "four", "five", "six"],
            },
          ],
        },
        { env: {} },
      ),
    ).toBe(
      "test-tool would replace notifications. Notification rule count: 1. Notification rule 1 name: incoming. Notification rule 1 object prefix: upload/. Notification rule 1 event types: one, two, three, four, five, +1 more. Notification rule 1 enabled: false. Approve this destructive B2 operation?",
    );
  });
});
