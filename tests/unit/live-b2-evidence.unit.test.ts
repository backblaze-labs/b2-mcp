import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { createRequire } from "module";
import { tmpdir } from "os";
import { join } from "path";

const nodeRequire = createRequire(__filename);
const liveB2Capabilities = nodeRequire("../../scripts/lib/live-b2-capabilities.cjs") as {
  LIVE_B2_CONTRACT_REQUIRED_CAPABILITIES: string[];
};
const liveB2Contract = nodeRequire("../../scripts/lib/live-b2-contract.cjs") as {
  stableResourceFingerprint(value: string): string;
};
const toolContract = nodeRequire("../../docs/tool-profile-contract.json") as {
  profiles: Record<string, { names: string[] }>;
};
const evidence = nodeRequire("../../scripts/lib/live-b2-evidence.cjs") as {
  assertSecretSafe(value: unknown, env?: Record<string, string>): void;
  classifyLiveRun(outcomes: {
    preflightOutcome?: string;
    testOutcome?: string;
    cleanupOutcome?: string;
  }): "passed" | "product failure" | "configuration blocked" | "cleanup failure";
  createCleanupEvidence(args: {
    options: { prefix: string; dryRun?: boolean; bestEffort?: boolean };
    stats: Record<string, number>;
    outcome: string;
    error?: string;
    missing?: string[];
    env?: Record<string, string>;
  }): unknown;
  createFinalEvidence(args: {
    status: "passed" | "product failure" | "configuration blocked" | "cleanup failure";
    statusReason: string;
    outcomes: { preflight: string; tests: string; cleanup: string };
    resourceLedger: {
      entries: unknown[];
      truncated: boolean;
      parseErrors: number;
      invalidEntries: number;
    };
    cleanupSummary: { present: boolean; summary: unknown; validationError: string | null };
    validationSummary: { present: boolean; summary: unknown; validationError: string | null };
    expectedToolProfile?: string | null;
    env?: Record<string, string>;
  }): unknown;
  createPreflightEvidence(args: {
    status: "passed" | "product failure" | "configuration blocked" | "cleanup failure";
    statusReason: string;
    configuration?: Record<string, unknown>;
    credentialPolicy?: Record<string, unknown>;
    target?: unknown;
    error?: string;
    env?: Record<string, string>;
  }): unknown;
  readCleanupSummary(
    path: string,
    options?: { expectedPrefix?: string; env?: Record<string, string> },
  ): { present: boolean; summary: unknown; validationError: string | null };
  readResourceLedger(
    path: string,
    options?: { expectedPrefix?: string },
  ): {
    entries: Array<Record<string, unknown>>;
    truncated: boolean;
    parseErrors: number;
    invalidEntries: number;
  };
  recordLiveResource(
    resource: { type?: string; label?: string; name?: string; id?: string },
    options?: { ledgerPath?: string; prefix?: string; env?: Record<string, string> },
  ): Record<string, unknown> | null;
  validateCleanupSummary(
    value: unknown,
    options?: { expectedPrefix?: string; env?: Record<string, string> },
  ): unknown;
  writeEvidenceJson(path: string, value: unknown, env?: Record<string, string>): void;
};

const LIVE_PREFIX = "mcp-contract-run1";
const EXPECTED_PROFILE = "live-b2-contract";
const EXPECTED_ACCOUNT_ID = "fake-account-id";
const HEX_12 = "a".repeat(12);
const EXPECTED_PROFILE_NAMES = toolContract.profiles[EXPECTED_PROFILE].names;
const EXPECTED_PROFILE_HASH = createHash("sha256")
  .update(JSON.stringify([...EXPECTED_PROFILE_NAMES].sort()))
  .digest("hex");
const EXPECTED_ACCOUNT_FINGERPRINT = liveB2Contract.stableResourceFingerprint(EXPECTED_ACCOUNT_ID);
const EXPECTED_NOTIFICATION_BUCKET = "fake-notification-bucket";
const EXPECTED_NOTIFICATION_BUCKET_FINGERPRINT = liveB2Contract.stableResourceFingerprint(
  EXPECTED_NOTIFICATION_BUCKET,
);

function validValidationSummary(
  options: {
    accountMatched?: boolean;
    expectedToolProfile?: string;
    expectedToolProfileApproved?: boolean;
    forbiddenCapabilitiesGranted?: string[];
    missingRequiredCapabilities?: string[];
    notificationBucketValidated?: boolean;
    toolProfileMatches?: boolean;
    toolCount?: number;
    namesHash?: string;
    accountFingerprint?: string;
    expectedAccountFingerprint?: string;
    notificationBucketFingerprint?: string;
  } = {},
) {
  const requiredCapabilities = liveB2Capabilities.LIVE_B2_CONTRACT_REQUIRED_CAPABILITIES;
  const missingRequiredCapabilities = options.missingRequiredCapabilities ?? [];
  const forbiddenCapabilitiesGranted = options.forbiddenCapabilitiesGranted ?? [];
  const toolProfileMatches = options.toolProfileMatches ?? true;
  return {
    schemaVersion: 1,
    status: "passed",
    statusReason: "live B2 validation passed for this Node matrix leg",
    isolation: {
      runPrefix: LIVE_PREFIX,
      safePrefix: true,
      sourceIncludesRunId: true,
    },
    configuration: {
      expectedToolProfile: options.expectedToolProfile ?? EXPECTED_PROFILE,
      expectedToolProfileApproved: options.expectedToolProfileApproved ?? true,
      actualToolProfile: {
        toolCount: options.toolCount ?? EXPECTED_PROFILE_NAMES.length,
        namesHash: options.namesHash ?? EXPECTED_PROFILE_HASH,
        matchesExpectedProfile: toolProfileMatches,
        missingExpectedTools: toolProfileMatches ? [] : ["b2_list_buckets"],
        unexpectedTools: [],
      },
    },
    target: {
      accountMatchedExpectedLiveTestAccount: options.accountMatched ?? true,
      accountFingerprint: options.accountFingerprint ?? EXPECTED_ACCOUNT_FINGERPRINT,
      expectedAccountFingerprint:
        options.expectedAccountFingerprint ?? EXPECTED_ACCOUNT_FINGERPRINT,
      notificationBucketConfigured: true,
      notificationBucketValidated: options.notificationBucketValidated ?? true,
      notificationRuleToolRegistered: true,
      notificationBucketFingerprint:
        options.notificationBucketFingerprint ?? EXPECTED_NOTIFICATION_BUCKET_FINGERPRINT,
    },
    credentialPolicy: {
      nonMasterApplicationKey: forbiddenCapabilitiesGranted.length === 0,
      overbroadCredentialRejected: forbiddenCapabilitiesGranted.length > 0,
      requiredCapabilitiesPresent: requiredCapabilities.filter(
        (capability) => !missingRequiredCapabilities.includes(capability),
      ),
      missingRequiredCapabilities,
      forbiddenCapabilitiesGranted,
    },
  };
}

function validCleanupSummary(
  options: { dryRun?: boolean; errors?: number; leakedBuckets?: number; outcome?: string } = {},
) {
  return evidence.createCleanupEvidence({
    options: { prefix: LIVE_PREFIX, dryRun: options.dryRun ?? false },
    stats: {
      buckets: 1,
      objectVersions: 0,
      multipartUploads: 0,
      leakedBuckets: options.leakedBuckets ?? 0,
      errors: options.errors ?? 0,
    },
    outcome: options.outcome ?? "passed",
  });
}

function finalizeFixture(options: {
  cleanupSummary?: unknown;
  ledger?: "valid" | "empty" | "incomplete" | "nonmatching";
  testOutcome?: string;
  validationSummary?: unknown;
}) {
  const dir = mkdtempSync(join(tmpdir(), "b2-mcp-live-finalize-"));
  try {
    const out = join(dir, "final.json");
    const ledgerPath = join(dir, "resources.jsonl");
    const cleanupPath = join(dir, "cleanup.json");
    const validationPath = join(dir, "validation.json");
    writeFileSync(
      validationPath,
      `${JSON.stringify(options.validationSummary ?? validValidationSummary())}\n`,
    );
    writeFileSync(
      cleanupPath,
      `${JSON.stringify(options.cleanupSummary ?? validCleanupSummary())}\n`,
    );

    if ((options.ledger ?? "valid") === "valid") {
      evidence.recordLiveResource(
        {
          type: "bucket",
          label: "integration",
          name: `${LIVE_PREFIX}-integration-abc123`,
          id: "bucket-id-sensitive",
        },
        { ledgerPath, prefix: LIVE_PREFIX },
      );
    } else if (options.ledger === "nonmatching") {
      writeFileSync(
        ledgerPath,
        `${JSON.stringify({
          schemaVersion: 1,
          type: "bucket",
          label: "integration",
          runPrefix: LIVE_PREFIX,
          matchesRunPrefix: false,
          nameFingerprint: HEX_12,
          idFingerprint: HEX_12,
        })}\n`,
      );
    } else if (options.ledger === "incomplete") {
      writeFileSync(
        ledgerPath,
        `${JSON.stringify({
          schemaVersion: 1,
          type: "bucket",
          label: "integration",
          runPrefix: LIVE_PREFIX,
          matchesRunPrefix: true,
        })}\n`,
      );
    } else {
      writeFileSync(ledgerPath, "");
    }

    const result = spawnSync(
      process.execPath,
      [
        "scripts/live-b2-evidence.mjs",
        "finalize",
        "--out",
        out,
        "--resource-ledger",
        ledgerPath,
        "--cleanup-summary",
        cleanupPath,
        "--validation-summary",
        validationPath,
        "--preflight-outcome",
        "success",
        "--test-outcome",
        options.testOutcome ?? "success",
        "--cleanup-outcome",
        "success",
      ],
      {
        cwd: join(__dirname, "../.."),
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          B2_APPLICATION_KEY_ID: "fake-key-id-secret",
          B2_APPLICATION_KEY: "fake-application-key-secret",
          B2_LIVE_NOTIFICATION_BUCKET: EXPECTED_NOTIFICATION_BUCKET,
          B2_LIVE_TEST_ACCOUNT_ID: EXPECTED_ACCOUNT_ID,
          B2_MCP_EXPECTED_TOOL_PROFILE: EXPECTED_PROFILE,
          B2_MCP_LIVE_RUN_PREFIX: LIVE_PREFIX,
        },
      },
    );
    expect(result.status).toBe(0);
    return JSON.parse(readFileSync(out, "utf8")) as {
      status: string;
      cleanup: { stats: { errors: number; leakedBuckets: number } | null };
      resources: { createdCount: number; invalidEntries: number; parseErrors: number };
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("live B2 evidence", () => {
  it("classifies configuration, product, and cleanup failures distinctly", () => {
    expect(
      evidence.classifyLiveRun({
        preflightOutcome: "failure",
        testOutcome: "skipped",
        cleanupOutcome: "skipped",
      }),
    ).toBe("configuration blocked");
    expect(
      evidence.classifyLiveRun({
        preflightOutcome: "success",
        testOutcome: "failure",
        cleanupOutcome: "success",
      }),
    ).toBe("product failure");
    expect(
      evidence.classifyLiveRun({
        preflightOutcome: "success",
        testOutcome: "failure",
        cleanupOutcome: "failure",
      }),
    ).toBe("cleanup failure");
    expect(
      evidence.classifyLiveRun({
        preflightOutcome: "success",
        testOutcome: "success",
        cleanupOutcome: "success",
      }),
    ).toBe("passed");
  });

  it("refuses to write configured credential values to evidence JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-live-evidence-"));
    try {
      const out = join(dir, "evidence.json");
      expect(() =>
        evidence.writeEvidenceJson(
          out,
          { credentialLeak: "live-key-id-secret-value" },
          {
            B2_APPLICATION_KEY_ID: "live-key-id-secret-value",
            B2_APPLICATION_KEY: "live-application-key-secret-value",
          },
        ),
      ).toThrow(/B2_APPLICATION_KEY_ID/);
      expect(() =>
        evidence.writeEvidenceJson(
          out,
          { bucketLeak: "notification-bucket-sensitive-value" },
          {
            B2_LIVE_NOTIFICATION_BUCKET: "notification-bucket-sensitive-value",
          },
        ),
      ).toThrow(/B2_LIVE_NOTIFICATION_BUCKET/);

      evidence.writeEvidenceJson(
        out,
        {
          credentialProof: {
            keyIdOmitted: true,
            applicationKeyOmitted: true,
            fingerprint: "7c1b8d3a4e2f",
          },
        },
        {
          B2_APPLICATION_KEY_ID: "live-key-id-secret-value",
          B2_APPLICATION_KEY: "live-application-key-secret-value",
          B2_LIVE_NOTIFICATION_BUCKET: "notification-bucket-sensitive-value",
        },
      );
      const written = readFileSync(out, "utf8");
      expect(written).not.toContain("live-key-id-secret-value");
      expect(written).not.toContain("live-application-key-secret-value");
      expect(written).not.toContain("notification-bucket-sensitive-value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits runtime authorization details from free-form evidence fields", () => {
    expect(
      evidence.createPreflightEvidence({
        status: "configuration blocked",
        statusReason: "preflight failed",
        error: 'B2 error {"authorizationToken":"runtime-issued-token-secret","code":"bad"}',
      }),
    ).toMatchObject({
      error: "[omitted unsafe detail]",
    });

    expect(
      evidence.createCleanupEvidence({
        options: { prefix: "mcp-contract-run1" },
        stats: {
          buckets: 0,
          notificationRules: 0,
          objectVersions: 0,
          multipartUploads: 0,
          leakedBuckets: 0,
          errors: 1,
        },
        outcome: "cleanup failure",
        error: "Authorization: Bearer runtime-issued-token-secret",
      }),
    ).toMatchObject({
      error: "[omitted unsafe detail]",
    });
  });

  it("records live resource evidence without raw bucket names or ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-live-resource-"));
    try {
      const ledgerPath = join(dir, "resources.jsonl");
      const entry = evidence.recordLiveResource(
        {
          type: "bucket",
          label: "integration",
          name: "mcp-contract-run1-integration-abc123",
          id: "bucket-id-sensitive",
        },
        { ledgerPath, prefix: "mcp-contract-run1" },
      );

      expect(entry).toMatchObject({
        type: "bucket",
        label: "integration",
        runPrefix: "mcp-contract-run1",
        matchesRunPrefix: true,
      });
      const written = readFileSync(ledgerPath, "utf8");
      expect(written).not.toContain("mcp-contract-run1-integration-abc123");
      expect(written).not.toContain("bucket-id-sensitive");
      expect(written).toContain('"nameFingerprint"');
      expect(written).toContain('"idFingerprint"');

      const ledger = evidence.readResourceLedger(ledgerPath, {
        expectedPrefix: "mcp-contract-run1",
      });
      expect(ledger.entries).toHaveLength(1);
      expect(ledger.truncated).toBe(false);
      expect(ledger.parseErrors).toBe(0);
      expect(ledger.invalidEntries).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops forged ledger and cleanup values before final evidence is written", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-live-forged-evidence-"));
    const env = {
      B2_MCP_LIVE_RUN_PREFIX: "mcp-contract-run1",
      B2_MCP_EXPECTED_TOOL_PROFILE: "full",
      B2_APPLICATION_KEY_ID: "forged-key-id-secret",
      B2_APPLICATION_KEY: "forged-application-key-secret",
      B2_LIVE_NOTIFICATION_BUCKET: "forged-notification-bucket-secret",
    };
    try {
      const ledgerPath = join(dir, "resources.jsonl");
      evidence.recordLiveResource(
        {
          type: "bucket",
          label: "integration",
          name: "mcp-contract-run1-integration-abc123",
          id: "bucket-id-sensitive",
        },
        { ledgerPath, prefix: "mcp-contract-run1" },
      );
      writeFileSync(
        ledgerPath,
        `${JSON.stringify({
          type: "forged-application-key-secret",
          label: "forged-notification-bucket-secret",
          runPrefix: "mcp-contract-run1",
          matchesRunPrefix: true,
          nameFingerprint: "forged-application-key-secret",
          idFingerprint: "forged-key-id-secret",
        })}\n`,
        { flag: "a" },
      );
      writeFileSync(
        ledgerPath,
        `${JSON.stringify({
          schemaVersion: 1,
          type: "bucket",
          label: "forged-application-key-secret",
          runPrefix: "mcp-contract-run1",
          matchesRunPrefix: true,
          nameFingerprint: "aaaaaaaaaaaa",
          idFingerprint: "bbbbbbbbbbbb",
        })}\n`,
        { flag: "a" },
      );
      const cleanupPath = join(dir, "cleanup.json");
      writeFileSync(
        cleanupPath,
        `${JSON.stringify({
          prefix: "mcp-contract-run1",
          outcome: "cleanup failure",
          cleanup: {
            buckets: 1,
            objectVersions: "forged-application-key-secret",
            multipartUploads: 0,
            leakedBuckets: 0,
            errors: 1,
          },
          error: "forged-key-id-secret",
        })}\n`,
      );

      const finalEvidence = evidence.createFinalEvidence({
        status: "cleanup failure",
        statusReason: "cleanup failed",
        outcomes: { preflight: "success", tests: "success", cleanup: "failure" },
        resourceLedger: evidence.readResourceLedger(ledgerPath, {
          expectedPrefix: "mcp-contract-run1",
        }),
        cleanupSummary: evidence.readCleanupSummary(cleanupPath, {
          expectedPrefix: "mcp-contract-run1",
          env,
        }),
        validationSummary: { present: false, summary: null, validationError: null },
        expectedToolProfile: "full",
        env,
      }) as {
        resources: { createdCount: number; invalidEntries: number };
        cleanup: { stats: unknown; validationError: string | null };
      };
      const serialized = JSON.stringify(finalEvidence);

      expect(finalEvidence.resources.createdCount).toBe(2);
      expect(finalEvidence.resources.invalidEntries).toBe(1);
      expect(finalEvidence.cleanup.stats).toBeNull();
      expect(finalEvidence.cleanup.validationError).toBe(
        "cleanup summary failed evidence schema validation",
      );
      expect(serialized).not.toContain("forged-key-id-secret");
      expect(serialized).not.toContain("forged-application-key-secret");
      expect(serialized).not.toContain("forged-notification-bucket-secret");
      expect(serialized).not.toContain("bucket-id-sensitive");
      expect(serialized).not.toContain("mcp-contract-run1-integration-abc123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not trust status-only validation summaries during finalization", () => {
    expect(
      finalizeFixture({
        validationSummary: validValidationSummary({ accountMatched: false }),
      }).status,
    ).toBe("configuration blocked");
    expect(
      finalizeFixture({
        validationSummary: validValidationSummary({ expectedToolProfile: "full" }),
      }).status,
    ).toBe("configuration blocked");
    expect(
      finalizeFixture({
        validationSummary: validValidationSummary({ forbiddenCapabilitiesGranted: ["writeKeys"] }),
      }).status,
    ).toBe("configuration blocked");
    expect(
      finalizeFixture({
        validationSummary: validValidationSummary({
          missingRequiredCapabilities: ["writeBucketNotifications"],
        }),
      }).status,
    ).toBe("configuration blocked");
    expect(
      finalizeFixture({
        validationSummary: validValidationSummary({
          toolCount: 1,
          namesHash: "c".repeat(64),
        }),
      }).status,
    ).toBe("configuration blocked");
    expect(
      finalizeFixture({
        validationSummary: validValidationSummary({ accountFingerprint: HEX_12 }),
      }).status,
    ).toBe("configuration blocked");
    expect(
      finalizeFixture({
        validationSummary: validValidationSummary({ expectedAccountFingerprint: HEX_12 }),
      }).status,
    ).toBe("configuration blocked");
    expect(
      finalizeFixture({
        validationSummary: validValidationSummary({ notificationBucketFingerprint: HEX_12 }),
      }).status,
    ).toBe("configuration blocked");
  });

  it("requires cleanup summaries to prove non-dry-run cleanup with no leftovers", () => {
    expect(
      finalizeFixture({
        cleanupSummary: validCleanupSummary({ dryRun: true }),
      }).status,
    ).toBe("cleanup failure");
    expect(
      finalizeFixture({
        cleanupSummary: validCleanupSummary({ errors: 1 }),
      }).status,
    ).toBe("cleanup failure");
    expect(
      finalizeFixture({
        cleanupSummary: validCleanupSummary({ leakedBuckets: 1 }),
      }).status,
    ).toBe("cleanup failure");
    expect(
      finalizeFixture({
        cleanupSummary: validCleanupSummary({ outcome: "configuration blocked" }),
      }).status,
    ).toBe("cleanup failure");
  });

  it("requires a successful run to publish isolated resource ledger evidence", () => {
    const missingLedger = finalizeFixture({ ledger: "empty" });
    expect(missingLedger.status).toBe("cleanup failure");
    expect(missingLedger.resources.createdCount).toBe(0);

    const nonmatchingLedger = finalizeFixture({ ledger: "nonmatching" });
    expect(nonmatchingLedger.status).toBe("cleanup failure");
    expect(nonmatchingLedger.resources.invalidEntries).toBe(1);
    const incompleteLedger = finalizeFixture({ ledger: "incomplete" });
    expect(incompleteLedger.status).toBe("cleanup failure");
    expect(incompleteLedger.resources.invalidEntries).toBe(1);
  });

  it("validates cleanup summaries with finite counters and safe prefixes", () => {
    const summary = evidence.createCleanupEvidence({
      options: { prefix: "mcp-contract-run1" },
      stats: {
        buckets: 1,
        objectVersions: 2,
        multipartUploads: 0,
        leakedBuckets: 0,
        errors: 0,
      },
      outcome: "passed",
    });

    expect(
      evidence.validateCleanupSummary(summary, { expectedPrefix: "mcp-contract-run1" }),
    ).toMatchObject({
      outcome: "passed",
      prefix: "mcp-contract-run1",
      cleanup: {
        buckets: 1,
        objectVersions: 2,
        multipartUploads: 0,
        leakedBuckets: 0,
        errors: 0,
      },
    });
    expect(() =>
      evidence.validateCleanupSummary(
        {
          schemaVersion: 1,
          prefix: "mcp-contract-run1",
          outcome: "passed",
          cleanup: {
            buckets: Number.POSITIVE_INFINITY,
            objectVersions: 0,
            multipartUploads: 0,
            leakedBuckets: 0,
            errors: 0,
          },
        },
        { expectedPrefix: "mcp-contract-run1" },
      ),
    ).toThrow(/finite non-negative integer/);
  });

  it("blocks preflight before B2 calls when B2_REGION is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-live-region-preflight-"));
    try {
      const out = join(dir, "preflight.json");
      const result = spawnSync(
        process.execPath,
        ["scripts/live-b2-evidence.mjs", "preflight", "--out", out],
        {
          cwd: join(__dirname, "../.."),
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            B2_APPLICATION_KEY_ID: "fake-key-id",
            B2_APPLICATION_KEY: "fake-application-key",
            B2_LIVE_TEST_ACCOUNT_ID: "fake-account-id",
            B2_LIVE_NOTIFICATION_BUCKET: "fake-notification-bucket",
            B2_MCP_EXPECTED_TOOL_PROFILE: "live-b2-contract",
            B2_MCP_LIVE_RUN_PREFIX: "mcp-contract-region",
            B2_REQUIRE_LIVE_TESTS: "1",
            B2_INTEGRATION_REQUIRE_CREDENTIALS: "1",
          },
        },
      );

      expect(result.status).toBe(2);
      const written = JSON.parse(readFileSync(out, "utf8")) as {
        status: string;
        configuration: { missingEnv: string[] };
      };
      expect(written.status).toBe("configuration blocked");
      expect(written.configuration.missingEnv).toContain("B2_REGION");
      expect(JSON.stringify(written)).not.toContain("fake-application-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
