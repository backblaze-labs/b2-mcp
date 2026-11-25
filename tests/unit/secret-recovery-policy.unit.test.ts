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

it("omits callback diagnostics without replacing the post-create outcome", async () => {
  const cause = new Error("provider response validation failed");
  const recovery = vi.fn(() => ({ status: "recovery_incomplete" }));
  const diagnostics = vi.fn(() => {
    throw new Error(`diagnostic callback failed: ${created.applicationKey}`);
  });
  const f = fixture("diagnostics-failed", {
    create: async () => {
      throw durableSecretPostCreateFailure(created, cause);
    },
    diagnostics,
    recoverAfterSinkFailure: recovery,
  });
  const failure = await executeDurableSecretOperation(f.options).catch((error: unknown) => error);
  operatorFailure(failure, "secret_sink_projection_failed");
  expect(recovery).toHaveBeenCalledWith(created, cause);
  expect(diagnostics).not.toHaveBeenCalled();
  expect(pending(f.dir)).toHaveLength(1);
  expect(logger.fatal).toHaveBeenCalledWith(
    expect.objectContaining({
      tool: "b2_create_key",
      secretSink: { type: "file", path: f.file },
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

it("fails closed without invoking an unrelated accessor on a circular provider result", async () => {
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
  expect(vi.mocked(logger.fatal).mock.calls[0]?.[0]).toMatchObject({
    recovery: { status: "recovery_incomplete" },
  });
  expect(JSON.stringify(vi.mocked(logger.fatal).mock.calls)).not.toContain(secret);
  expect(getter).not.toHaveBeenCalled();
  expect(pending(f.dir)).toHaveLength(1);
});

it("fails closed when a proxy conceals a nested durable secret", async () => {
  const secret = "proxy-hidden-provider-secret-987654321";
  const target: Created = { applicationKeyId: "proxy-hidden-key-id" };
  const concealed = new Proxy(target, {
    ownKeys: () => ["applicationKeyId"],
    getOwnPropertyDescriptor: (object, key) => Object.getOwnPropertyDescriptor(object, key),
    get: (object, key, receiver) => {
      if (key === "metadata") return { applicationKey: secret };
      return Reflect.get(object, key, receiver);
    },
  });
  const f = fixture("proxy-hidden-secret", {
    create: async () => concealed,
    projectRedacted: () => {
      throw new Error("redacted response could not be built");
    },
    recoverAfterSinkFailure: (value) => {
      const metadata = value.metadata as { applicationKey: string };
      throw new Error(`cleanup failed for ${metadata.applicationKey}`);
    },
  });

  const failure = await executeDurableSecretOperation(f.options).catch((error: unknown) => error);

  operatorFailure(failure, "secret_sink_projection_failed");
  expect(JSON.stringify(vi.mocked(logger.fatal).mock.calls)).not.toContain(secret);
  expect(vi.mocked(logger.fatal).mock.calls[0]?.[0]).toMatchObject({
    recovery: { status: "failed" },
  });
  expect(pending(f.dir)).toHaveLength(1);
});

it("does not invoke or log a recovery status accessor", async () => {
  const secret = "recovery-status-accessor-secret-987654321";
  const getter = vi.fn(() => secret);
  const recovery = {};
  Object.defineProperty(recovery, "status", { enumerable: true, get: getter });
  const f = fixture("recovery-status-accessor", {
    projectRedacted: () => {
      throw new Error("redacted response could not be built");
    },
    recoverAfterSinkFailure: () => recovery,
  });

  const failure = await executeDurableSecretOperation(f.options).catch((error: unknown) => error);

  operatorFailure(failure, "secret_sink_projection_failed");
  expect(getter).not.toHaveBeenCalled();
  expect(vi.mocked(logger.fatal).mock.calls[0]?.[0]).toEqual({
    tool: "b2_create_key",
    secretSink: { type: "file", path: f.file },
  });
  expect(JSON.stringify(vi.mocked(logger.fatal).mock.calls)).not.toContain(secret);
  expect(pending(f.dir)).toHaveLength(1);
});

it("normalizes a stateful recovery status once before logging and claim cleanup", async () => {
  let descriptorReads = 0;
  const recovery = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: (_target, key) => {
        if (key !== "status") return undefined;
        descriptorReads += 1;
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: descriptorReads % 2 === 1 ? "failed" : "deleted",
        };
      },
    },
  );
  const f = fixture("stateful-recovery-status", {
    projectRedacted: () => {
      throw new Error("redacted response could not be built");
    },
    recoverAfterSinkFailure: () => recovery,
  });

  const first = await executeDurableSecretOperation(f.options).catch((error: unknown) => error);
  const second = await executeDurableSecretOperation(f.options).catch((error: unknown) => error);

  operatorFailure(first, "secret_sink_projection_failed");
  expect(second).toMatchObject({
    status: 409,
    code: "idempotency_key_pending",
    message: expect.any(String),
  });
  expect(descriptorReads).toBe(1);
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(vi.mocked(logger.fatal).mock.calls[0]?.[0]).toMatchObject({
    recovery: { status: "failed" },
  });
  expect(pending(f.dir)).toHaveLength(1);
});

it("fails closed when a non-secret accessor reveals a nested durable secret", async () => {
  const secret = "accessor-nested-provider-secret-987654321";
  let getterReads = 0;
  const createdWithAccessor: Created = { applicationKeyId: "accessor-metadata-key-id" };
  Object.defineProperty(createdWithAccessor, "metadata", {
    enumerable: true,
    get: () => {
      getterReads += 1;
      return { applicationKey: secret };
    },
  });
  const f = fixture("accessor-nested-secret", {
    create: async () => createdWithAccessor,
    projectRedacted: () => {
      throw new Error("redacted response could not be built");
    },
    recoverAfterSinkFailure: (value) => {
      const metadata = value.metadata as { applicationKey: string };
      throw new Error(`cleanup failed for ${metadata.applicationKey}`);
    },
  });
  const failure = await executeDurableSecretOperation(f.options).catch((error: unknown) => error);
  operatorFailure(failure, "secret_sink_projection_failed");
  expect(getterReads).toBe(1);
  expect(JSON.stringify(vi.mocked(logger.fatal).mock.calls)).not.toContain(secret);
  expect(vi.mocked(logger.fatal).mock.calls[0]?.[0]).toMatchObject({
    recovery: { status: "failed" },
  });
  expect(pending(f.dir)).toHaveLength(1);
});

it.each([
  {
    label: "an own getter",
    result(secret: string): Created {
      const value: Created = { applicationKeyId: "own-getter-key-id" };
      Object.defineProperty(value, "applicationKey", {
        enumerable: true,
        get: () => secret,
      });
      return value;
    },
  },
  {
    label: "a prototype getter",
    result(secret: string): Created {
      const prototype = Object.create(null) as Created;
      Object.defineProperty(prototype, "applicationKey", {
        enumerable: true,
        get: () => secret,
      });
      return Object.assign(Object.create(prototype) as Created, {
        applicationKeyId: "prototype-getter-key-id",
      });
    },
  },
])("redacts a durable secret exposed through $label", async ({ label, result }) => {
  const secret = `provider-${label.replace(/ /g, "-")}-secret-987654321`;
  const createdWithAccessor = result(secret);
  const f = fixture(`secret-accessor-${label}`, {
    create: async () => createdWithAccessor,
    projectRedacted: () => {
      throw new Error("redacted response could not be built");
    },
    recoverAfterSinkFailure: (value) => {
      throw new Error(`cleanup failed for ${String(value.applicationKey)}`);
    },
  });

  const failure = await executeDurableSecretOperation(f.options).catch((error: unknown) => error);

  operatorFailure(failure, "secret_sink_projection_failed");
  expect(JSON.stringify(vi.mocked(logger.fatal).mock.calls)).not.toContain(secret);
  expect(pending(f.dir)).toHaveLength(1);
});

it("redacts a nested durable secret inherited through a data property", async () => {
  const secret = "inherited-nested-provider-secret-987654321";
  const prototype = Object.create(null) as Created;
  Object.defineProperty(prototype, "metadata", {
    enumerable: true,
    value: { applicationKey: secret },
  });
  const createdWithInheritedMetadata = Object.assign(Object.create(prototype) as Created, {
    applicationKeyId: "inherited-metadata-key-id",
  });
  const f = fixture("inherited-nested-secret", {
    create: async () => createdWithInheritedMetadata,
    projectRedacted: () => {
      throw new Error("redacted response could not be built");
    },
    recoverAfterSinkFailure: (value) => {
      const metadata = value.metadata as { applicationKey: string };
      throw new Error(`cleanup failed for ${metadata.applicationKey}`);
    },
  });

  const failure = await executeDurableSecretOperation(f.options).catch((error: unknown) => error);

  operatorFailure(failure, "secret_sink_projection_failed");
  expect(JSON.stringify(vi.mocked(logger.fatal).mock.calls)).not.toContain(secret);
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
  expect(calls[0]?.[0]).toEqual({
    tool: "b2_create_key",
    secretSink: { type: "file", path: f.file },
    recovery: { status: "pending_reconciliation" },
  });
  expect(calls[1]?.[0]).toMatchObject({
    tool: "b2_create_key",
    secretSink: { type: "file", path: f.file },
    lockPath: expect.stringContaining(f.file),
  });
  for (const [, event] of calls) expect(event?.trim().length ?? 0).toBeGreaterThan(0);
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
