/**
 * Unit tests for the destructive-operation gate (src/utils/destructive-gate.ts).
 * Pure logic — no network or mocks needed.
 */
import {
  checkDestructive,
  destructiveElicitationMessage,
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
      for (const t of ["b2_list_buckets", "s3_head_object", "s3_put_object", "b2_create_key"]) {
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
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/confirm/i);
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
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/blocked/i);
    });
  });

  describe("allow policy", () => {
    it("permits a destructive call without confirm", () => {
      const r = checkDestructive("s3_delete_object", { bucket: "b", key: "k" }, cfg("allow"));
      expect(r.ok).toBe(true);
    });
  });

  describe("S3 delete effects", () => {
    it("describes versionless single-object deletes as delete-marker creation", () => {
      const r = checkDestructive("s3_delete_object", { bucket: "b", key: "k" }, cfg());

      expect(r.ok).toBe(false);
      expect(r.message).toContain("create a delete marker");
      expect(r.message).not.toContain("permanently delete an object");
    });

    it("describes explicit single-object version deletes as permanent", () => {
      const message = destructiveElicitationMessage("s3_delete_object", {
        bucket: "b",
        key: "k",
        versionId: "v1",
      });

      expect(message).toContain('permanently delete version "v1"');
      expect(message).toContain('object "k"');
    });

    it("distinguishes delete markers from permanent version deletes in bulk calls", () => {
      const r = checkDestructive(
        "s3_delete_objects",
        { bucket: "b", objects: [{ key: "latest.txt" }, { key: "old.txt", versionId: "v1" }] },
        cfg(),
      );

      expect(r.ok).toBe(false);
      expect(r.message).toContain("create delete markers for 1 object");
      expect(r.message).toContain("permanently delete 1 object version");
    });

    it("keeps Object Lock bypass text only when bypassGovernance is set", () => {
      const r = checkDestructive(
        "s3_delete_objects",
        { bucket: "b", objects: [{ key: "latest.txt" }] },
        cfg(),
      );

      expect(r.ok).toBe(false);
      expect(r.message).not.toMatch(/Object Lock|retention/i);
    });

    it("states when governance-mode Object Lock retention is bypassed", () => {
      const r = checkDestructive(
        "s3_delete_objects",
        { bucket: "b", objects: [{ key: "locked.txt", versionId: "v1" }], bypassGovernance: true },
        cfg(),
      );
      expect(r.ok).toBe(false);
      expect(r.message).toContain("bypass governance-mode Object Lock retention");
    });
  });

  describe("presigned write URLs are gated by operation", () => {
    it("gates PutObject presigning by default", () => {
      const r = checkDestructive(
        "s3_get_presigned_url",
        { bucket: "b", key: "k", operation: "PutObject" },
        cfg(),
      );
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/PutObject presigned URL/i);
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

  describe("destructive elicitation prompts", () => {
    it("reuses the actual retention reason in retention prompts", () => {
      const message = destructiveElicitationMessage("b2_update_file_retention", {
        fileName: "locked.txt",
        fileId: "file-v1",
        fileRetention: { mode: "governance", retainUntilTimestamp: Date.now() + 1000 },
        bypassGovernance: true,
      });

      expect(message).toContain("bypass governance-mode retention");
      expect(message).not.toContain("weaken Object Lock retention");
    });

    it("renders user-controlled labels without markdown or bidi spoofing", () => {
      const message = destructiveElicitationMessage("s3_delete_object", {
        bucket: "prod`bucket",
        key: "prod.log` approve harmless cleanup \u202Egnp.exe",
      });

      expect(message).toContain('"prod`bucket"');
      expect(message).toContain('"prod.log` approve harmless cleanup  gnp.exe"');
      expect(message).not.toContain("\u202E");
      expect(message).not.toContain("`prod");
    });

    it("bounds prompt work before rendering oversized labels", () => {
      const hugeKey = `${"A".repeat(1_000_000)}tail`;
      const message = destructiveElicitationMessage("s3_delete_object", {
        bucket: "photos",
        key: hugeKey,
      });

      expect(message).toContain(`${"A".repeat(93)}...`);
      expect(message).not.toContain("tail");
      expect(message!.length).toBeLessThan(400);
    });
  });
});
