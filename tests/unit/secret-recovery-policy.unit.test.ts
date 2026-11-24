import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { logger } from "../../src/utils/logger";
import {
  type DurableSecretOperationOptions,
  durableSecretIdempotency,
  durableSecretPostCreateFailure,
  executeDurableSecretOperation,
  secretSinkFileOpsForTests,
} from "../../src/utils/secret-sink";

type Created = Record<string, unknown>;
const dirs: string[] = [];
const created = { applicationKeyId: "created-key-id", applicationKey: "minted-value-123456789" };

function fixture(key: string, overrides: Partial<DurableSecretOperationOptions<Created>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "b2-recovery-policy-"));
  dirs.push(dir);
  const file = join(dir, "credentials.jsonl");
  const create = vi.fn(async (): Promise<Created> => ({ ...created }));
  const options: DurableSecretOperationOptions<Created> = {
    secretSink: { mode: "file", filePath: file },
    toolName: "b2_create_key",
    idempotency: durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: key,
      callerFingerprint: "recovery-policy-caller",
      normalizedInput: { keyName: key, capabilities: ["listBuckets"] },
    }),
    create,
    projectRedacted: (_value, pointer) => ({
      applicationKeyId: "created-key-id",
      secretSink: pointer,
    }),
    projectInline: (value, warning) => ({ ...value, warning }),
    ...overrides,
  };
  return { dir, file, create, options };
}

function pending(dir: string) {
  return readdirSync(dir).filter((name) => name.endsWith(".pending"));
}

function operatorFailure(value: unknown, code: string) {
  expect(value).toMatchObject({ status: 500, code, message: expect.any(String) });
  expect((value as { message: string }).message.trim().length).toBeGreaterThan(0);
  expect(JSON.stringify(value)).not.toContain(created.applicationKey);
}

beforeEach(() => {
  vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external network access"));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each([400, 499])("permits a fresh create after definitive HTTP %s rejection", async (status) => {
  const f = fixture(`rejected-${status}`);
  const failure = Object.assign(new Error("provider rejected the request"), { status });
  f.create.mockRejectedValueOnce(failure);
  await expect(executeDurableSecretOperation(f.options)).rejects.toBe(failure);
  expect(pending(f.dir)).toEqual([]);
  expect(readFileSync(f.file, "utf8")).toBe("");

  await expect(executeDurableSecretOperation(f.options)).resolves.toMatchObject({
    structuredContent: { applicationKeyId: "created-key-id" },
  });
  expect(f.create).toHaveBeenCalledTimes(2);
  expect(pending(f.dir)).toEqual([]);
});

it.each([399, 408, 500, 503, "403"])(
  "retains ownership after ambiguous or untrusted provider status %s",
  async (status) => {
    const f = fixture(`uncertain-${status}`);
    const failure = Object.assign(new Error("provider result could not be confirmed"), { status });
    f.create.mockRejectedValue(failure);
    await expect(executeDurableSecretOperation(f.options)).rejects.toBe(failure);
    expect(pending(f.dir)).toHaveLength(1);
    await expect(executeDurableSecretOperation(f.options)).rejects.toMatchObject({
      code: "idempotency_key_pending",
    });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.file, "utf8")).toBe("");
  },
);

it.each([null, "provider disconnected", 0, false])(
  "preserves non-object rejection %s and blocks a second provider create",
  async (failure) => {
    const f = fixture(`non-object-${String(failure)}`);
    f.create.mockRejectedValue(failure);
    await expect(executeDurableSecretOperation(f.options)).rejects.toBe(failure);
    await expect(executeDurableSecretOperation(f.options)).rejects.toMatchObject({
      code: "idempotency_key_pending",
    });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(pending(f.dir)).toHaveLength(1);
  },
);

it("reports unavailable diagnostics without replacing the post-create outcome", async () => {
  const cause = new Error("provider response validation failed");
  const recovery = vi.fn(() => ({ status: "recovery_incomplete" }));
  const f = fixture("diagnostics-failed", {
    create: async () => {
      throw durableSecretPostCreateFailure(created, cause);
    },
    diagnostics: () => {
      throw new Error(`diagnostic callback failed: ${created.applicationKey}`);
    },
    recoverAfterSinkFailure: recovery,
  });
  const failure = await executeDurableSecretOperation(f.options).catch((error: unknown) => error);
  operatorFailure(failure, "secret_sink_projection_failed");
  expect(recovery).toHaveBeenCalledWith(created, cause);
  expect(pending(f.dir)).toHaveLength(1);
  expect(logger.fatal).toHaveBeenCalledWith(
    expect.objectContaining({
      tool: "b2_create_key",
      secretSink: { type: "file", path: f.file },
      minted: { diagnostics_unavailable: true },
      recovery: { status: "recovery_incomplete" },
    }),
    expect.stringMatching(/\S/),
  );
  expect(JSON.stringify(vi.mocked(logger.fatal).mock.calls)).not.toContain(created.applicationKey);
});

it.each([
  { label: "absent", recovery: undefined, expected: "not_configured" },
  {
    label: "throws",
    recovery: () => {
      throw new Error("provider cleanup failed");
    },
    expected: "failed",
  },
])("keeps an unresolved claim when recovery $label", async ({ label, recovery, expected }) => {
  const f = fixture(`recovery-${label}`, {
    projectRedacted: () => {
      throw new Error("redacted response could not be built");
    },
    recoverAfterSinkFailure: recovery,
  });
  const failure = await executeDurableSecretOperation(f.options).catch((error: unknown) => error);
  operatorFailure(failure, "secret_sink_projection_failed");
  expect(pending(f.dir)).toHaveLength(1);
  expect(logger.fatal).toHaveBeenCalledWith(
    expect.objectContaining({
      tool: "b2_create_key",
      secretSink: { type: "file", path: f.file },
      recovery: expect.objectContaining({ status: expected }),
    }),
    expect.stringMatching(/\S/),
  );
});

it("retains nested exact-secret redaction and recovery diagnostics for a circular provider result", async () => {
  const secret = "nested-provider-value-987654321";
  const value: Created = {
    result: { applicationKey: secret },
    applicationKeyId: "public-created-id",
  };
  value.self = value;
  const getter = vi.fn(() => "not a data descriptor");
  Object.defineProperty(value, "lazyMetadata", { enumerable: true, get: getter });
  const f = fixture("cyclic-result", {
    create: async () => value,
    projectRedacted: () => {
      throw new Error(`projection failed for ${secret}`);
    },
    diagnostics: () => ({ resourceType: "application-key" }),
    recoverAfterSinkFailure: () => ({ status: "recovery_incomplete", note: `review ${secret}` }),
  });
  const failure = await executeDurableSecretOperation(f.options).catch((error: unknown) => error);
  operatorFailure(failure, "secret_sink_projection_failed");
  const fields = vi.mocked(logger.fatal).mock.calls[0][0] as {
    err: Error;
    minted: { resourceType: string };
    recovery: { status: string; note: string };
  };
  expect(fields.minted.resourceType).toBe("application-key");
  expect(fields.recovery.status).toBe("recovery_incomplete");
  expect(fields.err.message).toContain("[redacted]");
  expect(fields.recovery.note).toBe("review [redacted]");
  expect(getter).not.toHaveBeenCalled();
  expect(pending(f.dir)).toHaveLength(1);
});

it("can report post-create inline recovery without attempting file-claim cleanup", async () => {
  const recovery = vi.fn(() => ({ status: "deleted" }));
  const f = fixture("inline-post-create", {
    secretSink: { mode: "inline" },
    create: async () => {
      throw durableSecretPostCreateFailure(created, new Error("normalization failed"));
    },
    recoverAfterSinkFailure: recovery,
  });
  const failure = await executeDurableSecretOperation(f.options).catch((error: unknown) => error);
  operatorFailure(failure, "secret_sink_projection_failed");
  expect(recovery).toHaveBeenCalledWith(created, expect.any(Error));
  expect(existsSync(f.file)).toBe(false);
  expect(logger.fatal).toHaveBeenCalledWith(
    expect.objectContaining({ secretSink: { type: "inline" }, recovery: { status: "deleted" } }),
    expect.stringMatching(/\S/),
  );
});

it.each(["rejection", "compensation", "committed"] as const)(
  "retains operator context if pending-claim cleanup fails after %s",
  async (phase) => {
    const f = fixture(`cleanup-${phase}`);
    const unlink = secretSinkFileOpsForTests.unlinkSync;
    vi.spyOn(secretSinkFileOpsForTests, "unlinkSync").mockImplementation((path) => {
      if (String(path).endsWith(".pending")) throw new Error("pending claim cleanup unavailable");
      return unlink(path);
    });
    const recovery = vi.fn(() => ({ status: "deleted" }));
    f.options.recoverAfterSinkFailure = recovery;
    let failure: unknown;
    if (phase === "rejection") {
      const rejected = Object.assign(new Error("invalid provider request"), { status: 403 });
      f.create.mockRejectedValue(rejected);
      await expect(executeDurableSecretOperation(f.options)).rejects.toBe(rejected);
    } else if (phase === "compensation") {
      f.options.projectRedacted = () => {
        throw new Error("response projection unavailable");
      };
      failure = await executeDurableSecretOperation(f.options).catch((error: unknown) => error);
      operatorFailure(failure, "secret_sink_projection_failed");
      expect(recovery).toHaveBeenCalledTimes(1);
    } else {
      const first = await executeDurableSecretOperation(f.options);
      const second = await executeDurableSecretOperation(f.options);
      expect(second.structuredContent).toEqual(first.structuredContent);
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(recovery).not.toHaveBeenCalled();
    }
    expect(pending(f.dir)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        tool: "b2_create_key",
        secretSink: { type: "file", path: f.file },
        lockPath: expect.stringContaining(f.file),
      }),
      expect.stringMatching(/\S/),
    );
  },
);

it("leaves committed material available and identifies its ledger when replay metadata fails", async () => {
  const f = fixture("committed-index-failure");
  const rename = secretSinkFileOpsForTests.renameSync;
  vi.spyOn(secretSinkFileOpsForTests, "renameSync").mockImplementation((from, to) => {
    if (String(to).endsWith(".committed.json")) throw new Error("committed marker unavailable");
    return rename(from, to);
  });
  const recovery = vi.fn();
  f.options.recoverAfterSinkFailure = recovery;
  const failure = await executeDurableSecretOperation(f.options).catch((error: unknown) => error);
  operatorFailure(failure, "secret_sink_replay_unavailable");
  expect(readFileSync(f.file, "utf8")).toContain(created.applicationKey);
  expect(pending(f.dir)).toHaveLength(1);
  await expect(executeDurableSecretOperation(f.options)).rejects.toMatchObject({
    code: "idempotency_key_pending",
  });
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(recovery).not.toHaveBeenCalled();
  const calls = vi.mocked(logger.fatal).mock.calls;
  expect(calls).toHaveLength(2);
  for (const [fields, event] of calls) {
    expect(fields).toMatchObject({
      tool: "b2_create_key",
      secretSink: { type: "file", path: f.file },
      lockPath: expect.stringContaining(f.file),
    });
    expect(event?.trim().length ?? 0).toBeGreaterThan(0);
  }
});

it("preserves an inline provider rejection without inventing a file claim", async () => {
  const f = fixture("inline-rejection", { secretSink: { mode: "inline" } });
  const failure = Object.assign(new Error("provider rejected inline request"), { status: 403 });
  f.create.mockRejectedValue(failure);
  await expect(executeDurableSecretOperation(f.options)).rejects.toBe(failure);
  expect(existsSync(f.file)).toBe(false);
  expect(logger.warn).not.toHaveBeenCalled();
});

it.each([
  {
    label: "confirmed rollback",
    ambiguous: false,
    code: "secret_sink_write_failed",
    recoveryStatus: "not_configured",
  },
  {
    label: "unconfirmed rollback",
    ambiguous: true,
    code: "secret_sink_commit_ambiguous",
    recoveryStatus: "pending_reconciliation",
  },
])(
  "preserves reconciliation context after $label",
  async ({ label, ambiguous, code, recoveryStatus }) => {
    const f = fixture(`write-${label}`);
    const recover = vi.fn();
    f.options.recoverAfterSinkFailure = recover;
    const fsync = secretSinkFileOpsForTests.fsyncSync;
    let writeFailed = false;
    vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
      if (
        !writeFailed &&
        existsSync(f.file) &&
        readFileSync(f.file, "utf8").includes(created.applicationKey)
      ) {
        writeFailed = true;
        throw new Error(`ledger flush failed for ${created.applicationKey}`);
      }
      return fsync(fd);
    });
    if (ambiguous) {
      vi.spyOn(secretSinkFileOpsForTests, "ftruncateSync").mockImplementation(() => {
        throw new Error(`rollback could not be confirmed for ${created.applicationKey}`);
      });
    }
    const failure = await executeDurableSecretOperation(f.options).catch((error: unknown) => error);
    operatorFailure(failure, code);
    expect(writeFailed).toBe(true);
    expect(pending(f.dir)).toHaveLength(1);
    await expect(executeDurableSecretOperation(f.options)).rejects.toMatchObject({
      code: "idempotency_key_pending",
    });
    expect(f.create).toHaveBeenCalledTimes(1);
    if (ambiguous) expect(recover).not.toHaveBeenCalled();
    else expect(recover).toHaveBeenCalledTimes(1);
    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "b2_create_key",
        secretSink: { type: "file", path: f.file },
        recovery: { status: recoveryStatus },
      }),
      expect.stringMatching(/\S/),
    );
    expect(inspect(vi.mocked(logger.fatal).mock.calls, { depth: 20 })).not.toContain(
      created.applicationKey,
    );
  },
);
