import type { ClientCapabilities } from "@modelcontextprotocol/server";
import { createAuditedToolCallback } from "../../src/server";
import {
  DESTRUCTIVE_ELICITATION_REQUEST_STATE,
  DESTRUCTIVE_ELICITATION_RESPONSE_KEY,
  destructiveElicitationMessage,
} from "../../src/utils/destructive-elicitation";
import { checkDestructive, DESTRUCTIVE_TOOL_NAMES } from "../../src/utils/destructive-gate";
import { toolError } from "../../src/utils/errors";
import type { B2Config, DestructivePolicy } from "../../src/utils/types";

const CONFIGURED_SECRET = "configured-elicitation-secret-value";
const CANARY = "B2_MCP_CANARY_SECRET_elicitation_do_not_leak";

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
const DESTRUCTIVE_ARGS: Record<string, Record<string, unknown>> = {
  b2_create_group_member: { memberEmail: "member@example.com" },
  b2_delete_bucket: { bucketId: "bucket-id" },
  b2_delete_key: { applicationKeyId: "key-id" },
  b2_eject_group_member: { memberId: "member-id" },
  b2_reserve_trial_create_account: { email: "trial@example.com" },
  b2_set_bucket_notification_rules: {
    bucketId: "bucket-id",
    eventNotificationRules: [{ name: "rule" }],
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
  s3_delete_objects: { bucket: "bucket", objects: [{ Key: "old.txt" }] },
  s3_get_presigned_url: { bucket: "bucket", key: "old.txt", operation: "PutObject" },
  s3_put_bucket_lifecycle: {
    bucket: "bucket",
    rules: [{ id: "delete", status: "Enabled", expiration: { days: 1 } }],
  },
};

function extraWithElicitation(inputResponses?: Record<string, unknown>, requestState?: string) {
  return {
    mcpReq: {
      clientCapabilities: FORM_ELICITATION,
      inputResponses,
      ...(requestState ? { requestState: () => requestState } : {}),
    },
  };
}

function destructiveOriginal(config: B2Config) {
  return vi.fn((args: Record<string, unknown>) => {
    const gate = checkDestructive("s3_delete_object", args, config);
    if (!gate.ok) return toolError(new Error(gate.message));
    return { content: [{ type: "text" as const, text: "deleted" }] };
  });
}

describe("destructive elicitation", () => {
  it("prompts every destructive tool when the active call is destructive", async () => {
    expect(Object.keys(DESTRUCTIVE_ARGS).sort()).toEqual(DESTRUCTIVE_TOOL_NAMES);

    for (const toolName of DESTRUCTIVE_TOOL_NAMES) {
      const original = vi.fn(() => ({ content: [{ type: "text" as const, text: "called" }] }));
      const wrapped = createAuditedToolCallback(toolName, original, cfg(), () => FORM_ELICITATION);

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
    const wrapped = createAuditedToolCallback(
      "s3_delete_object",
      original,
      config,
      () => FORM_ELICITATION,
    );

    const initial = await wrapped({ bucket: "photos", key: "old.jpg" }, {});
    expect(initial.resultType).toBe("input_required");
    expect(initial.requestState).toBe(DESTRUCTIVE_ELICITATION_REQUEST_STATE);
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
      extraWithElicitation({
        [DESTRUCTIVE_ELICITATION_RESPONSE_KEY]: {
          action: "accept",
          content: { confirm: true },
        },
      }),
    );

    expect(accepted.content?.[0]?.text).toBe("deleted");
    expect(original).toHaveBeenCalledTimes(1);
  });

  it.each(["decline", "cancel"] as const)(
    "refuses %s before the destructive handler runs",
    async (action) => {
      const config = cfg();
      const original = destructiveOriginal(config);
      const wrapped = createAuditedToolCallback(
        "s3_delete_object",
        original,
        config,
        () => FORM_ELICITATION,
      );

      const result = await wrapped(
        { bucket: "photos", key: "old.jpg" },
        extraWithElicitation({
          [DESTRUCTIVE_ELICITATION_RESPONSE_KEY]: { action },
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/requires explicit human approval/i);
      expect(original).not.toHaveBeenCalled();
    },
  );

  it("treats a missing retry response as refusal before the handler runs", async () => {
    const config = cfg();
    const original = destructiveOriginal(config);
    const wrapped = createAuditedToolCallback(
      "s3_delete_object",
      original,
      config,
      () => FORM_ELICITATION,
    );

    const result = await wrapped(
      { bucket: "photos", key: "old.jpg" },
      extraWithElicitation({}, DESTRUCTIVE_ELICITATION_REQUEST_STATE),
    );

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/was not provided/i);
    expect(original).not.toHaveBeenCalled();
  });

  it("falls back to the destructive gate when the client has no elicitation", async () => {
    const config = cfg();
    const original = destructiveOriginal(config);
    const wrapped = createAuditedToolCallback("s3_delete_object", original, config, () => ({}));

    const missingConfirm = await wrapped({ bucket: "photos", key: "old.jpg" }, {});
    expect(missingConfirm.isError).toBe(true);
    expect(missingConfirm.content?.[0]?.text).toMatch(/Confirmation required/i);
    expect(original).toHaveBeenCalledTimes(1);

    const confirmed = await wrapped({ bucket: "photos", key: "old.jpg", confirm: true }, {});
    expect(confirmed.content?.[0]?.text).toBe("deleted");
    expect(original).toHaveBeenCalledTimes(2);
  });

  it("keeps block policy authoritative for clients without elicitation", async () => {
    const config = cfg("block");
    const original = destructiveOriginal(config);
    const wrapped = createAuditedToolCallback("s3_delete_object", original, config, () => ({}));

    const result = await wrapped({ bucket: "photos", key: "old.jpg", confirm: true }, {});

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/blocked/i);
    expect(original).toHaveBeenCalledTimes(1);
  });

  it("keeps block policy authoritative after capable-client approval", async () => {
    const config = cfg("block");
    const original = destructiveOriginal(config);
    const wrapped = createAuditedToolCallback(
      "s3_delete_object",
      original,
      config,
      () => FORM_ELICITATION,
    );

    const result = await wrapped(
      { bucket: "photos", key: "old.jpg" },
      extraWithElicitation({
        [DESTRUCTIVE_ELICITATION_RESPONSE_KEY]: {
          action: "accept",
          content: { confirm: true },
        },
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/blocked/i);
    expect(original).toHaveBeenCalledTimes(1);
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
});
