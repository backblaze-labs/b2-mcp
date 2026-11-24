import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { logger } from "../../src/utils/logger";
import { LOG_SANITIZER_FAILURE } from "../../src/utils/secret-sanitizer";
import {
  durableSecretIdempotency,
  executeDurableSecretOperation,
} from "../../src/utils/secret-sink";

const secret = "retained-provider-value-9081726354";
type Result = { applicationKey?: string; nested?: { applicationKey: string } };
const dirs: string[] = [];

function operation(result: Result, label: string) {
  const dir = mkdtempSync(join(tmpdir(), "b2-recovery-inspection-"));
  dirs.push(dir);
  const file = join(dir, "credentials.jsonl");
  const create = vi.fn(async () => result);
  const key = (value: Result) => value.applicationKey ?? value.nested?.applicationKey;
  const recover = vi.fn((value: Result, _err: unknown) => {
    throw new Error(`cleanup failed for ${key(value)}`);
  });
  return {
    dir,
    file,
    create,
    recover,
    options: {
      secretSink: { mode: "file" as const, filePath: file },
      toolName: "b2_create_key",
      idempotency: durableSecretIdempotency({
        toolName: "b2_create_key",
        idempotencyKey: label,
        callerFingerprint: "inspection-caller",
        normalizedInput: { keyName: label, capabilities: ["listBuckets"] },
      }),
      create,
      projectRedacted: (value: Result) => {
        throw new Error(`projection failed for ${key(value)}`);
      },
      projectInline: () => ({}),
      diagnostics: () => ({ resourceType: "application-key" }),
      recoverAfterSinkFailure: recover,
    },
  };
}

beforeEach(() => {
  vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external network access"));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each(["root", "nested"] as const)(
  "drops unsafe failure details if the %s provider result cannot be inspected",
  async (where) => {
    // A legal metadata wrapper still permits ordinary field access but refuses
    // enumeration. The public generic operation already accepts non-JSON graphs.
    const wrapped = new Proxy(
      { applicationKey: secret },
      {
        ownKeys() {
          throw new Error("provider metadata cannot be enumerated");
        },
      },
    );
    const value: Result = where === "root" ? wrapped : { nested: wrapped };
    const f = operation(value, `uninspectable-${where}`);

    await expect(executeDurableSecretOperation(f.options)).rejects.toMatchObject({
      status: 500,
      code: "secret_sink_projection_failed",
    });
    expect(f.recover.mock.calls[0][0]).toBe(value);
    expect(f.recover.mock.calls[0][1]).toBeInstanceOf(Error);
    const fields = vi.mocked(logger.fatal).mock.calls[0][0];
    expect(inspect(fields, { depth: 20 })).not.toContain(secret);
    expect(fields).toEqual({
      logSanitizer: LOG_SANITIZER_FAILURE,
      tool: "b2_create_key",
      secretSink: { type: "file", path: f.file },
    });
    expect(readFileSync(f.file, "utf8")).toBe("");
    expect(readdirSync(f.dir).filter((name) => name.endsWith(".pending"))).toHaveLength(1);
    await expect(executeDurableSecretOperation(f.options)).rejects.toMatchObject({
      code: "idempotency_key_pending",
    });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.recover).toHaveBeenCalledTimes(1);
  },
);

it("retains useful sanitized diagnostics for an inspectable nested result", async () => {
  const f = operation({ nested: { applicationKey: secret } }, "inspectable-control");
  await expect(executeDurableSecretOperation(f.options)).rejects.toMatchObject({
    status: 500,
    code: "secret_sink_projection_failed",
  });
  const fields = vi.mocked(logger.fatal).mock.calls[0][0] as {
    err: Error;
    minted: { resourceType: string };
    recovery: { status: string; error: string };
  };
  expect(inspect(fields, { depth: 20 })).not.toContain(secret);
  expect(fields.err.message).toBe("projection failed for [redacted]");
  expect(fields.minted.resourceType).toBe("application-key");
  expect(fields.recovery).toEqual({ status: "failed", error: "cleanup failed for [redacted]" });
  expect(fields).not.toHaveProperty("logSanitizer");
  expect(readdirSync(f.dir).filter((name) => name.endsWith(".pending"))).toHaveLength(1);
});
