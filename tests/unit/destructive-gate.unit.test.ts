/**
 * Unit tests for the destructive-operation gate (src/utils/destructive-gate.ts).
 * Pure logic — no network or mocks needed.
 */
import {
  checkDestructive,
  getDestructivePolicy,
  isDestructiveTool,
} from "../../src/utils/destructive-gate";
import { B2Config, DestructivePolicy } from "../../src/utils/types";

// Only `destructivePolicy` is read by the gate; cast a partial config.
const cfg = (destructivePolicy?: DestructivePolicy): B2Config =>
  ({ destructivePolicy }) as unknown as B2Config;

describe("destructive-gate", () => {
  describe("isDestructiveTool", () => {
    it("flags exactly the destructive tools", () => {
      for (const t of [
        "b2_delete_bucket",
        "s3_delete_object",
        "s3_delete_objects",
        "s3_get_presigned_url",
        "b2_delete_key",
        "b2_create_key",
        "s3_abort_multipart_upload",
        "b2_eject_group_member",
        "b2_update_bucket",
        "b2_set_bucket_notification_rules",
        // protection-removal, account creation, and mass-delete-via-lifecycle
        "b2_update_file_retention",
        "b2_update_file_legal_hold",
        "b2_create_group_member",
        "b2_reserve_trial_create_account",
        "s3_put_bucket_lifecycle",
      ]) {
        expect(isDestructiveTool(t)).toBe(true);
      }
    });

    it("does not flag read/safe tools", () => {
      for (const t of ["b2_list_buckets", "s3_head_object", "s3_put_object"]) {
        expect(isDestructiveTool(t)).toBe(false);
      }
    });
  });

  describe("getDestructivePolicy", () => {
    it("defaults to confirm (incl. for unknown values)", () => {
      expect(getDestructivePolicy(cfg(undefined))).toBe("confirm");
      expect(getDestructivePolicy(cfg("garbage" as unknown as DestructivePolicy))).toBe("confirm");
    });

    it("honors allow and block", () => {
      expect(getDestructivePolicy(cfg("allow"))).toBe("allow");
      expect(getDestructivePolicy(cfg("block"))).toBe("block");
    });
  });

  describe("confirm policy (default)", () => {
    it("blocks a destructive call without confirm", () => {
      const r = checkDestructive("b2_delete_bucket", { bucketId: "b" }, cfg());
      expect(r).toMatchObject({
        ok: false,
        error: {
          code: "destructive_confirmation_required",
          status: 409,
          message: expect.stringMatching(/confirm/i),
        },
      });
    });

    it("allows a destructive call with confirm:true", () => {
      const r = checkDestructive("b2_delete_bucket", { bucketId: "b", confirm: true }, cfg());
      expect(r.ok).toBe(true);
    });
  });

  describe("block policy", () => {
    it("refuses even with confirm:true", () => {
      const r = checkDestructive(
        "b2_delete_key",
        { applicationKeyId: "k", confirm: true },
        cfg("block"),
      );
      expect(r).toMatchObject({
        ok: false,
        error: {
          code: "destructive_policy_blocked",
          status: 403,
          message: expect.stringMatching(/blocked/i),
        },
      });
    });
  });

  describe("allow policy", () => {
    it("permits a destructive call without confirm", () => {
      const r = checkDestructive("s3_delete_object", { bucket: "b", key: "k" }, cfg("allow"));
      expect(r.ok).toBe(true);
    });
  });

  describe("s3_delete_objects Object Lock bypass text", () => {
    it("keeps the plain delete effect unchanged", () => {
      const r = checkDestructive("s3_delete_objects", { bucket: "b", objects: [] }, cfg());
      expect(r).toMatchObject({
        ok: false,
        error: {
          message: expect.stringContaining("permanently delete multiple objects (irreversible)"),
        },
      });
      if (!r.ok) expect(r.error.message).not.toMatch(/Object Lock|retention/i);
    });

    it("states when governance-mode Object Lock retention is bypassed", () => {
      const r = checkDestructive(
        "s3_delete_objects",
        { bucket: "b", objects: [], bypassGovernance: true },
        cfg(),
      );
      expect(r).toMatchObject({
        ok: false,
        error: {
          message: expect.stringContaining("bypass governance-mode Object Lock retention"),
        },
      });
    });
  });

  describe("presigned write URLs are gated by operation", () => {
    it("gates PutObject presigning by default", () => {
      const r = checkDestructive(
        "s3_get_presigned_url",
        { bucket: "b", key: "k", operation: "PutObject" },
        cfg(),
      );
      expect(r).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/PutObject presigned URL/i) },
      });
    });

    it("allows confirmed PutObject presigning", () => {
      const r = checkDestructive(
        "s3_get_presigned_url",
        { bucket: "b", key: "k", operation: "PutObject", confirm: true },
        cfg(),
      );
      expect(r.ok).toBe(true);
    });

    it("does not gate GetObject presigning", () => {
      const r = checkDestructive(
        "s3_get_presigned_url",
        { bucket: "b", key: "k", operation: "GetObject" },
        cfg(),
      );
      expect(r.ok).toBe(true);
    });
  });

  describe("non-destructive tools always pass", () => {
    it("a read tool is never gated", () => {
      expect(checkDestructive("b2_list_buckets", {}, cfg()).ok).toBe(true);
    });
  });

  describe("b2_update_bucket is gated only when the change is destructive", () => {
    it("gates a flip to allPublic", () => {
      expect(
        checkDestructive("b2_update_bucket", { bucketId: "b", bucketType: "allPublic" }, cfg()).ok,
      ).toBe(false);
    });

    it("gates disabling Object Lock", () => {
      expect(
        checkDestructive("b2_update_bucket", { bucketId: "b", fileLockEnabled: false }, cfg()).ok,
      ).toBe(false);
    });

    it("gates clearing the default retention", () => {
      expect(
        checkDestructive(
          "b2_update_bucket",
          { bucketId: "b", defaultRetention: { mode: null, period: null } },
          cfg(),
        ).ok,
      ).toBe(false);
    });

    it("does NOT gate benign updates (allPrivate, enabling lock, CORS)", () => {
      expect(
        checkDestructive("b2_update_bucket", { bucketId: "b", bucketType: "allPrivate" }, cfg()).ok,
      ).toBe(true);
      expect(
        checkDestructive("b2_update_bucket", { bucketId: "b", fileLockEnabled: true }, cfg()).ok,
      ).toBe(true);
      expect(checkDestructive("b2_update_bucket", { bucketId: "b", corsRules: [] }, cfg()).ok).toBe(
        true,
      );
    });

    it("gates a lifecycle rule that schedules deletion", () => {
      expect(
        checkDestructive(
          "b2_update_bucket",
          { bucketId: "b", lifecycleRules: [{ fileNamePrefix: "", daysFromHidingToDeleting: 1 }] },
          cfg(),
        ).ok,
      ).toBe(false);
    });

    it("gates replication configuration changes", () => {
      expect(
        checkDestructive(
          "b2_update_bucket",
          {
            bucketId: "b",
            replicationConfiguration: {
              asReplicationSource: {
                replicationRules: [
                  {
                    replicationRuleName: "copy-all",
                    destinationBucketId: "dest-bucket",
                    isEnabled: true,
                    priority: 1,
                  },
                ],
                sourceApplicationKeyId: "source-key",
              },
            },
          },
          cfg(),
        ).ok,
      ).toBe(false);
    });

    it("does NOT gate a hide-only lifecycle rule (no deletion)", () => {
      expect(
        checkDestructive(
          "b2_update_bucket",
          { bucketId: "b", lifecycleRules: [{ fileNamePrefix: "", daysFromUploadingToHiding: 1 }] },
          cfg(),
        ).ok,
      ).toBe(true);
    });
  });

  describe("b2_set_bucket_notification_rules is gated", () => {
    it("requires confirmation by default", () => {
      expect(
        checkDestructive(
          "b2_set_bucket_notification_rules",
          {
            bucketId: "b",
            eventNotificationRules: [
              {
                name: "r",
                eventTypes: ["b2:ObjectCreated:*"],
                isEnabled: true,
                targetConfiguration: { targetType: "webhook", url: "https://example.com/hook" },
              },
            ],
          },
          cfg(),
        ).ok,
      ).toBe(false);
    });

    it("is refused under block even with confirmation", () => {
      expect(
        checkDestructive(
          "b2_set_bucket_notification_rules",
          {
            bucketId: "b",
            eventNotificationRules: [],
            confirm: true,
          },
          cfg("block"),
        ).ok,
      ).toBe(false);
    });
  });

  describe("Object Lock protection removal is gated", () => {
    it("gates clearing file retention (mode:null)", () => {
      expect(
        checkDestructive(
          "b2_update_file_retention",
          { fileId: "f", fileName: "n", fileRetention: { mode: null, retainUntilTimestamp: null } },
          cfg(),
        ).ok,
      ).toBe(false);
    });

    it("gates bypassGovernance even when extending retention", () => {
      expect(
        checkDestructive(
          "b2_update_file_retention",
          {
            fileId: "f",
            fileName: "n",
            fileRetention: { mode: "governance" },
            bypassGovernance: true,
          },
          cfg(),
        ).ok,
      ).toBe(false);
    });

    it("does NOT gate a normal retention set (governance/compliance, no bypass)", () => {
      expect(
        checkDestructive(
          "b2_update_file_retention",
          {
            fileId: "f",
            fileName: "n",
            fileRetention: { mode: "compliance", retainUntilTimestamp: 1 },
          },
          cfg(),
        ).ok,
      ).toBe(true);
    });

    it("gates removing a legal hold (off) but not applying one (on)", () => {
      expect(
        checkDestructive(
          "b2_update_file_legal_hold",
          { fileId: "f", fileName: "n", legalHold: "off" },
          cfg(),
        ).ok,
      ).toBe(false);
      expect(
        checkDestructive(
          "b2_update_file_legal_hold",
          { fileId: "f", fileName: "n", legalHold: "on" },
          cfg(),
        ).ok,
      ).toBe(true);
    });
  });

  describe("irreversible account creation is always gated", () => {
    it("gates b2_create_group_member", () => {
      expect(checkDestructive("b2_create_group_member", { memberEmail: "a@b.c" }, cfg()).ok).toBe(
        false,
      );
    });
    it("gates b2_reserve_trial_create_account", () => {
      expect(
        checkDestructive("b2_reserve_trial_create_account", { email: "a@b.c" }, cfg()).ok,
      ).toBe(false);
    });
  });

  describe("lifecycle mass-delete is gated (s3)", () => {
    it("gates clearing lifecycle configuration", () => {
      expect(
        checkDestructive("s3_put_bucket_lifecycle", { bucket: "b", rules: [] }, cfg()).ok,
      ).toBe(false);
    });

    it("gates an expiration rule", () => {
      expect(
        checkDestructive(
          "s3_put_bucket_lifecycle",
          { bucket: "b", rules: [{ id: "r", status: "Enabled", expiration: { days: 1 } }] },
          cfg(),
        ).ok,
      ).toBe(false);
    });
    it("does NOT gate an abort-incomplete-upload-only rule", () => {
      expect(
        checkDestructive(
          "s3_put_bucket_lifecycle",
          {
            bucket: "b",
            rules: [
              {
                id: "r",
                status: "Enabled",
                abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
              },
            ],
          },
          cfg(),
        ).ok,
      ).toBe(true);
    });
  });
});
