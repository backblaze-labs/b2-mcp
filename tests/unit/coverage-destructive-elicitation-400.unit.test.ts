import { PROTOCOL_VERSION_META_KEY, type ClientCapabilities } from "@modelcontextprotocol/server";
import {
  DESTRUCTIVE_ELICITATION_RESPONSE_KEY,
  clientCanUseReturnBasedElicitation,
  clientSupportsFormElicitation,
  createDestructiveElicitationRequestStateCodec,
  destructiveElicitationMessage,
  maybeRequireDestructiveElicitation,
} from "../../src/utils/destructive-elicitation";
import type { B2Config, DestructivePolicy } from "../../src/utils/types";

const CONFIGURED_SECRET = "configured-elicitation-secret-value";
const MODERN_PROTOCOL_VERSION = "2026-07-28";

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

function capableExtra(inputResponses?: Record<string, unknown>, requestState?: unknown) {
  return {
    mcpReq: {
      clientCapabilities: FORM_ELICITATION,
      envelope: { [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION },
      ...(inputResponses ? { inputResponses } : {}),
      ...(requestState !== undefined ? { requestState } : {}),
    },
  };
}

const providers = {
  getClientCapabilities: (): ClientCapabilities => FORM_ELICITATION,
  getProtocolVersion: (): string => MODERN_PROTOCOL_VERSION,
};

interface RunResult {
  isError?: boolean;
  resultType?: string;
  requestState?: string;
  content?: Array<{ text?: string }>;
}

async function runElicitation(options: {
  toolName?: string;
  args: Record<string, unknown>;
  extra: unknown;
  config?: B2Config;
  runOriginal?: () => unknown;
}): Promise<RunResult> {
  return (await maybeRequireDestructiveElicitation({
    toolName: options.toolName ?? "s3_delete_object",
    args: options.args,
    extra: options.extra,
    config: options.config ?? cfg(),
    sanitizerOptions: {},
    contextProviders: providers,
    runOriginal:
      options.runOriginal ?? (() => ({ content: [{ type: "text" as const, text: "ran" }] })),
  })) as RunResult;
}

describe("destructive-elicitation coverage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.B2_DESTRUCTIVE_ELICITATION;
  });

  describe("prompt detail rendering", () => {
    it("notes a requested governance bypass in the prompt", () => {
      const message = destructiveElicitationMessage("b2_update_file_retention", "clear retention", {
        fileId: "file-1",
        bypassGovernance: true,
      });
      expect(message).toContain("Governance bypass requested.");
    });

    it("omits non-primitive and blank field values", () => {
      const message = destructiveElicitationMessage("s3_delete_object", "delete an object", {
        operation: { nested: true },
        bucketId: "   ",
      });
      expect(message).not.toContain("Operation:");
      expect(message).not.toContain("Bucket ID:");
    });

    it("truncates overlong field values", () => {
      const longKey = "k".repeat(130);
      const message = destructiveElicitationMessage("s3_delete_object", "delete an object", {
        key: longKey,
      });
      expect(message).toContain(`Object key: ${"k".repeat(117)}...`);
      expect(message).not.toContain(longKey);
    });

    it("skips notification event types that are not an array", () => {
      const message = destructiveElicitationMessage(
        "b2_set_bucket_notification_rules",
        "replace notification rules",
        {
          eventNotificationRules: [{ name: "rule", eventTypes: "not-an-array" }],
        },
      );
      expect(message).toContain("Notification rule 1 name: rule.");
      expect(message).not.toContain("event types:");
    });

    it("skips notification event type lists with no safe entries", () => {
      const message = destructiveElicitationMessage(
        "b2_set_bucket_notification_rules",
        "replace notification rules",
        {
          eventNotificationRules: [{ name: "rule", eventTypes: [{}, []] }],
        },
      );
      expect(message).not.toContain("event types:");
    });

    it("summarizes truncated notification event type lists", () => {
      const message = destructiveElicitationMessage(
        "b2_set_bucket_notification_rules",
        "replace notification rules",
        {
          eventNotificationRules: [
            {
              name: "rule",
              eventTypes: ["e1", "e2", "e3", "e4", "e5", "e6", "e7"],
            },
          ],
        },
      );
      expect(message).toContain("Notification rule 1 event types:");
      expect(message).toContain("+2 more");
    });

    it("skips non-object bulk delete targets while rendering later ones", () => {
      const message = destructiveElicitationMessage(
        "s3_delete_objects",
        "delete multiple objects",
        {
          objects: ["not-an-object", { key: "real.txt", versionId: "v-1" }],
        },
      );
      expect(message).toContain("Object 2 key: real.txt.");
      expect(message).toContain("Object 2 version ID: v-1.");
    });

    it("renders and omits lifecycle rule nested fields", () => {
      const message = destructiveElicitationMessage("s3_put_bucket_lifecycle", "expire objects", {
        rules: [
          "not-an-object",
          {
            id: "full",
            status: "Enabled",
            filter: { prefix: "archive/" },
            expiration: { days: 5, expiredObjectDeleteMarker: true },
            noncurrentVersionExpiration: { noncurrentDays: 9 },
            abortIncompleteMultipartUpload: { daysAfterInitiation: 3 },
          },
          { id: "bare" },
        ],
      });
      expect(message).toContain("Rule 2 ID: full.");
      expect(message).toContain("Rule 2 prefix: archive/.");
      expect(message).toContain("Rule 2 expiration days: 5.");
      expect(message).toContain("Rule 2 expired object delete marker: true.");
      expect(message).toContain("Rule 2 noncurrent expiration days: 9.");
      expect(message).toContain("Rule 2 abort incomplete upload days: 3.");
      expect(message).toContain("Rule 3 ID: bare.");
      expect(message).not.toContain("Rule 3 prefix:");
    });

    it("skips non-object notification rules while rendering later ones", () => {
      const message = destructiveElicitationMessage(
        "b2_set_bucket_notification_rules",
        "replace notification rules",
        {
          eventNotificationRules: ["not-an-object", { name: "n1", objectNamePrefix: "in/" }],
        },
      );
      expect(message).toContain("Notification rule 2 name: n1.");
      expect(message).toContain("Notification rule 2 object prefix: in/.");
    });

    it("counts only deletion lifecycle rules and ignores non-object entries", () => {
      const message = destructiveElicitationMessage("s3_put_bucket_lifecycle", "expire objects", {
        rules: [
          null,
          { id: "expire", expiration: { days: 1 } },
          { id: "noncurrent", noncurrentVersionExpiration: { noncurrentDays: 2 } },
          { id: "keep" },
        ],
      });
      expect(message).toContain("Deletion rule count: 2.");
    });
  });

  describe("client capability probing", () => {
    it("treats non-object extra as lacking form elicitation", () => {
      expect(clientSupportsFormElicitation(null)).toBe(false);
      expect(clientSupportsFormElicitation("not-an-object")).toBe(false);
    });

    it("rejects return-based elicitation when no protocol version is present", () => {
      expect(clientCanUseReturnBasedElicitation({ mcpReq: { envelope: {} } })).toBe(false);
      expect(
        clientCanUseReturnBasedElicitation({
          mcpReq: { envelope: { [PROTOCOL_VERSION_META_KEY]: 2026 } },
        }),
      ).toBe(false);
    });
  });

  describe("request-state codec", () => {
    it("rejects request state without the destructive-elicitation prefix", async () => {
      const codec = createDestructiveElicitationRequestStateCodec(cfg());
      await expect(codec.verify("unprefixed-state", {} as never)).rejects.toThrow(/malformed/);
    });
  });

  describe("state verification refusals", () => {
    it("refuses non-elicit input responses even with valid minted state", async () => {
      const args = { bucket: "photos", key: "old.jpg" };
      const original = vi.fn(() => ({ content: [{ type: "text" as const, text: "ran" }] }));

      const minted = await runElicitation({ args, extra: capableExtra(), runOriginal: original });
      expect(minted.resultType).toBe("input_required");
      const requestState = minted.requestState as string;

      const result = await runElicitation({
        args,
        extra: capableExtra(
          { [DESTRUCTIVE_ELICITATION_RESPONSE_KEY]: { roots: [] } },
          requestState,
        ),
        runOriginal: original,
      });

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/response was invalid/i);
      expect(original).not.toHaveBeenCalled();
    });

    it("refuses an accepted response whose request-state payload is invalid", async () => {
      const original = vi.fn(() => ({ content: [{ type: "text" as const, text: "ran" }] }));
      const result = await runElicitation({
        args: { bucket: "photos", key: "old.jpg" },
        extra: capableExtra(
          {
            [DESTRUCTIVE_ELICITATION_RESPONSE_KEY]: {
              action: "accept",
              content: { confirm: true },
            },
          },
          { v: 2, kind: "wrong" },
        ),
        runOriginal: original,
      });

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/payload was invalid/i);
      expect(original).not.toHaveBeenCalled();
    });

    it("refuses an accepted response whose request-state has expired", async () => {
      const original = vi.fn(() => ({ content: [{ type: "text" as const, text: "ran" }] }));
      const result = await runElicitation({
        args: { bucket: "photos", key: "old.jpg" },
        extra: capableExtra(
          {
            [DESTRUCTIVE_ELICITATION_RESPONSE_KEY]: {
              action: "accept",
              content: { confirm: true },
            },
          },
          {
            v: 1,
            kind: "destructive-elicitation",
            toolName: "s3_delete_object",
            effect: "permanently delete an object",
            argsDigest: "some-digest",
            issuedAt: 0,
          },
        ),
        runOriginal: original,
      });

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/expired/i);
      expect(original).not.toHaveBeenCalled();
    });
  });
});
