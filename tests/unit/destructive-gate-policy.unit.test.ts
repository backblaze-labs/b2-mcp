import type { ToolCallback, ToolRegistrar } from "../../src/mcp";
import type { B2Config, DestructivePolicy } from "../../src/utils/types";

let gate: typeof import("../../src/utils/destructive-gate");
beforeEach(async () => {
  // Cover the module-initialized detector registry under the active mutant.
  vi.resetModules();
  gate = await import("../../src/utils/destructive-gate");
});

const config = (destructivePolicy: DestructivePolicy = "confirm"): B2Config =>
  ({
    applicationKey: "application-secret",
    appKey: "legacy-secret",
    masterKey: "master-secret",
    credentialFingerprint: "tenant-fingerprint",
    destructivePolicy,
  }) as B2Config;

const destructiveCalls: Array<[string, Record<string, unknown>, string]> = [
  ["b2_delete_bucket", { bucketId: "bucket-A" }, "permanently delete a bucket"],
  ["s3_delete_object", { bucket: "bucket-A", key: "object-A" }, "permanently delete an object"],
  [
    "s3_delete_objects",
    { bucket: "bucket-A", objects: [{ key: "object-A" }] },
    "permanently delete multiple objects (irreversible)",
  ],
  [
    "s3_get_presigned_url",
    { operation: "PutObject" },
    "mint a PutObject presigned URL bearer capability that can create or overwrite object data",
  ],
  [
    "s3_abort_multipart_upload",
    { uploadId: "upload-A" },
    "abort a multipart upload, discarding uploaded parts (irreversible)",
  ],
  [
    "b2_delete_key",
    { applicationKeyId: "key-A" },
    "permanently delete an application key (anything using it loses access immediately)",
  ],
  ["b2_create_key", { keyName: "key-A" }, "create a durable application key credential"],
  [
    "b2_eject_group_member",
    { memberAccountId: "account-A" },
    "eject a Group member (locks them out; the account cannot be re-added via API)",
  ],
  [
    "b2_create_group_member",
    { memberEmail: "member@example.com" },
    "create a real, non-deletable Backblaze account (irreversible; eject cannot remove it; has billing impact)",
  ],
  [
    "b2_reserve_trial_create_account",
    { email: "member@example.com" },
    "create a real trial Backblaze account (irreversible; has billing impact)",
  ],
  [
    "b2_update_file_retention",
    { fileRetention: { mode: null } },
    "remove Object Lock retention from a file",
  ],
  [
    "b2_update_file_legal_hold",
    { legalHold: "off" },
    "remove a legal hold, making the file deletable again",
  ],
  [
    "s3_put_bucket_lifecycle",
    { rules: [] },
    "clear the bucket's entire S3 lifecycle configuration, removing cleanup and expiration governance",
  ],
  ["b2_update_bucket", { bucketType: "allPublic" }, "make the bucket PUBLIC (world-readable)"],
  [
    "b2_set_bucket_notification_rules",
    { eventNotificationRules: [] },
    "replace persistent bucket event notification webhook rules",
  ],
];

describe("independent destructive gate policy", () => {
  it("exports the complete sorted destructive tool registry", () => {
    expect(gate.DESTRUCTIVE_TOOL_NAMES).toEqual(destructiveCalls.map(([name]) => name).sort());
  });

  it.each(destructiveCalls)("reports and gates the %s effect", (tool, args, effect) => {
    expect(gate.isDestructiveTool(tool)).toBe(true);
    expect(gate.destructiveEffect(tool, args)).toBe(effect);
    for (const [policy, code, status] of [
      ["confirm", "destructive_confirmation_required", 409],
      ["elicit", "destructive_confirmation_refused", 409],
      ["block", "destructive_policy_blocked", 403],
    ] as const) {
      const result = gate.checkDestructive(tool, args, config(policy));
      expect(result).toMatchObject({ ok: false, error: { code, status } });
      if (result.ok) throw new Error("Destructive call unexpectedly allowed");
      expect(result.error.message).toContain(effect);
      expect(result.error.message).toContain(`B2_DESTRUCTIVE_POLICY=${policy}`);
    }
    expect(gate.checkDestructive(tool, args, config("allow"))).toEqual({ ok: true });
    expect(gate.checkDestructive(tool, { ...args, confirm: true }, config())).toEqual({ ok: true });
    expect(gate.checkDestructive(tool, { ...args, confirm: true }, config("elicit"))).toMatchObject(
      { ok: false, error: { code: "destructive_confirmation_refused" } },
    );
  });

  it.each([
    ["empty rules", [], true],
    ["cleanup only", [{ abortIncompleteMultipartUpload: { daysAfterInitiation: 1 } }], false],
    ["current expiration", [{ expiration: { days: 1 } }], true],
    ["previous version expiration", [{ noncurrentVersionExpiration: { noncurrentDays: 1 } }], true],
    [
      "cleanup before expiration",
      [{ abortIncompleteMultipartUpload: { daysAfterInitiation: 1 } }, { expiration: { days: 2 } }],
      true,
    ],
    [
      "expiration before cleanup",
      [{ expiration: { days: 2 } }, { abortIncompleteMultipartUpload: { daysAfterInitiation: 1 } }],
      true,
    ],
    [
      "cleanup before previous version expiration",
      [
        { abortIncompleteMultipartUpload: { daysAfterInitiation: 1 } },
        { noncurrentVersionExpiration: { noncurrentDays: 2 } },
      ],
      true,
    ],
    [
      "absent expiration values",
      [{ expiration: undefined, noncurrentVersionExpiration: undefined }],
      false,
    ],
  ] as const)("classifies S3 lifecycle %s", (_label, rules, destructive) => {
    const result = gate.checkDestructive("s3_put_bucket_lifecycle", { rules }, config("block"));
    expect(result.ok).toBe(!destructive);
    if (rules.length) {
      expect(gate.destructiveEffect("s3_put_bucket_lifecycle", { rules })).toBe(
        destructive
          ? "set a lifecycle rule that schedules deletion/expiration of objects (irreversible once it runs)"
          : null,
      );
    }
  });

  it("treats omitted lifecycle rules as destructive before schema validation", () => {
    expect(gate.destructiveEffect("s3_put_bucket_lifecycle")).toBe(
      "clear the bucket's entire S3 lifecycle configuration, removing cleanup and expiration governance",
    );
    expect(gate.checkDestructive("s3_put_bucket_lifecycle", {}, config("block"))).toMatchObject({
      ok: false,
      error: { code: "destructive_policy_blocked" },
    });
  });

  it.each([
    ["empty rules", [], false],
    ["hide only", [{ daysFromUploadingToHiding: 1 }], false],
    ["deletion", [{ daysFromHidingToDeleting: 1 }], true],
    [
      "hide before deletion",
      [{ daysFromUploadingToHiding: 1 }, { daysFromHidingToDeleting: 2 }],
      true,
    ],
    [
      "deletion before hide",
      [{ daysFromHidingToDeleting: 2 }, { daysFromUploadingToHiding: 1 }],
      true,
    ],
    ["null deletion", [{ daysFromHidingToDeleting: null }], false],
    ["absent deletion", [{ daysFromHidingToDeleting: undefined }], false],
  ] as const)("classifies native lifecycle %s", (_label, lifecycleRules, destructive) => {
    expect(gate.destructiveEffect("b2_update_bucket", { lifecycleRules })).toBe(
      destructive ? "set a lifecycle rule that schedules permanent deletion of objects" : null,
    );
    expect(gate.checkDestructive("b2_update_bucket", { lifecycleRules }, config("block")).ok).toBe(
      !destructive,
    );
  });

  it("includes every simultaneous Object Lock and bucket protection change in the effect", () => {
    expect(
      gate.destructiveEffect("b2_update_file_retention", {
        fileRetention: { mode: null },
        bypassGovernance: true,
      }),
    ).toBe("remove Object Lock retention from a file and bypass governance-mode retention");
    expect(
      gate.destructiveEffect("b2_update_bucket", {
        bucketType: "allPublic",
        fileLockEnabled: false,
        defaultRetention: { mode: null },
        lifecycleRules: [{ daysFromHidingToDeleting: 1 }],
        replicationConfiguration: {},
      }),
    ).toBe(
      "make the bucket PUBLIC (world-readable) and disable Object Lock and clear the bucket's default Object Lock retention and set a lifecycle rule that schedules permanent deletion of objects and set bucket replication rules that can copy objects to another bucket",
    );
  });

  it.each([
    ["b2_update_bucket", {}],
    ["b2_update_bucket", { defaultRetention: { mode: "governance" }, fileLockEnabled: true }],
    [
      "b2_update_file_retention",
      { fileRetention: { mode: "compliance" }, bypassGovernance: false },
    ],
    ["b2_update_file_legal_hold", { legalHold: "on" }],
    ["s3_get_presigned_url", { operation: "GetObject" }],
    ["b2_list_buckets", {}],
  ] as Array<[string, Record<string, unknown>]>)(
    "allows benign %s calls even under block",
    (tool, args) => {
      expect(gate.destructiveEffect(tool, args)).toBeNull();
      expect(gate.checkDestructive(tool, args, config("block"))).toEqual({ ok: true });
    },
  );

  it("keeps all human-approval instructions in refusals", () => {
    const confirm = gate.checkDestructive("b2_delete_bucket", {}, config());
    const elicit = gate.checkDestructive("b2_delete_bucket", {}, config("elicit"));
    if (confirm.ok || elicit.ok) throw new Error("Destructive call unexpectedly allowed");
    expect(confirm.error.message).toContain(
      "not the calling model, to approve this specific action before it runs.",
    );
    expect(confirm.error.message).toContain(
      "Report this refusal and the effect above to the human operator and let them ",
    );
    expect(confirm.error.message).toContain("decide; do not approve it on their behalf.");
    expect(elicit.error.message).toContain(
      "elicitation response for this specific action; a model-supplied confirmation",
    );
    expect(elicit.error.message).toContain(
      "cannot satisfy it, and the action is refused when no such response can be",
    );
    expect(elicit.error.message).toContain(
      "obtained. Report this refusal and the effect above to the human operator.",
    );
  });
});

describe("credential-bound destructive consent", () => {
  it("matches an independently calculated canonical HMAC vector", () => {
    // Python hmac/SHA-256 vector: four NUL-separated credential parts, then the
    // domain prefix plus this manually written canonical JSON representation:
    // {"a":[1,"one",null,true,{"a":false,"z":0}],"bucketId":"bucket-A","nested":{"a":"first","z":"last"}}
    // cspell:disable-next-line
    const expected = "y5o_54AxykMheUrQ8i8kKV9ZBSzz9KJ3r_xlfVTWI_s";
    expect(
      gate.destructiveTargetDigest(config(), {
        nested: { z: "last", a: "first", omitted: undefined },
        bucketId: "bucket-A",
        a: [1, "one", null, true, { z: 0, a: false }],
      }),
    ).toBe(expected);
  });

  it("ignores absent and empty credential parts without adding delimiters", () => {
    const sparse = { applicationKey: "application-secret" } as B2Config;
    const empty = { ...sparse, appKey: "", masterKey: "", credentialFingerprint: "" };
    const expected = "xpki06uHcMrKwtceMROjbw1cTDOA5BluNoHliN9qNyw";
    expect(gate.destructiveTargetDigest(sparse, { bucketId: "bucket-A" })).toBe(expected);
    expect(gate.destructiveTargetDigest(empty, { bucketId: "bucket-A" })).toBe(expected);
  });

  it("omits empty credential parts between populated keys", () => {
    // Trailing NUL bytes alone are hidden by HMAC key padding. An absent or
    // empty legacy key between two populated keys distinguishes the filtering.
    const sparse = { applicationKey: "application-secret", masterKey: "master-secret" } as B2Config;
    // cspell:disable-next-line
    const expected = "XCqCw27wPCpNYyO-COOYJA-wr_x-bg82DUiOmgn-9yU";
    expect(gate.destructiveTargetDigest(sparse, { bucketId: "bucket-A" })).toBe(expected);
    expect(gate.destructiveTargetDigest({ ...sparse, appKey: "" }, { bucketId: "bucket-A" })).toBe(
      expected,
    );
  });

  it.each(["applicationKey", "appKey", "masterKey", "credentialFingerprint"] as const)(
    "rejects consent after the %s credential part changes",
    (part) => {
      const original = config("elicit");
      const changed = { ...original, [part]: `${original[part]}-changed` };
      const args = { bucketId: "bucket-A" };
      const digest = gate.destructiveTargetDigest(original, args);
      expect(gate.destructiveTargetDigest(changed, args)).not.toBe(digest);
      expect(
        gate.runWithDestructiveElicitationConsent("b2_delete_bucket", digest, () =>
          gate.checkDestructive("b2_delete_bucket", args, changed),
        ),
      ).toMatchObject({ ok: false, error: { code: "destructive_confirmation_refused" } });
    },
  );

  it("separates credential part boundaries", () => {
    expect(
      gate.destructiveTargetDigest({ applicationKey: "ab", appKey: "c" } as B2Config, {}),
    ).not.toBe(gate.destructiveTargetDigest({ applicationKey: "a", appKey: "bc" } as B2Config, {}));
  });

  it("canonicalizes object order and absent values while ignoring only top-level confirm", () => {
    const args = { bucketId: "bucket-A", nested: { z: 2, a: 1 }, values: [undefined, null] };
    const equivalent = {
      values: [null, null],
      nested: { a: 1, z: 2, missing: undefined },
      bucketId: "bucket-A",
      confirm: true,
    };
    const digest = gate.destructiveTargetDigest(config(), args);
    expect(gate.destructiveTargetDigest(config(), equivalent)).toBe(digest);
    expect(gate.destructiveTargetDigest(config(), { ...args, confirm: false })).toBe(digest);
    expect(
      gate.destructiveTargetDigest(config(), {
        ...args,
        nested: { ...args.nested, confirm: true },
      }),
    ).not.toBe(digest);
  });

  it.each([
    [{ targets: ["one", "two"] }, { targets: ["two", "one"] }],
    [{ target: { version: 1 } }, { target: { version: "1" } }],
    [{ target: null }, {}],
    [{ targets: [1, 2] }, { targets: [1, 3] }],
  ])("binds consent to the exact target value and type %#", (approved, changed) => {
    expect(gate.destructiveTargetDigest(config(), approved)).not.toBe(
      gate.destructiveTargetDigest(config(), changed),
    );
  });

  it("accepts equivalent args only for the approved tool and restores the outer context", async () => {
    const cfg = config("elicit");
    const args = { bucketId: "bucket-A", nested: { a: 1, b: 2 } };
    const digest = gate.destructiveTargetDigest(cfg, args);
    await gate.runWithDestructiveElicitationConsent("b2_delete_bucket", digest, async () => {
      await Promise.resolve();
      expect(
        gate.checkDestructive(
          "b2_delete_bucket",
          { nested: { b: 2, a: 1 }, bucketId: "bucket-A", confirm: true },
          cfg,
        ),
      ).toEqual({ ok: true });
      expect(gate.checkDestructive("b2_delete_key", args, cfg).ok).toBe(false);
      gate.runWithDestructiveElicitationConsent("b2_delete_key", digest, () => {
        expect(gate.checkDestructive("b2_delete_bucket", args, cfg).ok).toBe(false);
      });
      expect(gate.checkDestructive("b2_delete_bucket", args, cfg)).toEqual({ ok: true });
      expect(
        gate.checkDestructive("b2_delete_bucket", args, { ...cfg, destructivePolicy: "block" }).ok,
      ).toBe(false);
    });
    expect(gate.checkDestructive("b2_delete_bucket", args, cfg).ok).toBe(false);
  });
});

describe("S3 lifecycle handler side effects", () => {
  it.each([
    [
      "refuses mixed expiration",
      "confirm",
      false,
      [{ abortIncompleteMultipartUpload: { daysAfterInitiation: 1 } }, { expiration: { days: 1 } }],
      false,
    ],
    [
      "allows confirmed mixed expiration",
      "confirm",
      true,
      [{ abortIncompleteMultipartUpload: { daysAfterInitiation: 1 } }, { expiration: { days: 1 } }],
      true,
    ],
    [
      "allows benign cleanup under block",
      "block",
      false,
      [{ abortIncompleteMultipartUpload: { daysAfterInitiation: 1 } }],
      true,
    ],
    ["blocks clearing even with confirmation", "block", true, [], false],
  ] as const)("%s", async (_label, policy, confirm, rules, allowed) => {
    const { registerS3BucketTools } = await import("../../src/s3/buckets");
    const callbacks = new Map<string, ToolCallback>();
    const registrar: ToolRegistrar = {
      registerTool: (name, _metadata, callback) => {
        callbacks.set(name, callback);
      },
      hasTool: (name) => callbacks.has(name),
    };
    const client = {
      headBucket: vi.fn(),
      putBucketLifecycle: vi.fn().mockResolvedValue(undefined),
      deleteBucketLifecycle: vi.fn().mockResolvedValue(undefined),
    };
    registerS3BucketTools(registrar, client, config(policy));
    const callback = callbacks.get("s3_put_bucket_lifecycle");
    expect(callback).toBeDefined();
    const result = await callback?.({ bucket: "bucket-A", rules, confirm }, {});
    expect(Boolean(result.isError)).toBe(!allowed);
    expect(client.deleteBucketLifecycle).not.toHaveBeenCalled();
    if (allowed) {
      expect(client.putBucketLifecycle).toHaveBeenCalledExactlyOnceWith({
        bucket: "bucket-A",
        rules,
      });
    } else {
      expect(client.putBucketLifecycle).not.toHaveBeenCalled();
    }
  });
});
