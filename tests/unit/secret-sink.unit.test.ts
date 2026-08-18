import {
  appendFileSync,
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
  utimesSync,
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

  it("rejects permissive existing files without chmodding them", () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    writeFileSync(file, "", { mode: 0o666 });
    chmodSync(file, 0o666);

    expect(() =>
      appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {}),
    ).toThrow(/must not be readable or writable/);

    expect(existsSync(file)).toBe(true);
    expect(mode(file)).toBe(0o666);
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

  it("calls fsync on the parent directory before every append commit", () => {
    const fsyncSpy = vi.spyOn(secretSinkFileOpsForTests, "fsyncSync");
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    writeFileSync(file, "", { mode: 0o600 });

    appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
      applicationKey: "B2_MCP_CANARY_SECRET_parent_fsync",
    });

    expect(fsyncSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("rolls back a ledger line when fsync fails before returning a pointer", () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    writeFileSync(file, "", { mode: 0o600 });
    const fsync = secretSinkFileOpsForTests.fsyncSync;
    let calls = 0;
    vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
      calls++;
      if (calls === 4) throw new Error("simulated fsync failure");
      return fsync(fd);
    });

    expect(() =>
      appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
        applicationKey: "B2_MCP_CANARY_SECRET_failed_fsync",
      }),
    ).toThrow(/simulated fsync failure/);

    expect(readFileSync(file, "utf8")).toBe("");
  });

  it("returns a committed pointer when close fails after fsync", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const close = secretSinkFileOpsForTests.closeSync;
    let closeCalls = 0;
    vi.spyOn(secretSinkFileOpsForTests, "closeSync").mockImplementation((fd) => {
      closeCalls++;
      if (closeCalls === 1) throw new Error("simulated close failure");
      return close(fd);
    });
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");

    const pointer = appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
      applicationKey: "B2_MCP_CANARY_SECRET_close_after_commit",
    });

    expect(pointer.recordId).toEqual(expect.any(String));
    expect(readFileSync(file, "utf8")).toContain(pointer.recordId);
    expect(JSON.stringify(warnSpy.mock.calls)).toContain("close_failed_after_commit");
  });

  it("reclaims a stale append lock without touching pending idempotency claims", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const appendLock = `${file}.append.lock`;
    writeFileSync(file, "", { mode: 0o600 });
    writeFileSync(appendLock, `${JSON.stringify({ status: "appending" })}\n`, { mode: 0o600 });
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(appendLock, stale, stale);

    const pointer = appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
      applicationKey: "B2_MCP_CANARY_SECRET_stale_lock",
    });

    expect(pointer.recordId).toEqual(expect.any(String));
    expect(existsSync(appendLock)).toBe(false);
    expect(JSON.stringify(warnSpy.mock.calls)).toContain("stale_append_lock_reclaimed");
  });

  it("reclaims a stale reclaim lock before removing a stale append lock", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const appendLock = `${file}.append.lock`;
    const reclaimLock = `${appendLock}.reclaim`;
    writeFileSync(file, "", { mode: 0o600 });
    writeFileSync(appendLock, `${JSON.stringify({ status: "appending" })}\n`, { mode: 0o600 });
    writeFileSync(
      reclaimLock,
      `${JSON.stringify({ pid: 987654321, token: "stale-reclaim", status: "reclaiming_append_lock" })}\n`,
      { mode: 0o600 },
    );
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(appendLock, stale, stale);

    const pointer = appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
      applicationKey: "B2_MCP_CANARY_SECRET_stale_reclaim_lock",
    });

    expect(pointer.recordId).toEqual(expect.any(String));
    expect(existsSync(appendLock)).toBe(false);
    expect(existsSync(reclaimLock)).toBe(false);
    expect(JSON.stringify(warnSpy.mock.calls)).toContain("stale_reclaim_lock_reclaimed");
    expect(JSON.stringify(warnSpy.mock.calls)).toContain("stale_append_lock_reclaimed");
  });

  it("truncates an incomplete trailing ledger record before idempotency lookup", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "reuse-after-torn-tail",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: { keyName: "reuse-after-torn-tail", capabilities: ["listBuckets"] },
    });
    const pointer = appendSecretSinkRecord(
      { mode: "file", filePath: file },
      "b2_create_key",
      { applicationKeyId: "key-id", applicationKey: "B2_MCP_CANARY_SECRET_reuse" },
      idempotency,
    );
    appendFileSync(file, '{"ts":"2026-08-18T15:24:45Z","tool":"b2_create_key"');
    let createCalls = 0;

    const result = await executeDurableSecretOperation({
      secretSink: { mode: "file", filePath: file },
      toolName: "b2_create_key",
      idempotency,
      create: async () => {
        createCalls++;
        return { applicationKey: "B2_MCP_CANARY_SECRET_duplicate" };
      },
      projectRedacted: (created: Record<string, unknown>, sinkPointer) => ({
        ...created,
        applicationKey: "[redacted]",
        secretSink: sinkPointer,
      }),
      projectInline: (created: Record<string, unknown>, warning: string) => ({
        ...created,
        warning,
      }),
    });

    expect(createCalls).toBe(0);
    expect(result.structuredContent).toMatchObject({
      applicationKeyId: "key-id",
      applicationKey: "[redacted]",
      secretSink: pointer,
    });
    expect(readFileSync(file, "utf8")).not.toContain("15:24:45");
    expect(JSON.stringify(warnSpy.mock.calls)).toContain("incomplete_tail_truncated");
  });

  it("terminates a complete trailing ledger record before appending another", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "complete-tail",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: { keyName: "complete-tail", capabilities: ["listBuckets"] },
    });
    appendSecretSinkRecord(
      { mode: "file", filePath: file },
      "b2_create_key",
      { applicationKeyId: "key-id", applicationKey: "B2_MCP_CANARY_SECRET_complete_tail" },
      idempotency,
    );
    const withoutTrailingNewline = readFileSync(file, "utf8").trimEnd();
    writeFileSync(file, withoutTrailingNewline, { mode: 0o600 });

    appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
      applicationKeyId: "key-id-2",
      applicationKey: "B2_MCP_CANARY_SECRET_second_record",
    });

    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    expect(JSON.stringify(warnSpy.mock.calls)).toContain("incomplete_tail_terminated");
  });

  it("continues to reject malformed committed ledger records", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    writeFileSync(file, '{"tool":"b2_create_key"}\n', { mode: 0o600 });
    const idempotency = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "malformed-committed",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: { keyName: "malformed-committed", capabilities: ["listBuckets"] },
    });

    await expect(
      executeDurableSecretOperation({
        secretSink: { mode: "file", filePath: file },
        toolName: "b2_create_key",
        idempotency,
        create: async () => ({ applicationKey: "B2_MCP_CANARY_SECRET_unreached" }),
        projectRedacted: (created: Record<string, unknown>, sinkPointer) => ({
          ...created,
          secretSink: sinkPointer,
        }),
        projectInline: (created: Record<string, unknown>, warning: string) => ({
          ...created,
          warning,
        }),
      }),
    ).rejects.toThrow(/contains an invalid record/);
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

  it("reuses idempotency records after the plaintext ledger is rotated away", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "ledger-rotated",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: { keyName: "ledger-rotated", capabilities: ["listBuckets"] },
    });
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
    let createCalls = 0;

    const first = await executeDurableSecretOperation({
      ...options,
      create: async () => {
        createCalls++;
        return {
          applicationKeyId: "key-id",
          applicationKey: "B2_MCP_CANARY_SECRET_indexed",
        };
      },
    });
    rmSync(file);

    const second = await executeDurableSecretOperation({
      ...options,
      create: async () => {
        createCalls++;
        return { applicationKey: "B2_MCP_CANARY_SECRET_duplicate" };
      },
    });

    expect(createCalls).toBe(1);
    expect(second.structuredContent).toEqual(first.structuredContent);
    const index = readFileSync(`${file}.idempotency.jsonl`, "utf8");
    expect(index).toContain("ledger-rotated");
    expect(index).not.toContain("B2_MCP_CANARY_SECRET_indexed");
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

  it("keeps the pending claim after an HTTP 408 provider timeout", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "provider-408-timeout",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: { keyName: "provider-408-timeout", capabilities: ["listBuckets"] },
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
          throw { status: 408, code: "request_timeout" };
        },
      }),
    ).rejects.toMatchObject({ status: 408 });

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

  it("releases the pending claim when pre-provider claim durability fails", async () => {
    const fsync = secretSinkFileOpsForTests.fsyncSync;
    let calls = 0;
    vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
      calls++;
      if (calls === 3) throw new Error("simulated claim directory fsync failure");
      return fsync(fd);
    });
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "pre-provider-claim-failure",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: { keyName: "pre-provider-claim-failure", capabilities: ["listBuckets"] },
    });
    let createCalls = 0;

    await expect(
      executeDurableSecretOperation({
        secretSink: { mode: "file", filePath: file },
        toolName: "b2_create_key",
        idempotency,
        create: async () => {
          createCalls++;
          return { applicationKey: "B2_MCP_CANARY_SECRET_unreached" };
        },
        projectRedacted: (result: Record<string, unknown>, pointer: unknown) => ({
          ...result,
          applicationKey: "[redacted]",
          secretSink: pointer,
        }),
        projectInline: (result: Record<string, unknown>, warning: string) => ({
          ...result,
          warning,
        }),
      }),
    ).rejects.toThrow(/claim directory fsync/);

    expect(createCalls).toBe(0);
    expect(readdirSync(dir).filter((name) => name.endsWith(".pending"))).toHaveLength(0);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("claim_cleanup_failed");
  });

  it("does not compensate a committed credential when claim cleanup fails", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const recoverSpy = vi.fn();
    const unlink = secretSinkFileOpsForTests.unlinkSync;
    let failedPendingCleanup = false;
    vi.spyOn(secretSinkFileOpsForTests, "unlinkSync").mockImplementation((path) => {
      if (!failedPendingCleanup && String(path).endsWith(".pending")) {
        failedPendingCleanup = true;
        throw new Error("simulated claim cleanup failure");
      }
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

  it("returns a stable failure when committed idempotency metadata cannot be stored", async () => {
    const fatalSpy = vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
    const recoverSpy = vi.fn();
    const rename = secretSinkFileOpsForTests.renameSync;
    vi.spyOn(secretSinkFileOpsForTests, "renameSync").mockImplementation((oldPath, newPath) => {
      if (String(newPath).endsWith(".committed.json")) {
        throw new Error("simulated committed marker rename failure");
      }
      return rename(oldPath, newPath);
    });
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const secret = "B2_MCP_CANARY_SECRET_replay_metadata";
    const idempotency = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "replay-metadata-failure",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: { keyName: "replay-metadata-failure", capabilities: ["listBuckets"] },
    });
    let createCalls = 0;
    const options = {
      secretSink: { mode: "file" as const, filePath: file },
      toolName: "b2_create_key",
      idempotency,
      projectRedacted: (created: Record<string, unknown>, pointer: unknown) => ({
        ...created,
        applicationKey: "[redacted]",
        secretSink: pointer,
      }),
      projectInline: (created: Record<string, unknown>, warning: string) => ({
        ...created,
        warning,
      }),
      recoverAfterSinkFailure: recoverSpy,
    };

    await expect(
      executeDurableSecretOperation({
        ...options,
        create: async () => {
          createCalls++;
          return {
            applicationKeyId: "key-id",
            applicationKey: secret,
          };
        },
      }),
    ).rejects.toMatchObject({ code: "secret_sink_replay_unavailable" });

    await expect(
      executeDurableSecretOperation({
        ...options,
        create: async () => {
          createCalls++;
          return {
            applicationKeyId: "key-id-duplicate",
            applicationKey: "B2_MCP_CANARY_SECRET_duplicate",
          };
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_key_pending" });

    expect(createCalls).toBe(1);
    expect(recoverSpy).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toContain(secret);
    expect(readdirSync(dir).some((name) => name.endsWith(".pending"))).toBe(true);
    expect(JSON.stringify(fatalSpy.mock.calls)).toContain(
      "secret_sink.idempotency_claim_retained_after_index_failure",
    );
  });

  it("keeps the pending claim when rollback after write failure is unconfirmed", async () => {
    const fatalSpy = vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
    const recoverSpy = vi.fn();
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const secret = "B2_MCP_CANARY_SECRET_ambiguous_rollback";
    const fsync = secretSinkFileOpsForTests.fsyncSync;
    let recordFsyncFailed = false;
    vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
      if (!recordFsyncFailed && existsSync(file) && readFileSync(file, "utf8").includes(secret)) {
        recordFsyncFailed = true;
        throw new Error("simulated record fsync failure");
      }
      return fsync(fd);
    });
    vi.spyOn(secretSinkFileOpsForTests, "ftruncateSync").mockImplementation(() => {
      throw new Error("simulated rollback failure");
    });
    let createCalls = 0;
    const idempotency = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "ambiguous-rollback",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: { keyName: "ambiguous-rollback", capabilities: ["listBuckets"] },
    });

    await expect(
      executeDurableSecretOperation({
        secretSink: { mode: "file", filePath: file },
        toolName: "b2_create_key",
        idempotency,
        create: async () => ({
          applicationKeyId: "key-id",
          applicationKey: secret,
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
      }),
    ).rejects.toMatchObject({ code: "secret_sink_commit_ambiguous" });

    await expect(
      executeDurableSecretOperation({
        secretSink: { mode: "file", filePath: file },
        toolName: "b2_create_key",
        idempotency,
        create: async () => {
          createCalls++;
          return {
            applicationKeyId: "key-id-duplicate",
            applicationKey: "B2_MCP_CANARY_SECRET_duplicate",
          };
        },
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
      }),
    ).rejects.toMatchObject({ code: "idempotency_key_pending" });

    expect(createCalls).toBe(0);
    expect(recoverSpy).not.toHaveBeenCalled();
    expect(readdirSync(dir).some((name) => name.endsWith(".pending"))).toBe(true);
    expect(JSON.stringify(fatalSpy.mock.calls)).toContain("pending_reconciliation");
  });
});
