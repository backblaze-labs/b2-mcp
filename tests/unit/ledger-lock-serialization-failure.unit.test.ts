import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSecretSinkRecord,
  durableSecretIdempotency,
  executeDurableSecretOperation,
} from "../../src/utils/secret-sink";
import { logger } from "../../src/utils/logger";

it.each([
  { label: "undefined", cause: undefined },
  { label: "null", cause: null },
  { label: "Error", cause: new Error("serialization refused") },
])("does not return a ledger pointer when serialization throws $label", ({ cause }) => {
  const dir = mkdtempSync(join(tmpdir(), "b2-ledger-serialize-"));
  const file = join(dir, "secrets.jsonl");
  let caught = false;
  let caughtValue: unknown;
  let pointer: unknown;
  try {
    try {
      pointer = appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
        applicationKeyId: "synthetic-key",
        toJSON() {
          throw cause;
        },
      });
    } catch (err) {
      caught = true;
      caughtValue = err;
    }
    expect(caught).toBe(true);
    expect(caughtValue).toBe(cause);
    expect(pointer).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("");
    expect(existsSync(`${file}.append.lock`)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("recovers the created provider result when serialization throws undefined", async () => {
  const dir = mkdtempSync(join(tmpdir(), "b2-ledger-serialize-operation-"));
  const file = join(dir, "secrets.jsonl");
  const fatal = vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
  const idempotency = durableSecretIdempotency({
    toolName: "b2_create_key",
    callerFingerprint: "serialization-owner",
    idempotencyKey: "serialization-failure",
    normalizedInput: { label: "serialization-failure" },
  });
  const created = {
    applicationKeyId: "synthetic-key",
    applicationKey: "synthetic-serialization-secret",
    toJSON() {
      throw undefined;
    },
  };
  const recover = vi.fn(() => ({ status: "deleted" }));
  try {
    await expect(
      executeDurableSecretOperation({
        secretSink: { mode: "file", filePath: file },
        toolName: "b2_create_key",
        idempotency,
        create: async () => created,
        projectRedacted: (result, pointer) => ({
          applicationKeyId: result.applicationKeyId,
          secretSink: pointer,
        }),
        projectInline: (result) => result,
        recoverAfterSinkFailure: recover,
      }),
    ).rejects.toMatchObject({ code: "secret_sink_write_failed" });
    expect(recover).toHaveBeenCalledWith(created, undefined);
    expect(readFileSync(file, "utf8")).toBe("");
    expect(existsSync(`${file}.${idempotency.claimFingerprint}.pending`)).toBe(false);
    expect(existsSync(`${file}.${idempotency.claimFingerprint}.committed.json`)).toBe(false);
    expect(existsSync(`${file}.append.lock`)).toBe(false);
  } finally {
    fatal.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
