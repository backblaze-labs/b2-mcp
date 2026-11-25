import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSecretSinkRecord,
  durableSecretIdempotency,
  executeDurableSecretOperation,
} from "../../src/utils/secret-sink";

const WINDOW_BYTES = 1024 * 1024;
it.each([
  { label: "one byte inside window", recordBytes: WINDOW_BYTES - 1, prefix: "older" },
  { label: "exact window after older records", recordBytes: WINDOW_BYTES, prefix: "older" },
  { label: "exact window at offset zero", recordBytes: WINDOW_BYTES, prefix: "none" },
  { label: "window plus one byte of file", recordBytes: WINDOW_BYTES, prefix: "blank" },
  { label: "window begins inside a multibyte older record", recordBytes: 1024, prefix: "unicode" },
])("replays a complete legacy record: $label", async ({ recordBytes, prefix }) => {
  const dir = mkdtempSync(join(tmpdir(), "b2-ledger-boundary-"));
  const file = join(dir, "secrets.jsonl");
  const sink = { mode: "file" as const, filePath: file };
  const idempotency = durableSecretIdempotency({
    toolName: "b2_create_key",
    callerFingerprint: "boundary-owner",
    idempotencyKey: "boundary-key",
    normalizedInput: { label: "boundary-key" },
  });
  const payload = {
    applicationKeyId: "retained-key",
    applicationKey: "synthetic-boundary-secret",
    padding: "",
  };
  try {
    appendSecretSinkRecord(sink, "b2_create_key", payload, idempotency);
    const overhead = Buffer.byteLength(readFileSync(file));
    writeFileSync(file, "", { mode: 0o600 });
    if (prefix === "older") appendSecretSinkRecord(sink, "older_tool", { label: "earlier record" });
    if (prefix === "blank") writeFileSync(file, "\n", { mode: 0o600 });
    if (prefix === "unicode")
      appendSecretSinkRecord(sink, "older_tool", { label: "é".repeat(WINDOW_BYTES) });
    let prefixBytes = Buffer.byteLength(readFileSync(file));
    payload.padding = "x".repeat(recordBytes - overhead);
    let pointer = appendSecretSinkRecord(sink, "b2_create_key", payload, idempotency);
    if (prefix === "unicode") {
      const bytes = readFileSync(file);
      if ((bytes[bytes.length - WINDOW_BYTES] & 0xc0) !== 0x80) {
        writeFileSync(file, "", { mode: 0o600 });
        appendSecretSinkRecord(sink, "older_tool", { label: "é".repeat(WINDOW_BYTES) + "x" });
        prefixBytes = Buffer.byteLength(readFileSync(file));
        pointer = appendSecretSinkRecord(sink, "b2_create_key", payload, idempotency);
      }
      const aligned = readFileSync(file);
      expect(aligned[aligned.length - WINDOW_BYTES] & 0xc0).toBe(0x80);
    }
    expect(Buffer.byteLength(readFileSync(file)) - prefixBytes).toBe(recordBytes);
    const create = vi.fn(async () => ({
      applicationKeyId: "duplicate-key",
      applicationKey: "synthetic-duplicate-secret",
      padding: "",
    }));
    const result = await executeDurableSecretOperation({
      secretSink: sink,
      toolName: "b2_create_key",
      idempotency,
      create,
      projectRedacted: (created, replayPointer) => ({
        applicationKeyId: created.applicationKeyId,
        applicationKey: "[redacted]",
        secretSink: replayPointer,
      }),
      projectInline: (created) => created,
    });
    expect(create).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      applicationKeyId: "retained-key",
      secretSink: pointer,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
