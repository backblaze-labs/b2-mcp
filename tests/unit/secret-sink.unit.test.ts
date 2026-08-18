import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSecretSinkRecord,
  DEFAULT_SECRET_SINK_PATH,
  durableSecretIdempotency,
  executeDurableSecretOperation,
  INLINE_SECRET_WARNING,
  resetSecretSinkWarningForTests,
  resolveSecretSinkConfig,
  secretSinkFileOpsForTests,
} from "../../src/utils/secret-sink";
import { logger } from "../../src/utils/logger";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "b2-mcp-secret-sink-"));
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("secret sink configuration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetSecretSinkWarningForTests();
  });

  it("defaults stdio to the local file sink and HTTP/serverless to off", () => {
    expect(resolveSecretSinkConfig({ transport: "stdio", env: {}, preflight: false })).toEqual({
      mode: "file",
      filePath: DEFAULT_SECRET_SINK_PATH,
    });
    expect(resolveSecretSinkConfig({ transport: "http", env: {}, preflight: false })).toEqual({
      mode: "off",
    });
  });

  it("requires HTTP file mode to opt into local files and an explicit path", () => {
    const path = join(tempDir(), "secrets.jsonl");
    expect(() =>
      resolveSecretSinkConfig({
        transport: "http",
        env: { B2_SECRET_SINK: "file", B2_SECRET_SINK_FILE: path },
        preflight: false,
      }),
    ).toThrow(/B2_ALLOW_LOCAL_FILES=true/);
    expect(() =>
      resolveSecretSinkConfig({
        transport: "http",
        env: { B2_SECRET_SINK: "file", B2_ALLOW_LOCAL_FILES: "true" },
        preflight: false,
      }),
    ).toThrow(/B2_SECRET_SINK_FILE/);
  });

  it("emits the inline warning once", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(
      resolveSecretSinkConfig({
        transport: "stdio",
        env: { B2_SECRET_SINK: "inline" },
        preflight: false,
      }),
    ).toEqual({ mode: "inline" });
    resolveSecretSinkConfig({
      transport: "http",
      env: { B2_SECRET_SINK: "inline", B2_ALLOW_INLINE_SECRETS: "true" },
      preflight: false,
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(String(writeSpy.mock.calls[0]?.[0])).toContain(INLINE_SECRET_WARNING);
  });

  it("requires a dedicated HTTP opt-in for inline secrets", () => {
    expect(() =>
      resolveSecretSinkConfig({
        transport: "http",
        env: { B2_SECRET_SINK: "inline" },
        preflight: false,
      }),
    ).toThrow(/B2_ALLOW_INLINE_SECRETS=true/);
  });

  it("falls back to off when the stdio default file cannot be opened", () => {
    const dir = tempDir();
    const target = join(dir, "target.jsonl");
    const link = join(dir, "secrets.jsonl");
    writeFileSync(target, "", { mode: 0o600 });
    symlinkSync(target, link);

    const resolved = resolveSecretSinkConfig({
      transport: "stdio",
      env: {},
      defaultFilePath: link,
    });

    expect(resolved.mode).toBe("off");
    expect(resolved).toHaveProperty("unavailableReason", expect.stringContaining(link));
    expect(JSON.stringify(resolved)).toContain("B2_SECRET_SINK=inline");
  });

  it("treats empty stdio mode as the default when the default file cannot open", () => {
    const dir = tempDir();
    const target = join(dir, "target.jsonl");
    const link = join(dir, "secrets.jsonl");
    writeFileSync(target, "", { mode: 0o600 });
    symlinkSync(target, link);

    const resolved = resolveSecretSinkConfig({
      transport: "stdio",
      env: { B2_SECRET_SINK: "   " },
      defaultFilePath: link,
    });

    expect(resolved.mode).toBe("off");
    expect(resolved).toHaveProperty("unavailableReason", expect.stringContaining(link));
  });
});

describe("secret sink file writer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the parent directory 0700, file 0600, and appends JSONL records", () => {
    const dir = tempDir();
    const file = join(dir, "nested", "secrets.jsonl");
    const pointer = appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
      keyName: "ci-uploader",
      applicationKeyId: "key-id",
      applicationKey: "B2_MCP_CANARY_SECRET_file_sink",
    });

    expect(pointer).toMatchObject({ type: "file", path: file });
    expect(mode(join(dir, "nested"))).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    const line = readFileSync(file, "utf8").trim();
    const record = JSON.parse(line);
    expect(record).toMatchObject({
      tool: "b2_create_key",
      recordId: pointer.recordId,
      result: {
        keyName: "ci-uploader",
        applicationKey: "B2_MCP_CANARY_SECRET_file_sink",
      },
    });
    expect(record.result).toMatchObject({
      keyName: "ci-uploader",
      applicationKey: "B2_MCP_CANARY_SECRET_file_sink",
    });
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("rejects symlink, hard-linked, and wrong-owner targets", () => {
    const dir = tempDir();
    const target = join(dir, "target.jsonl");
    const symlink = join(dir, "symlink.jsonl");
    const hardlink = join(dir, "hardlink.jsonl");
    writeFileSync(target, "", { mode: 0o600 });
    symlinkSync(target, symlink);
    linkSync(target, hardlink);

    expect(() =>
      appendSecretSinkRecord({ mode: "file", filePath: symlink }, "b2_create_key", {}),
    ).toThrow(/must not be a symlink/);
    expect(() =>
      appendSecretSinkRecord({ mode: "file", filePath: hardlink }, "b2_create_key", {}),
    ).toThrow(/must not be a hard link/);

    rmSync(hardlink);
    const actualUid = typeof process.getuid === "function" ? process.getuid() : 0;
    vi.spyOn(process, "getuid").mockReturnValue(actualUid + 1);
    expect(() =>
      appendSecretSinkRecord({ mode: "file", filePath: target }, "b2_create_key", {}),
    ).toThrow(/owned by the current user/);
  });

  it("tightens permissive existing files to owner-only permissions", () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    writeFileSync(file, "", { mode: 0o666 });
    chmodSync(file, 0o666);

    appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {});

    expect(existsSync(file)).toBe(true);
    expect(mode(file)).toBe(0o600);
  });

  it("rejects existing group/other-writable parents without chmodding them", () => {
    const dir = tempDir();
    const parent = join(dir, "open");
    mkdirSync(parent, { mode: 0o777 });
    chmodSync(parent, 0o777);
    const file = join(parent, "secrets.jsonl");

    expect(() =>
      appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {}),
    ).toThrow(/parent must not be readable or writable/);

    expect(mode(parent)).toBe(0o777);
  });

  it("keeps provider payload under a collision-resistant result envelope", () => {
    const dir = tempDir();
    const file = join(dir, "nested", "secrets.jsonl");
    const pointer = appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
      ts: "provider-ts",
      tool: "provider-tool",
      recordId: "provider-record",
      applicationKey: "B2_MCP_CANARY_SECRET_collision",
    });

    const record = JSON.parse(readFileSync(file, "utf8").trim());
    expect(record.tool).toBe("b2_create_key");
    expect(record.recordId).toBe(pointer.recordId);
    expect(record.result).toMatchObject({
      ts: "provider-ts",
      tool: "provider-tool",
      recordId: "provider-record",
      applicationKey: "B2_MCP_CANARY_SECRET_collision",
    });
  });

  it("calls fsync before returning a pointer", () => {
    const fsyncSpy = vi.spyOn(secretSinkFileOpsForTests, "fsyncSync");
    const dir = tempDir();
    const file = join(dir, "nested", "secrets.jsonl");

    const pointer = appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
      applicationKey: "B2_MCP_CANARY_SECRET_fsync",
    });

    expect(pointer.recordId).toEqual(expect.any(String));
    expect(fsyncSpy).toHaveBeenCalled();
  });

  it("rolls back a ledger line when fsync fails before returning a pointer", () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    writeFileSync(file, "", { mode: 0o600 });
    const fsync = secretSinkFileOpsForTests.fsyncSync;
    let calls = 0;
    vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
      calls++;
      if (calls === 3) throw new Error("simulated fsync failure");
      return fsync(fd);
    });

    expect(() =>
      appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
        applicationKey: "B2_MCP_CANARY_SECRET_failed_fsync",
      }),
    ).toThrow(/simulated fsync failure/);

    expect(readFileSync(file, "utf8")).toBe("");
  });

  it("holds an exclusive pending claim before provider creation", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const started = deferred<void>();
    const created = deferred<Record<string, unknown>>();
    const idempotency = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "claim-before-create",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: { keyName: "claim-before-create", capabilities: ["listBuckets"] },
    });
    let createCalls = 0;
    const options = {
      secretSink: { mode: "file" as const, filePath: file },
      toolName: "b2_create_key",
      idempotency,
      projectRedacted: (result: Record<string, unknown>, pointer: unknown) => ({
        ...result,
        applicationKey: "[redacted]",
        secretSink: pointer,
      }),
      projectInline: (result: Record<string, unknown>, warning: string) => ({
        ...result,
        warning,
      }),
    };

    const first = executeDurableSecretOperation({
      ...options,
      create: () => {
        createCalls++;
        started.resolve();
        return created.promise;
      },
    });
    await started.promise;

    await expect(
      executeDurableSecretOperation({
        ...options,
        create: async () => {
          createCalls++;
          return { applicationKey: "B2_MCP_CANARY_SECRET_duplicate" };
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_key_pending" });

    created.resolve({
      applicationKeyId: "key-id",
      applicationKey: "B2_MCP_CANARY_SECRET_claim",
    });
    const result = await first;

    expect(createCalls).toBe(1);
    expect(result.structuredContent).toMatchObject({
      applicationKey: "[redacted]",
      secretSink: { type: "file", path: file },
    });
  });

  it("rejects conflicting input on the same pending idempotency claim", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const started = deferred<void>();
    const created = deferred<Record<string, unknown>>();
    const base = {
      toolName: "b2_create_key",
      idempotencyKey: "same-key-different-input",
      callerFingerprint: "credential-fingerprint",
    };
    const firstIdempotency = durableSecretIdempotency({
      ...base,
      normalizedInput: { keyName: "first", capabilities: ["listBuckets"] },
    });
    const secondIdempotency = durableSecretIdempotency({
      ...base,
      normalizedInput: { keyName: "second", capabilities: ["listBuckets"] },
    });
    let createCalls = 0;
    const options = {
      secretSink: { mode: "file" as const, filePath: file },
      toolName: "b2_create_key",
      projectRedacted: (result: Record<string, unknown>, pointer: unknown) => ({
        ...result,
        applicationKey: "[redacted]",
        secretSink: pointer,
      }),
      projectInline: (result: Record<string, unknown>, warning: string) => ({
        ...result,
        warning,
      }),
    };

    const first = executeDurableSecretOperation({
      ...options,
      idempotency: firstIdempotency,
      create: () => {
        createCalls++;
        started.resolve();
        return created.promise;
      },
    });
    await started.promise;

    await expect(
      executeDurableSecretOperation({
        ...options,
        idempotency: secondIdempotency,
        create: async () => {
          createCalls++;
          return { applicationKey: "B2_MCP_CANARY_SECRET_duplicate" };
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_key_conflict" });

    created.resolve({
      applicationKeyId: "key-id",
      applicationKey: "B2_MCP_CANARY_SECRET_claim",
    });
    await first;

    expect(createCalls).toBe(1);
    expect(readdirSync(dir).filter((name) => name.endsWith(".pending"))).toHaveLength(0);
  });

  it("leaves an ambiguous provider outcome pending instead of retrying creation", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "provider-timeout",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: { keyName: "provider-timeout", capabilities: ["listBuckets"] },
    });
    let createCalls = 0;
    const options = {
      secretSink: { mode: "file" as const, filePath: file },
      toolName: "b2_create_key",
      idempotency,
      projectRedacted: (result: Record<string, unknown>, pointer: unknown) => ({
        ...result,
        applicationKey: "[redacted]",
        secretSink: pointer,
      }),
      projectInline: (result: Record<string, unknown>, warning: string) => ({
        ...result,
        warning,
      }),
    };

    await expect(
      executeDurableSecretOperation({
        ...options,
        create: async () => {
          createCalls++;
          throw new Error("connection reset after provider call");
        },
      }),
    ).rejects.toThrow(/connection reset/);

    await expect(
      executeDurableSecretOperation({
        ...options,
        create: async () => {
          createCalls++;
          return { applicationKey: "B2_MCP_CANARY_SECRET_duplicate" };
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_key_pending" });

    expect(createCalls).toBe(1);
    expect(readdirSync(dir).some((name) => name.endsWith(".pending"))).toBe(true);
  });

  it("does not compensate a committed credential when claim cleanup fails", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const recoverSpy = vi.fn();
    const unlink = secretSinkFileOpsForTests.unlinkSync;
    let unlinkCalls = 0;
    vi.spyOn(secretSinkFileOpsForTests, "unlinkSync").mockImplementation((path) => {
      unlinkCalls++;
      if (unlinkCalls === 2) throw new Error("simulated claim cleanup failure");
      return unlink(path);
    });
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "claim-cleanup-failure",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: { keyName: "claim-cleanup-failure", capabilities: ["listBuckets"] },
    });

    const result = await executeDurableSecretOperation({
      secretSink: { mode: "file", filePath: file },
      toolName: "b2_create_key",
      idempotency,
      create: async () => ({
        applicationKeyId: "key-id",
        applicationKey: "B2_MCP_CANARY_SECRET_claim_cleanup",
      }),
      projectRedacted: (created: Record<string, unknown>, pointer) => ({
        ...created,
        applicationKey: "[redacted]",
        secretSink: pointer,
      }),
      projectInline: (created: Record<string, unknown>, warning: string) => ({
        ...created,
        warning,
      }),
      recoverAfterSinkFailure: recoverSpy,
    });

    expect(result.structuredContent).toMatchObject({
      applicationKeyId: "key-id",
      applicationKey: "[redacted]",
      secretSink: { type: "file", path: file },
    });
    expect(recoverSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(warnSpy.mock.calls)).toContain("secret_sink.claim_cleanup_failed");
  });
});
