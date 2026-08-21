import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { join } from "path";

const nodeRequire = createRequire(__filename);
const evidence = nodeRequire("../../scripts/lib/live-b2-evidence.cjs") as {
  assertSecretSafe(value: unknown, env?: Record<string, string>): void;
  classifyLiveRun(outcomes: {
    preflightOutcome?: string;
    testOutcome?: string;
    cleanupOutcome?: string;
  }): "passed" | "product failure" | "configuration blocked" | "cleanup failure";
  readResourceLedger(path: string): {
    entries: unknown[];
    truncated: boolean;
    parseErrors: number;
  };
  writeEvidenceJson(path: string, value: unknown, env?: Record<string, string>): void;
};

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

  it("loads bounded resource ledger entries without raw secret material", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2-mcp-live-ledger-"));
    try {
      const ledgerPath = join(dir, "resources.jsonl");
      writeFileSync(ledgerPath, `${JSON.stringify({ ok: true })}\n`);
      const ledger = evidence.readResourceLedger(ledgerPath);
      expect(ledger.entries).toEqual([{ ok: true }]);
      expect(ledger.truncated).toBe(false);
      expect(ledger.parseErrors).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
