import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type ClientCapabilities,
} from "@modelcontextprotocol/server";
import { createAuditedToolCallback } from "../../src/server";
import {
  DESTRUCTIVE_ELICITATION_REQUEST_STATE,
  DESTRUCTIVE_ELICITATION_RESPONSE_KEY,
  clientCanUseReturnBasedElicitation,
  clientSupportsFormElicitation,
  createDestructiveElicitationRequestStateCodec,
  destructiveElicitationMessage,
} from "../../src/utils/destructive-elicitation";
import {
  checkDestructive,
  DESTRUCTIVE_TOOL_NAMES,
  destructiveEffect,
} from "../../src/utils/destructive-gate";
import { toolError } from "../../src/utils/errors";
import { logger } from "../../src/utils/logger";
import type { B2Config, DestructivePolicy } from "../../src/utils/types";

const CONFIGURED_SECRET = "configured-elicitation-secret-value";
const CANARY = "B2_MCP_CANARY_SECRET_elicitation_do_not_leak";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";

const cfg = (destructivePolicy: DestructivePolicy = "confirm"): B2Config =>
  ({
    applicationKeyId: "test-key-id",
    applicationKey: CONFIGURED_SECRET,
    appKeyId: "test-key-id",
    appKey: CONFIGURED_SECRET,
    masterKeyId: "test-master-key-id",
    masterKey: "test-master-key-secret",
    region: "us-west-004",
    allowLocalFiles: true,
    fileRoot: null,
    destructivePolicy,
  }) as B2Config;

const FORM_ELICITATION: ClientCapabilities = { elicitation: { form: {} } };
const EMPTY_ELICITATION: ClientCapabilities = { elicitation: {} };
const URL_ONLY_ELICITATION: ClientCapabilities = { elicitation: { url: {} } };
const DESTRUCTIVE_ARGS: Record<string, Record<string, unknown>> = {
  b2_create_group_member: { memberEmail: "member@example.com" },
  b2_create_key: { keyName: "ci-uploader", capabilities: ["listBuckets"] },
  b2_delete_bucket: { bucketId: "bucket-id" },
  b2_delete_key: { applicationKeyId: "key-id" },
  b2_eject_group_member: {
    adminAccountId: "admin-account-id",
    groupId: "group-id",
    memberAccountId: "member-account-id",
  },
  b2_reserve_trial_create_account: { email: "trial@example.com" },
  b2_set_bucket_notification_rules: {
    bucketId: "bucket-id",
    eventNotificationRules: [
      {
        name: "rule",
        objectNamePrefix: "incoming/",
        eventTypes: ["b2:ObjectDeleted:*"],
        targetConfiguration: { targetType: "webhook", url: "https://hooks.example.com/b2" },
        isEnabled: true,
      },
    ],
  },
  b2_update_bucket: { bucketId: "bucket-id", bucketType: "allPublic" },
  b2_update_file_legal_hold: { fileId: "file-id", fileName: "old.txt", legalHold: "off" },
  b2_update_file_retention: {
    fileId: "file-id",
    fileName: "old.txt",
    fileRetention: { mode: null, retainUntilTimestamp: null },
  },
  s3_abort_multipart_upload: { bucket: "bucket", key: "old.txt", uploadId: "upload-id" },
  s3_delete_object: { bucket: "bucket", key: "old.txt" },
  s3_delete_objects: { bucket: "bucket", objects: [{ key: "old.txt", versionId: "version-1" }] },
  s3_get_presigned_url: { bucket: "bucket", key: "old.txt", operation: "PutObject" },
  s3_put_bucket_lifecycle: {
    bucket: "bucket",
    rules: [
      {
        id: "delete",
        status: "Enabled",
        filter: { prefix: "archive/" },
        expiration: { days: 1 },
        noncurrentVersionExpiration: { noncurrentDays: 7 },
      },
    ],
  },
};
const EXPECTED_PROMPT_SNIPPETS: Record<string, string[]> = {
  b2_create_group_member: ["Member email: member@example.com."],
  b2_create_key: ["Application key name: ci-uploader."],
  b2_delete_bucket: ["Bucket ID: bucket-id."],
  b2_delete_key: ["Application key ID: key-id."],
  b2_eject_group_member: [
    "Admin account ID: admin-account-id.",
    "Group ID: group-id.",
    "Member account ID: member-account-id.",
  ],
  b2_reserve_trial_create_account: ["Account email: trial@example.com."],
  b2_set_bucket_notification_rules: [
    "Bucket ID: bucket-id.",
    "Notification rule count: 1.",
    "Notification rule 1 name: rule.",
    "Notification rule 1 object prefix: incoming/.",
    "Notification rule 1 event types: b2:ObjectDeleted:*.",
    "Notification rule 1 enabled: true.",
  ],
  b2_update_bucket: ["Bucket ID: bucket-id.", "make the bucket PUBLIC"],
  b2_update_file_legal_hold: ["File ID: file-id.", "File name: old.txt."],
  b2_update_file_retention: ["File ID: file-id.", "File name: old.txt."],
  s3_abort_multipart_upload: ["Bucket: bucket.", "Object key: old.txt.", "Upload ID: upload-id."],
  s3_delete_object: ["Bucket: bucket.", "Object key: old.txt."],
  s3_delete_objects: [
    "Bucket: bucket.",
    "Object count: 1.",
    "Object 1 key: old.txt.",
    "Object 1 version ID: version-1.",
  ],
  s3_get_presigned_url: ["Bucket: bucket.", "Object key: old.txt.", "Operation: PutObject."],
  s3_put_bucket_lifecycle: [
    "Bucket: bucket.",
    "Rule count: 1.",
    "Rule 1 ID: delete.",
    "Rule 1 prefix: archive/.",
    "Rule 1 expiration days: 1.",
    "Rule 1 noncurrent expiration days: 7.",
    "Deletion rule count: 1.",
  ],
};

function providers(
  clientCapabilities: ClientCapabilities | undefined = FORM_ELICITATION,
  protocolVersion: string | undefined = MODERN_PROTOCOL_VERSION,
) {
  return {
    getClientCapabilities: (): ClientCapabilities | undefined => clientCapabilities,
    getProtocolVersion: (): string | undefined => protocolVersion,
  };
}

function envelope(
  protocolVersion: string = MODERN_PROTOCOL_VERSION,
  clientCapabilities?: ClientCapabilities,
): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: protocolVersion,
    ...(clientCapabilities && { [CLIENT_CAPABILITIES_META_KEY]: clientCapabilities }),
  };
}

function extraWithElicitation(inputResponses?: Record<string, unknown>, requestState?: string) {
  return {
    mcpReq: {
      clientCapabilities: FORM_ELICITATION,
      envelope: envelope(),
      inputResponses,
      ...(requestState ? { requestState: () => requestState } : {}),
    },
  };
}

function acceptedResponse() {
  return {
    [DESTRUCTIVE_ELICITATION_RESPONSE_KEY]: {
      action: "accept",
      content: { confirm: true },
    },
  };
}

function destructiveOriginal(config: B2Config, toolName = "s3_delete_object") {
  return vi.fn((args: Record<string, unknown>) => {
    const gate = checkDestructive(toolName, args, config);
    if (!gate.ok) return toolError(gate.error);
    return { content: [{ type: "text" as const, text: "deleted" }] };
  });
}

async function requestStateFor(
  wrapped: ReturnType<typeof createAuditedToolCallback>,
  args: Record<string, unknown>,
): Promise<string> {
  const initial = await wrapped(args, {});
  expect(initial.resultType).toBe("input_required");
  expect(initial.requestState).toEqual(
    expect.stringContaining(DESTRUCTIVE_ELICITATION_REQUEST_STATE),
  );
  return initial.requestState as string;
}

describe("destructive elicitation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.B2_DESTRUCTIVE_ELICITATION;
  });

  it("prompts every destructive tool when the active call is destructive", async () => {
    expect(Object.keys(DESTRUCTIVE_ARGS).sort()).toEqual(DESTRUCTIVE_TOOL_NAMES);

    for (const toolName of DESTRUCTIVE_TOOL_NAMES) {
      const original = vi.fn(() => ({ content: [{ type: "text" as const, text: "called" }] }));
      const wrapped = createAuditedToolCallback(toolName, original, cfg(), providers());

      const result = await wrapped(DESTRUCTIVE_ARGS[toolName], {});

      expect(result.resultType, toolName).toBe("input_required");
      expect(result.inputRequests?.[DESTRUCTIVE_ELICITATION_RESPONSE_KEY], toolName).toMatchObject({
        method: "elicitation/create",
      });
      expect(original, toolName).not.toHaveBeenCalled();
    }
  });

  it("returns input_required for capable clients, then accepts human approval", async () => {
    const config = cfg();
    const original = destructiveOriginal(config);
    const wrapped = createAuditedToolCallback("s3_delete_object", original, config, providers());

    const initial = await wrapped({ bucket: "photos", key: "old.jpg" }, {});
    expect(initial.resultType).toBe("input_required");
    expect(initial.requestState).toEqual(
      expect.stringContaining(DESTRUCTIVE_ELICITATION_REQUEST_STATE),
    );
    expect(initial.inputRequests?.[DESTRUCTIVE_ELICITATION_RESPONSE_KEY]).toMatchObject({
      method: "elicitation/create",
      params: {
        message: expect.stringContaining("s3_delete_object would permanently delete an object"),
        requestedSchema: {
          type: "object",
          required: ["confirm"],
        },
      },
    });
    expect(original).not.toHaveBeenCalled();

    const accepted = await wrapped(
      { bucket: "photos", key: "old.jpg" },
      extraWithElicitation(acceptedResponse(), initial.requestState as string),
    );

    expect(accepted.content?.[0]?.text).toBe("deleted");
    expect(original).toHaveBeenCalledTimes(1);
  });

  it("rejects tampered server-minted requestState through the SDK codec", async () => {
    const codec = createDestructiveElicitationRequestStateCodec(cfg());
    const payload = {
      v: 1 as const,
      kind: "destructive-elicitation" as const,
      toolName: "s3_delete_object",
      effect: "permanently delete an object",
      argsDigest: "digest",
      issuedAt: Date.now(),
    };
    const requestState = await codec.mint(payload, {} as never);

    expect(requestState).toContain(DESTRUCTIVE_ELICITATION_REQUEST_STATE);
    await expect(codec.verify(requestState, {} as never)).resolves.toEqual(payload);
    await expect(codec.verify(`${requestState}tampered`, {} as never)).rejects.toThrow();
  });

  it("refuses accepted approval when the destructive target changes", async () => {
    const config = cfg();
    const original = destructiveOriginal(config);
    const wrapped = createAuditedToolCallback("s3_delete_object", original, config, providers());
    const requestState = await requestStateFor(wrapped, {
      bucket: "sandbox",
      key: "ok-to-delete.txt",
    });

    const result = await wrapped(
      { bucket: "prod", key: "customer-backups.tar", confirm: true },
      extraWithElicitation(acceptedResponse(), requestState),
    );

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/target did not match/i);
    expect(original).not.toHaveBeenCalled();
  });

  it("refuses forged first-shot approval without server-minted state", async () => {
    const config = cfg();
    const original = destructiveOriginal(config);
    const wrapped = createAuditedToolCallback("s3_delete_object", original, config, providers());

    const result = await wrapped(
      { bucket: "photos", key: "old.jpg", confirm: true },
      extraWithElicitation(acceptedResponse()),
    );

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/requestState is missing/i);
    expect(original).not.toHaveBeenCalled();
  });

  it("refuses target swaps for arg-derived destructive effects", async () => {
    const config = cfg();
    const original = destructiveOriginal(config, "b2_update_bucket");
    const wrapped = createAuditedToolCallback("b2_update_bucket", original, config, providers());
    const requestState = await requestStateFor(wrapped, {
      bucketId: "approved-bucket-id",
      bucketType: "allPublic",
    });

    const result = await wrapped(
      { bucketId: "different-bucket-id", bucketType: "allPublic", confirm: true },
      extraWithElicitation(acceptedResponse(), requestState),
    );

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/target did not match/i);
    expect(original).not.toHaveBeenCalled();
  });

  it.each(["decline", "cancel"] as const)(
    "refuses %s before the destructive handler runs",
    async (action) => {
      const config = cfg();
      const original = destructiveOriginal(config);
      const wrapped = createAuditedToolCallback("s3_delete_object", original, config, providers());
      const args = { bucket: "photos", key: "old.jpg" };
      const requestState = await requestStateFor(wrapped, args);

      const result = await wrapped(
        args,
        extraWithElicitation(
          {
            [DESTRUCTIVE_ELICITATION_RESPONSE_KEY]: { action },
          },
          requestState,
        ),
      );

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/requires explicit human approval/i);
      expect(result.content?.[0]?.text).toContain(
        "B2 Error [destructive_confirmation_refused] (HTTP 409)",
      );
      expect(original).not.toHaveBeenCalled();
    },
  );

  it("treats a missing retry response as refusal before the handler runs", async () => {
    const config = cfg();
    const original = destructiveOriginal(config);
    const wrapped = createAuditedToolCallback("s3_delete_object", original, config, providers());
    const args = { bucket: "photos", key: "old.jpg" };
    const requestState = await requestStateFor(wrapped, args);

    const result = await wrapped(args, extraWithElicitation({}, requestState));

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/was not provided/i);
    expect(result.content?.[0]?.text).toContain(
      "B2 Error [destructive_confirmation_refused] (HTTP 409)",
    );
    expect(original).not.toHaveBeenCalled();
  });

  it("treats accepted responses without positive confirmation as user refusal", async () => {
    const config = cfg();
    const original = destructiveOriginal(config);
    const wrapped = createAuditedToolCallback("s3_delete_object", original, config, providers());
    const args = { bucket: "photos", key: "old.jpg" };
    const requestState = await requestStateFor(wrapped, args);

    const result = await wrapped(
      args,
      extraWithElicitation(
        {
          [DESTRUCTIVE_ELICITATION_RESPONSE_KEY]: {
            action: "accept",
            content: { confirm: false },
          },
        },
        requestState,
      ),
    );

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/did not approve/i);
    expect(result.content?.[0]?.text).toContain(
      "B2 Error [destructive_confirmation_refused] (HTTP 409)",
    );
    expect(original).not.toHaveBeenCalled();
  });

  it.each([
    ["allow" as const, false, "deleted"],
    ["confirm" as const, true, "input_required"],
    ["block" as const, false, "blocked"],
  ])(
    "gates form-capable clients through %s policy before elicitation",
    async (policy, elicits, expectedText) => {
      const config = cfg(policy);
      const original = destructiveOriginal(config);
      const wrapped = createAuditedToolCallback("s3_delete_object", original, config, providers());

      const result = await wrapped({ bucket: "photos", key: "old.jpg" }, {});

      if (elicits) {
        expect(result.resultType).toBe(expectedText);
        expect(original).not.toHaveBeenCalled();
      } else {
        expect(result.resultType).not.toBe("input_required");
        expect(result.content?.[0]?.text).toMatch(new RegExp(expectedText, "i"));
        if (policy === "block") {
          expect(result.content?.[0]?.text).toContain(
            "B2 Error [destructive_policy_blocked] (HTTP 403)",
          );
        }
        expect(original).toHaveBeenCalledTimes(1);
      }
    },
  );

  describe("elicit policy", () => {
    // `elicit` requires real human approval and refuses when it can't reach a
    // human — the divergence from `confirm` is entirely in the can't-elicit path.
    it("elicits a form-capable client, then runs on human approval", async () => {
      const config = cfg("elicit");
      const original = destructiveOriginal(config);
      const wrapped = createAuditedToolCallback("s3_delete_object", original, config, providers());

      const initial = await wrapped({ bucket: "photos", key: "old.jpg" }, {});
      expect(initial.resultType).toBe("input_required");
      expect(original).not.toHaveBeenCalled();

      const accepted = await wrapped(
        { bucket: "photos", key: "old.jpg" },
        extraWithElicitation(acceptedResponse(), initial.requestState as string),
      );
      expect(accepted.content?.[0]?.text).toBe("deleted");
      expect(original).toHaveBeenCalledTimes(1);
    });

    it("refuses a client that cannot present a form, even with confirm:true", async () => {
      // Under `confirm` this same incapable client would fall through to the gate
      // and be satisfied by confirm:true; under `elicit` it is refused outright.
      const config = cfg("elicit");
      const original = destructiveOriginal(config);
      const wrapped = createAuditedToolCallback(
        "s3_delete_object",
        original,
        config,
        providers(URL_ONLY_ELICITATION),
      );

      const result = await wrapped(
        { bucket: "photos", key: "old.jpg", confirm: true },
        { mcpReq: { clientCapabilities: URL_ONLY_ELICITATION, envelope: envelope() } },
      );

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain(
        "B2 Error [destructive_confirmation_refused] (HTTP 409)",
      );
      expect(result.content?.[0]?.text).toMatch(/cannot present an MCP elicitation prompt/i);
      expect(original).not.toHaveBeenCalled();
    });

    it("refuses when elicitation is disabled server-side", async () => {
      process.env.B2_DESTRUCTIVE_ELICITATION = "off";
      const config = cfg("elicit");
      const original = destructiveOriginal(config);
      const wrapped = createAuditedToolCallback("s3_delete_object", original, config, providers());

      const result = await wrapped({ bucket: "photos", key: "old.jpg", confirm: true }, {});

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain(
        "B2 Error [destructive_confirmation_refused] (HTTP 409)",
      );
      expect(result.content?.[0]?.text).toMatch(/elicitation is disabled/i);
      expect(original).not.toHaveBeenCalled();
    });
  });

  it("requires elicitation for capable clients even when confirm is already true", async () => {
    const config = cfg("confirm");
    const original = destructiveOriginal(config);
    const wrapped = createAuditedToolCallback("s3_delete_object", original, config, providers());

    const result = await wrapped({ bucket: "photos", key: "old.jpg", confirm: true }, {});

    expect(result.resultType).toBe("input_required");
    expect(original).not.toHaveBeenCalled();
  });

  it("can disable elicitation while preserving the confirm gate", async () => {
    process.env.B2_DESTRUCTIVE_ELICITATION = "off";
    const config = cfg("confirm");
    const original = destructiveOriginal(config);
    const wrapped = createAuditedToolCallback("s3_delete_object", original, config, providers());

    const result = await wrapped({ bucket: "photos", key: "old.jpg" }, {});

    expect(result.resultType).not.toBe("input_required");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/expects a human operator/i);
    expect(result.content?.[0]?.text).toContain(
      "B2 Error [destructive_confirmation_required] (HTTP 409)",
    );
    expect(original).toHaveBeenCalledTimes(1);

    const confirmed = await wrapped({ bucket: "photos", key: "old.jpg", confirm: true }, {});
    expect(confirmed.content?.[0]?.text).toBe("deleted");
    expect(original).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["server-disabled elicitation", "elicitation_disabled" as const, providers(), {}],
    [
      "unsupported client elicitation",
      "client_cannot_elicit" as const,
      providers(URL_ONLY_ELICITATION),
      { mcpReq: { clientCapabilities: URL_ONLY_ELICITATION, envelope: envelope() } },
    ],
  ])(
    "audits model-supplied confirm attribution for %s",
    async (_case, expectedReason, context, extra) => {
      const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
      if (expectedReason === "elicitation_disabled") {
        process.env.B2_DESTRUCTIVE_ELICITATION = "off";
      }
      const config = cfg("confirm");
      const original = destructiveOriginal(config);
      const wrapped = createAuditedToolCallback("s3_delete_object", original, config, context);

      const result = await wrapped({ bucket: "photos", key: "old.jpg", confirm: true }, extra);

      expect(result.content?.[0]?.text).toBe("deleted");
      expect(original).toHaveBeenCalledTimes(1);
      expect(info.mock.calls.find(([, message]) => message === "tool.call")?.[0]).toMatchObject({
        elicitationOutcome: "accepted",
        handlerRan: true,
        destructiveConfirmationSource: "model_confirm_parameter",
        destructiveConfirmationFallbackReason: expectedReason,
      });
    },
  );

  it.each([
    [
      "missing legacy confirmation",
      cfg("confirm"),
      providers(URL_ONLY_ELICITATION),
      { bucket: "photos", key: "old.jpg" },
      "destructive_confirmation_required",
      409,
    ],
    [
      "block policy",
      cfg("block"),
      providers(),
      { bucket: "photos", key: "old.jpg", confirm: true },
      "destructive_policy_blocked",
      403,
    ],
  ])(
    "audits %s refusal as a non-500 policy outcome",
    async (_case, config, context, args, expectedCode, expectedStatus) => {
      const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
      const original = destructiveOriginal(config);
      const wrapped = createAuditedToolCallback("s3_delete_object", original, config, context);

      const result = await wrapped(args, {});

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain(
        `B2 Error [${expectedCode}] (HTTP ${expectedStatus})`,
      );
      expect(info.mock.calls.find(([, message]) => message === "tool.call")?.[0]).toMatchObject({
        code: expectedCode,
        status: expectedStatus,
      });
    },
  );

  it.each([
    ["missing form capability", { mcpReq: { envelope: envelope() } }],
    [
      "url-only request capability",
      { mcpReq: { clientCapabilities: URL_ONLY_ELICITATION, envelope: envelope() } },
    ],
    [
      "legacy protocol marker",
      {
        mcpReq: {
          clientCapabilities: FORM_ELICITATION,
          envelope: envelope(LEGACY_PROTOCOL_VERSION),
        },
      },
    ],
  ])("uses trusted context for %s downgrade attempts", async (_case, extra) => {
    const config = cfg();
    const original = destructiveOriginal(config);
    const wrapped = createAuditedToolCallback("s3_delete_object", original, config, providers());

    const result = await wrapped({ bucket: "photos", key: "old.jpg", confirm: true }, extra);

    expect(result.resultType).toBe("input_required");
    expect(original).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing form elicitation capability",
      {
        getClientCapabilities: (): undefined => undefined,
        getProtocolVersion: (): string => MODERN_PROTOCOL_VERSION,
      },
      { mcpReq: { envelope: envelope() } },
    ],
    [
      "url-only elicitation capability",
      providers(URL_ONLY_ELICITATION),
      { mcpReq: { clientCapabilities: URL_ONLY_ELICITATION, envelope: envelope() } },
    ],
    [
      "legacy protocol requests",
      providers(FORM_ELICITATION, LEGACY_PROTOCOL_VERSION),
      {
        mcpReq: {
          clientCapabilities: FORM_ELICITATION,
          envelope: envelope(LEGACY_PROTOCOL_VERSION),
        },
      },
    ],
  ])("falls back to the confirm gate for %s", async (_case, context, extra) => {
    const config = cfg();
    const original = destructiveOriginal(config);
    const wrapped = createAuditedToolCallback("s3_delete_object", original, config, context);

    const missingConfirm = await wrapped({ bucket: "photos", key: "old.jpg" }, extra);
    expect(missingConfirm.resultType).not.toBe("input_required");
    expect(missingConfirm.content?.[0]?.text).toMatch(/expects a human operator/i);
    expect(missingConfirm.content?.[0]?.text).toContain(
      "B2 Error [destructive_confirmation_required] (HTTP 409)",
    );
    expect(original).toHaveBeenCalledTimes(1);

    const confirmed = await wrapped({ bucket: "photos", key: "old.jpg", confirm: true }, extra);
    expect(confirmed.content?.[0]?.text).toBe("deleted");
    expect(original).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "mcpReq clientCapabilities",
      { mcpReq: { clientCapabilities: FORM_ELICITATION, envelope: envelope() } },
      undefined,
    ],
    [
      "mcpReq envelope capabilities",
      { mcpReq: { envelope: envelope(MODERN_PROTOCOL_VERSION, FORM_ELICITATION) } },
      undefined,
    ],
    [
      "top-level capabilities",
      { clientCapabilities: FORM_ELICITATION, mcpReq: { envelope: envelope() } },
      undefined,
    ],
    ["provider capabilities", { mcpReq: { envelope: envelope() } }, FORM_ELICITATION],
  ])("detects return-based elicitation from %s", async (_shape, extra, capabilityProvider) => {
    const config = cfg();
    const original = destructiveOriginal(config);
    const wrapped = createAuditedToolCallback(
      "s3_delete_object",
      original,
      config,
      providers(capabilityProvider),
    );

    const result = await wrapped({ bucket: "photos", key: "old.jpg" }, extra);

    expect(result.resultType).toBe("input_required");
    expect(original).not.toHaveBeenCalled();
  });

  it("documents empty elicitation as form-capable and rejects url-only elicitation", () => {
    expect(clientSupportsFormElicitation({ clientCapabilities: EMPTY_ELICITATION })).toBe(true);
    expect(clientSupportsFormElicitation({ clientCapabilities: URL_ONLY_ELICITATION })).toBe(false);
    expect(
      clientCanUseReturnBasedElicitation(
        { clientCapabilities: EMPTY_ELICITATION, mcpReq: { envelope: envelope() } },
        providers(undefined),
      ),
    ).toBe(true);
  });

  it("includes real Group member eject targets in the prompt", () => {
    const message = destructiveElicitationMessage(
      "b2_eject_group_member",
      "eject a Group member",
      DESTRUCTIVE_ARGS.b2_eject_group_member,
    );

    expect(message).toContain("Admin account ID: admin-account-id.");
    expect(message).toContain("Group ID: group-id.");
    expect(message).toContain("Member account ID: member-account-id.");
  });

  it("keeps destructive prompt target details pinned for every tool", () => {
    expect(Object.keys(EXPECTED_PROMPT_SNIPPETS).sort()).toEqual(DESTRUCTIVE_TOOL_NAMES);

    for (const toolName of DESTRUCTIVE_TOOL_NAMES) {
      const args = DESTRUCTIVE_ARGS[toolName];
      const effect = destructiveEffect(toolName, args);
      expect(effect, toolName).toBeTruthy();

      const message = destructiveElicitationMessage(toolName, effect!, args);
      for (const snippet of EXPECTED_PROMPT_SNIPPETS[toolName]) {
        expect(message, `${toolName} missing ${snippet}`).toContain(snippet);
      }
    }
  });

  it("shows bounded bulk object identities without leaking secrets", () => {
    const message = destructiveElicitationMessage(
      "s3_delete_objects",
      "permanently delete multiple objects",
      {
        bucket: "photos",
        objects: [
          { Key: "customer-backups.tar", VersionId: "version-1" },
          { Key: `token-${CONFIGURED_SECRET}`, VersionId: "version-2" },
          { Key: "file-3.txt" },
          { Key: "file-4.txt" },
          { Key: "file-5.txt" },
          { Key: "file-6.txt" },
        ],
      },
      { secrets: [CONFIGURED_SECRET] },
    );

    expect(message).toContain("Object count: 6.");
    expect(message).toContain("Object 1 key: customer-backups.tar.");
    expect(message).toContain("Object 1 version ID: version-1.");
    expect(message).toContain("Object 2 key: [redacted].");
    expect(message).toContain("Object 2 version ID: version-2.");
    expect(message).toContain("Additional object targets: 1.");
    expect(message).not.toContain(CONFIGURED_SECRET);
  });

  it("sanitizes secret-shaped values from elicitation prompts", () => {
    const message = destructiveElicitationMessage(
      "s3_delete_object",
      "permanently delete an object",
      {
        bucket: `bucket-${CANARY}`,
        key: `applicationKey=${CONFIGURED_SECRET}`,
      },
      { secrets: [CONFIGURED_SECRET] },
    );

    expect(message).not.toContain(CANARY);
    expect(message).not.toContain(CONFIGURED_SECRET);
    expect(message).toContain("[redacted]");
  });

  it("logs requested, accepted, and declined elicitation decisions without args", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const config = cfg();
    const original = destructiveOriginal(config);
    const wrapped = createAuditedToolCallback("s3_delete_object", original, config, providers());
    const args = { bucket: "photos", key: "old.jpg" };
    const requestState = await requestStateFor(wrapped, args);

    await wrapped(args, extraWithElicitation(acceptedResponse(), requestState));
    const secondState = await requestStateFor(wrapped, { bucket: "photos", key: "old-2.jpg" });
    await wrapped(
      { bucket: "photos", key: "old-2.jpg" },
      extraWithElicitation(
        {
          [DESTRUCTIVE_ELICITATION_RESPONSE_KEY]: { action: "decline" },
        },
        secondState,
      ),
    );

    const elicitationLogs = info.mock.calls.filter(
      ([, message]) => message === "destructive.elicitation",
    );
    expect(elicitationLogs.map(([entry]) => (entry as { decision: string }).decision)).toEqual([
      "requested",
      "accepted",
      "requested",
      "declined",
    ]);
    expect(elicitationLogs.map(([entry]) => (entry as { outcome: string }).outcome)).toEqual([
      "requested",
      "accepted",
      "requested",
      "declined",
    ]);
    expect(elicitationLogs.map(([entry]) => (entry as { tool: string }).tool)).toEqual([
      "s3_delete_object",
      "s3_delete_object",
      "s3_delete_object",
      "s3_delete_object",
    ]);

    const toolCallLogs = info.mock.calls.filter(([, message]) => message === "tool.call");
    expect(
      toolCallLogs.map(([entry]) => ({
        resultType: (entry as { resultType: string }).resultType,
        outcome: (entry as { elicitationOutcome?: string }).elicitationOutcome,
        handlerRan: (entry as { handlerRan?: boolean }).handlerRan,
        source: (entry as { destructiveConfirmationSource?: string }).destructiveConfirmationSource,
      })),
    ).toEqual([
      { resultType: "input_required", outcome: "requested", handlerRan: false, source: undefined },
      {
        resultType: "complete",
        outcome: "accepted",
        handlerRan: true,
        source: "human_mcp_elicitation",
      },
      { resultType: "input_required", outcome: "requested", handlerRan: false, source: undefined },
      { resultType: "complete", outcome: "declined", handlerRan: false, source: undefined },
    ]);
    expect(toolCallLogs[toolCallLogs.length - 1]?.[0]).toMatchObject({
      code: "destructive_confirmation_refused",
      status: 409,
    });
    const serializedLogs = JSON.stringify(elicitationLogs);
    expect(serializedLogs).not.toContain("photos");
    expect(serializedLogs).not.toContain("old.jpg");
    expect(serializedLogs).not.toContain("old-2.jpg");
  });
});
