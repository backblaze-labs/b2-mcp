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
  setSinkWriteForTests,
} from "../../src/utils/secret-sink";
import { logger } from "../../src/utils/logger";

const APPEND_LOCK_SUFFIX = ".append.lock";
const APPEND_RECLAIM_LOCK_SUFFIX = ".reclaim";
const APPEND_LOCK_WAIT_TIMEOUT_MS = 30_000;
const APPEND_LOCK_WAIT_TIMEOUT_MARGIN_MS = 1_000;
const COMMITTED_IDEMPOTENCY_MARKER_SUFFIX = ".committed.json";
const IDEMPOTENCY_INDEX_SUFFIX = ".idempotency.jsonl";
const PENDING_CLAIM_MARKER_SUFFIX = ".pending";

type TestIdempotency = ReturnType<typeof durableSecretIdempotency>;

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

function testIdempotency(idempotencyKey: string, normalizedInput?: unknown) {
  return durableSecretIdempotency({
    toolName: "b2_create_key",
    idempotencyKey,
    callerFingerprint: "credential-fingerprint",
    normalizedInput: normalizedInput ?? {
      keyName: idempotencyKey,
      capabilities: ["listBuckets"],
    },
  });
}

function appendLockPath(file: string): string {
  return `${file}${APPEND_LOCK_SUFFIX}`;
}

function appendReclaimLockPath(file: string): string {
  return `${appendLockPath(file)}${APPEND_RECLAIM_LOCK_SUFFIX}`;
}

function idempotencyIndexPath(file: string): string {
  return `${file}${IDEMPOTENCY_INDEX_SUFFIX}`;
}

function pendingClaimPath(file: string, idempotency: TestIdempotency): string {
  return `${file}.${idempotency.claimFingerprint}${PENDING_CLAIM_MARKER_SUFFIX}`;
}

function committedIdempotencyMarkerPath(file: string, idempotency: TestIdempotency): string {
  return `${file}.${idempotency.claimFingerprint}${COMMITTED_IDEMPOTENCY_MARKER_SUFFIX}`;
}

function pendingClaimNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(PENDING_CLAIM_MARKER_SUFFIX));
}

function appendLockNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(APPEND_LOCK_SUFFIX));
}

function durableSecretTestOptions(
  file: string,
  idempotency: ReturnType<typeof durableSecretIdempotency>,
  extra: {
    diagnostics?: (result: Record<string, unknown>) => Record<string, unknown>;
    recoverAfterSinkFailure?: (result: Record<string, unknown>, err: unknown) => unknown;
  } = {},
) {
  return {
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
    ...extra,
  };
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
    expect(
      resolveSecretSinkConfig({
        transport: "http",
        env: {
          B2_SECRET_SINK: "file",
          B2_ALLOW_LOCAL_FILES: "true",
          B2_SECRET_SINK_FILE: path,
        },
        preflight: false,
      }),
    ).toEqual({ mode: "file", filePath: path });
  });

  it("uses process.env when no explicit environment is supplied", () => {
    const previousMode = process.env.B2_SECRET_SINK;
    delete process.env.B2_SECRET_SINK;

    try {
      expect(resolveSecretSinkConfig({ transport: "http", preflight: false })).toEqual({
        mode: "off",
      });
    } finally {
      if (previousMode === undefined) delete process.env.B2_SECRET_SINK;
      else process.env.B2_SECRET_SINK = previousMode;
    }
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

  it("rejects invalid secret sink modes", () => {
    expect(() =>
      resolveSecretSinkConfig({
        transport: "stdio",
        env: { B2_SECRET_SINK: "stdout" },
        preflight: false,
      }),
    ).toThrow(/Invalid B2_SECRET_SINK/);
  });

  it("preflights sink files when the runtime has no getuid helper", () => {
    const originalGetuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    const file = join(tempDir(), "secrets.jsonl");
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });

    try {
      expect(
        resolveSecretSinkConfig({
          transport: "stdio",
          env: { B2_SECRET_SINK_FILE: file },
        }),
      ).toEqual({ mode: "file", filePath: file });
    } finally {
      if (originalGetuidDescriptor) {
        Object.defineProperty(process, "getuid", originalGetuidDescriptor);
      } else {
        delete (process as NodeJS.Process & { getuid?: unknown }).getuid;
      }
    }
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

  it("throws a configured file error when an explicit sink path cannot open", () => {
    const dir = tempDir();
    const target = join(dir, "target.jsonl");
    const link = join(dir, "secrets.jsonl");
    writeFileSync(target, "", { mode: 0o600 });
    symlinkSync(target, link);

    expect(() =>
      resolveSecretSinkConfig({
        transport: "stdio",
        env: { B2_SECRET_SINK: "file", B2_SECRET_SINK_FILE: link },
      }),
    ).toThrow(/B2_SECRET_SINK=file could not open/);
  });

  it("rejects a secret sink path that resolves to the log file", () => {
    const file = join(tempDir(), "shared.jsonl");
    const missingParentFile = join(tempDir(), "missing", "shared.jsonl");
    const distinctSinkFile = join(tempDir(), "secrets.jsonl");
    const distinctLogFile = join(tempDir(), "b2.log");
    const fileParent = join(tempDir(), "not-a-directory");
    writeFileSync(fileParent, "", { mode: 0o600 });

    expect(() =>
      resolveSecretSinkConfig({
        transport: "stdio",
        env: { B2_SECRET_SINK_FILE: file, B2_LOG_FILE: file },
        preflight: false,
      }),
    ).toThrow(/B2_SECRET_SINK_FILE must not resolve to B2_LOG_FILE/);
    expect(() =>
      resolveSecretSinkConfig({
        transport: "stdio",
        env: { B2_SECRET_SINK_FILE: missingParentFile, B2_LOG_FILE: missingParentFile },
        preflight: false,
      }),
    ).toThrow(/B2_SECRET_SINK_FILE must not resolve to B2_LOG_FILE/);
    expect(
      resolveSecretSinkConfig({
        transport: "stdio",
        env: { B2_SECRET_SINK_FILE: distinctSinkFile, B2_LOG_FILE: distinctLogFile },
        preflight: false,
      }),
    ).toEqual({ mode: "file", filePath: distinctSinkFile });
    expect(() =>
      resolveSecretSinkConfig({
        transport: "stdio",
        env: {
          B2_SECRET_SINK_FILE: join(fileParent, "child"),
          B2_LOG_FILE: distinctLogFile,
        },
        preflight: false,
      }),
    ).toThrow();
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

  it("closes the ledger descriptor when pre-commit directory fsync fails", () => {
    const originalFsync = secretSinkFileOpsForTests.fsyncSync;
    let fsyncCalls = 0;
    vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
      fsyncCalls++;
      if (fsyncCalls === 3) throw new Error("directory fsync failed");
      return originalFsync(fd);
    });
    const closeSpy = vi.spyOn(secretSinkFileOpsForTests, "closeSync");
    const file = join(tempDir(), "secrets.jsonl");

    expect(() =>
      appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
        applicationKey: "B2_MCP_CANARY_SECRET_precommit_fsync",
      }),
    ).toThrow(/directory fsync failed/);

    expect(closeSpy).toHaveBeenCalledTimes(1);
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

  it("rejects a symlinked parent directory", () => {
    const dir = tempDir();
    const targetParent = join(dir, "target-parent");
    const linkParent = join(dir, "link-parent");
    mkdirSync(targetParent, { mode: 0o700 });
    symlinkSync(targetParent, linkParent);

    expect(() =>
      appendSecretSinkRecord(
        { mode: "file", filePath: join(linkParent, "secrets.jsonl") },
        "b2_create_key",
        {},
      ),
    ).toThrow(/parent must be a directory|parent must not be a symlink/);
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
    const appendLock = appendLockPath(file);
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

  it("reclaims a stale append lock with malformed owner metadata", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const appendLock = appendLockPath(file);
    writeFileSync(file, "", { mode: 0o600 });
    writeFileSync(appendLock, "not-json\n", { mode: 0o600 });
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(appendLock, stale, stale);

    const pointer = appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
      applicationKey: "B2_MCP_CANARY_SECRET_malformed_stale_lock",
    });

    expect(pointer.recordId).toEqual(expect.any(String));
    expect(existsSync(appendLock)).toBe(false);
    expect(JSON.stringify(warnSpy.mock.calls)).toContain("stale_append_lock_reclaimed");
  });

  it("reclaims a stale reclaim lock before removing a stale append lock", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const appendLock = appendLockPath(file);
    const reclaimLock = appendReclaimLockPath(file);
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

  it("rejects malformed JSON and non-object ledger records", async () => {
    for (const [suffix, line, message] of [
      ["json", "not-json\n", /contains invalid JSON/],
      ["array", "[]\n", /contains a non-object record/],
    ] as const) {
      const dir = tempDir();
      const file = join(dir, `secrets-${suffix}.jsonl`);
      writeFileSync(file, line, { mode: 0o600 });
      const idempotency = durableSecretIdempotency({
        toolName: "b2_create_key",
        idempotencyKey: `malformed-${suffix}`,
        callerFingerprint: "credential-fingerprint",
        normalizedInput: { keyName: `malformed-${suffix}`, capabilities: ["listBuckets"] },
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
      ).rejects.toThrow(message);
    }
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
    const index = readFileSync(idempotencyIndexPath(file), "utf8");
    expect(index).toContain("ledger-rotated");
    expect(index).not.toContain("B2_MCP_CANARY_SECRET_indexed");
  });

  it("reuses legacy idempotency records from the bounded ledger tail", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "legacy-tail",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: { keyName: "legacy-tail", capabilities: ["listBuckets"] },
    });
    const legacy = {
      ts: "2026-08-18T12:00:00Z",
      tool: "b2_create_key",
      recordId: "legacy-tail-record",
      idempotency,
      result: { applicationKeyId: "key-id", applicationKey: "B2_MCP_CANARY_SECRET_legacy_tail" },
    };
    const padding = {
      ts: "2026-08-18T11:59:00Z",
      tool: "b2_create_key",
      recordId: "padding-record",
      result: { note: "x".repeat(1024 * 1024) },
    };
    writeFileSync(file, `${JSON.stringify(padding)}\n${JSON.stringify(legacy)}\n`, {
      mode: 0o600,
    });
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
      secretSink: { type: "file", path: file, recordId: "legacy-tail-record" },
    });
  });

  it("uses a committed marker that races after pending claim creation", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "raced-commit",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: { keyName: "raced-commit", capabilities: ["listBuckets"] },
    });
    const pointer = { type: "file" as const, path: file, recordId: "raced-record" };
    const markerPath = committedIdempotencyMarkerPath(file, idempotency);
    const fsync = secretSinkFileOpsForTests.fsyncSync;
    let markerWritten = false;
    vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
      const result = fsync(fd);
      if (!markerWritten && existsSync(pendingClaimPath(file, idempotency))) {
        markerWritten = true;
        writeFileSync(
          markerPath,
          JSON.stringify({
            ts: "2026-08-18T12:00:00Z",
            tool: "b2_create_key",
            recordId: pointer.recordId,
            idempotency,
            result: { applicationKeyId: "key-id", applicationKey: "[redacted]" },
            pointer,
          }),
          { mode: 0o600 },
        );
      }
      return result;
    });
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
    expect(pendingClaimNames(dir)).toHaveLength(0);
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
    expect(pendingClaimNames(dir)).toHaveLength(0);
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
    expect(pendingClaimNames(dir).length).toBeGreaterThan(0);
  });

  it("releases the pending claim after a known provider rejection", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "known-provider-rejection",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: { keyName: "known-provider-rejection", capabilities: ["listBuckets"] },
    });

    await expect(
      executeDurableSecretOperation({
        secretSink: { mode: "file", filePath: file },
        toolName: "b2_create_key",
        idempotency,
        create: async () => {
          throw { status: 403, code: "access_denied" };
        },
        projectRedacted: (created: Record<string, unknown>, sinkPointer) => ({
          ...created,
          secretSink: sinkPointer,
        }),
        projectInline: (created: Record<string, unknown>, warning: string) => ({
          ...created,
          warning,
        }),
      }),
    ).rejects.toMatchObject({ status: 403 });

    expect(pendingClaimNames(dir)).toHaveLength(0);
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
    expect(pendingClaimNames(dir).length).toBeGreaterThan(0);
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
    expect(pendingClaimNames(dir)).toHaveLength(0);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("claim_cleanup_failed");
  });

  it("cleans up the pending claim when the post-claim fsync fails", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = testIdempotency("post-claim-fsync-failure");
    const pendingPath = pendingClaimPath(file, idempotency);
    const fsync = secretSinkFileOpsForTests.fsyncSync;
    let pendingDurabilityCalls = 0;
    vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
      if (existsSync(pendingPath)) {
        pendingDurabilityCalls++;
        if (pendingDurabilityCalls === 2) {
          throw new Error("simulated post-claim fsync failure");
        }
      }
      return fsync(fd);
    });
    let createCalls = 0;

    await expect(
      executeDurableSecretOperation({
        ...durableSecretTestOptions(file, idempotency),
        create: async () => {
          createCalls++;
          return { applicationKey: "B2_MCP_CANARY_SECRET_unreached" };
        },
      }),
    ).rejects.toThrow(/post-claim fsync/);

    expect(createCalls).toBe(0);
    expect(existsSync(pendingPath)).toBe(false);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("claim_cleanup_failed");
  });

  it("does not compensate a committed credential when claim cleanup fails", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const recoverSpy = vi.fn();
    const unlink = secretSinkFileOpsForTests.unlinkSync;
    let failedPendingCleanup = false;
    vi.spyOn(secretSinkFileOpsForTests, "unlinkSync").mockImplementation((path) => {
      if (!failedPendingCleanup && String(path).endsWith(PENDING_CLAIM_MARKER_SUFFIX)) {
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

  it("treats malformed pending claim metadata as pending", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "malformed-pending",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: { keyName: "malformed-pending", capabilities: ["listBuckets"] },
    });
    writeFileSync(
      pendingClaimPath(file, idempotency),
      `${JSON.stringify({
        idempotency: { key: idempotency.key, claimFingerprint: idempotency.claimFingerprint },
      })}\n`,
      { mode: 0o600 },
    );
    let createCalls = 0;

    await expect(
      executeDurableSecretOperation({
        secretSink: { mode: "file", filePath: file },
        toolName: "b2_create_key",
        idempotency,
        create: async () => {
          createCalls++;
          return { applicationKey: "B2_MCP_CANARY_SECRET_duplicate" };
        },
        projectRedacted: (created: Record<string, unknown>, sinkPointer) => ({
          ...created,
          secretSink: sinkPointer,
        }),
        projectInline: (created: Record<string, unknown>, warning: string) => ({
          ...created,
          warning,
        }),
      }),
    ).rejects.toMatchObject({ code: "idempotency_key_pending" });

    expect(createCalls).toBe(0);
  });

  it("treats array-shaped pending claim metadata as pending", async () => {
    for (const [suffix, payload] of [
      ["top-array", []],
      ["idempotency-array", { idempotency: [] }],
    ] as const) {
      const dir = tempDir();
      const file = join(dir, "secrets.jsonl");
      const idempotency = testIdempotency(`malformed-pending-${suffix}`);
      writeFileSync(pendingClaimPath(file, idempotency), `${JSON.stringify(payload)}\n`, {
        mode: 0o600,
      });
      let createCalls = 0;

      await expect(
        executeDurableSecretOperation({
          ...durableSecretTestOptions(file, idempotency),
          create: async () => {
            createCalls++;
            return { applicationKey: "B2_MCP_CANARY_SECRET_duplicate" };
          },
        }),
      ).rejects.toMatchObject({ code: "idempotency_key_pending" });

      expect(createCalls).toBe(0);
    }
  });

  it("returns a stable failure when committed idempotency metadata cannot be stored", async () => {
    const fatalSpy = vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
    const recoverSpy = vi.fn();
    const rename = secretSinkFileOpsForTests.renameSync;
    vi.spyOn(secretSinkFileOpsForTests, "renameSync").mockImplementation((oldPath, newPath) => {
      if (String(newPath).endsWith(COMMITTED_IDEMPOTENCY_MARKER_SUFFIX)) {
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
    expect(pendingClaimNames(dir).length).toBeGreaterThan(0);
    expect(JSON.stringify(fatalSpy.mock.calls)).toContain(
      "secret_sink.idempotency_claim_retained_after_index_failure",
    );
  });

  it("does not expose plaintext writes through exported file test helpers", () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const secret = "B2_MCP_CANARY_SECRET_exported_write_seam";
    const exportedOps = secretSinkFileOpsForTests as Record<string, unknown>;
    const interceptedWrite = vi.fn(() => {
      throw new Error("intercepted plaintext write");
    });

    try {
      expect(exportedOps.writeSync).toBeUndefined();
      exportedOps.writeSync = interceptedWrite;
      const pointer = appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
        applicationKey: secret,
      });

      expect(pointer.recordId).toEqual(expect.any(String));
      expect(interceptedWrite).not.toHaveBeenCalled();
      expect(readFileSync(file, "utf8")).toContain(secret);
    } finally {
      delete exportedOps.writeSync;
    }
  });

  it("guards sensitive write overrides outside the test environment", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";

      expect(() => setSinkWriteForTests(() => 0)).toThrow(/test only/);
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it("cleans up lock files when a lock write makes no progress", () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const previousWrite = setSinkWriteForTests(() => 0);

    try {
      expect(() =>
        appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
          applicationKey: "B2_MCP_CANARY_SECRET_lock_write_no_progress",
        }),
      ).toThrow(/write made no progress/);
    } finally {
      setSinkWriteForTests(previousWrite);
    }

    expect(appendLockNames(dir)).toHaveLength(0);
  });

  it("logs close failures before an uncommitted append is rolled back", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const secret = "B2_MCP_CANARY_SECRET_close_before_commit";
    const fsync = secretSinkFileOpsForTests.fsyncSync;
    let recordFsyncFailed = false;
    vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
      if (!recordFsyncFailed && existsSync(file) && readFileSync(file, "utf8").includes(secret)) {
        recordFsyncFailed = true;
        throw new Error("simulated record fsync failure");
      }
      return fsync(fd);
    });
    vi.spyOn(secretSinkFileOpsForTests, "closeSync").mockImplementation(() => {
      throw new Error("simulated close before commit");
    });

    expect(() =>
      appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
        applicationKey: secret,
      }),
    ).toThrow(/simulated record fsync failure/);

    expect(JSON.stringify(warnSpy.mock.calls)).toContain("close_failed_before_commit");
    expect(readFileSync(file, "utf8")).toBe("");
  });

  it("rejects a torn trailing ledger record beyond the recovery window", () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    writeFileSync(file, "x".repeat(1024 * 1024 + 1), { mode: 0o600 });

    expect(() =>
      appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
        applicationKey: "B2_MCP_CANARY_SECRET_large_torn_tail",
      }),
    ).toThrow(/trailing JSONL record exceeds bounded recovery window/);
  });

  it("propagates non-ENOENT tail read failures during recovery", () => {
    const dir = tempDir();
    const file = join(dir, "secrets-directory");
    mkdirSync(file, { mode: 0o700 });

    expect(() =>
      appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
        applicationKey: "B2_MCP_CANARY_SECRET_directory_tail",
      }),
    ).toThrow();
  });

  it("continues past unrelated legacy ledger records before creating a credential", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = testIdempotency("legacy-miss");
    writeFileSync(
      file,
      [
        JSON.stringify({
          ts: "2026-08-18T12:00:00Z",
          tool: "other_tool",
          recordId: "wrong-tool",
          idempotency,
          result: { applicationKey: "B2_MCP_CANARY_SECRET_wrong_tool" },
        }),
        JSON.stringify({
          ts: "2026-08-18T12:01:00Z",
          tool: "b2_create_key",
          recordId: "missing-idempotency",
          result: { applicationKey: "B2_MCP_CANARY_SECRET_missing_idempotency" },
        }),
        JSON.stringify({
          ts: "2026-08-18T12:02:00Z",
          tool: "b2_create_key",
          recordId: "wrong-key",
          idempotency: { key: "other-key", fingerprint: idempotency.fingerprint },
          result: { applicationKey: "B2_MCP_CANARY_SECRET_wrong_key" },
        }),
        JSON.stringify({
          ts: "2026-08-18T12:03:00Z",
          tool: "b2_create_key",
          recordId: "wrong-claim",
          idempotency: { ...idempotency, claimFingerprint: "other-claim" },
          result: { applicationKey: "B2_MCP_CANARY_SECRET_wrong_claim" },
        }),
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    let createCalls = 0;

    const result = await executeDurableSecretOperation({
      ...durableSecretTestOptions(file, idempotency),
      create: async () => {
        createCalls++;
        return {
          applicationKeyId: "key-id",
          applicationKey: "B2_MCP_CANARY_SECRET_legacy_miss_created",
        };
      },
    });

    expect(createCalls).toBe(1);
    expect(result.structuredContent).toMatchObject({
      applicationKeyId: "key-id",
      applicationKey: "[redacted]",
      secretSink: { type: "file", path: file },
    });
  });

  it("rejects conflicting legacy ledger records with the same idempotency key", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = testIdempotency("legacy-conflict");
    writeFileSync(
      file,
      `${JSON.stringify({
        ts: "2026-08-18T12:00:00Z",
        tool: "b2_create_key",
        recordId: "legacy-conflict-record",
        idempotency: { key: idempotency.key, fingerprint: "different-fingerprint" },
        result: { applicationKey: "B2_MCP_CANARY_SECRET_legacy_conflict" },
      })}\n`,
      { mode: 0o600 },
    );
    let createCalls = 0;

    await expect(
      executeDurableSecretOperation({
        ...durableSecretTestOptions(file, idempotency),
        create: async () => {
          createCalls++;
          return { applicationKey: "B2_MCP_CANARY_SECRET_unreached" };
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_key_conflict" });

    expect(createCalls).toBe(0);
  });

  it("ignores committed idempotency markers that do not match the request", async () => {
    for (const [suffix, committedIdempotency] of [
      ["missing-idempotency", undefined],
      [
        "wrong-claim",
        {
          key: "wrong-claim",
          claimFingerprint: "other-claim",
          fingerprint: "other-fingerprint",
        },
      ],
    ] as const) {
      const dir = tempDir();
      const file = join(dir, "secrets.jsonl");
      const idempotency = testIdempotency(`committed-${suffix}`);
      writeFileSync(
        committedIdempotencyMarkerPath(file, idempotency),
        `${JSON.stringify({
          ts: "2026-08-18T12:00:00Z",
          tool: "b2_create_key",
          recordId: `committed-${suffix}-record`,
          ...(committedIdempotency ? { idempotency: committedIdempotency } : {}),
          result: { applicationKey: "B2_MCP_CANARY_SECRET_stale_committed" },
        })}\n`,
        { mode: 0o600 },
      );
      let createCalls = 0;

      const result = await executeDurableSecretOperation({
        ...durableSecretTestOptions(file, idempotency),
        create: async () => {
          createCalls++;
          return {
            applicationKeyId: `key-id-${suffix}`,
            applicationKey: "B2_MCP_CANARY_SECRET_committed_miss_created",
          };
        },
      });

      expect(createCalls).toBe(1);
      expect(result.structuredContent).toMatchObject({
        applicationKeyId: `key-id-${suffix}`,
        applicationKey: "[redacted]",
      });
    }
  });

  it("rejects committed idempotency markers with conflicting fingerprints", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = testIdempotency("committed-conflict");
    writeFileSync(
      committedIdempotencyMarkerPath(file, idempotency),
      `${JSON.stringify({
        ts: "2026-08-18T12:00:00Z",
        tool: "b2_create_key",
        recordId: "committed-conflict-record",
        idempotency: { ...idempotency, fingerprint: "different-fingerprint" },
        result: { applicationKey: "B2_MCP_CANARY_SECRET_committed_conflict" },
      })}\n`,
      { mode: 0o600 },
    );
    let createCalls = 0;

    await expect(
      executeDurableSecretOperation({
        ...durableSecretTestOptions(file, idempotency),
        create: async () => {
          createCalls++;
          return { applicationKey: "B2_MCP_CANARY_SECRET_unreached" };
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_key_conflict" });

    expect(createCalls).toBe(0);
  });

  it("propagates malformed committed idempotency marker JSON", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = testIdempotency("committed-malformed-json");
    writeFileSync(committedIdempotencyMarkerPath(file, idempotency), "not-json\n", {
      mode: 0o600,
    });
    let createCalls = 0;

    await expect(
      executeDurableSecretOperation({
        ...durableSecretTestOptions(file, idempotency),
        create: async () => {
          createCalls++;
          return { applicationKey: "B2_MCP_CANARY_SECRET_unreached" };
        },
      }),
    ).rejects.toThrow();

    expect(createCalls).toBe(0);
  });

  it("keeps replay metadata sanitized when the audit index append fails", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const indexTarget = join(dir, "index-target.jsonl");
    const indexPath = idempotencyIndexPath(file);
    const idempotency = testIdempotency("audit-index-symlink");
    writeFileSync(indexTarget, "", { mode: 0o600 });
    symlinkSync(indexTarget, indexPath);

    const result = await executeDurableSecretOperation({
      ...durableSecretTestOptions(file, idempotency),
      create: async () => ({
        applicationKeyId: "key-id",
        applicationKey: "B2_MCP_CANARY_SECRET_audit_index",
        nested: {
          appKey: "B2_MCP_CANARY_SECRET_nested_audit_index",
        },
      }),
    });

    const committed = readFileSync(committedIdempotencyMarkerPath(file, idempotency), "utf8");
    expect(result.structuredContent).toMatchObject({
      applicationKeyId: "key-id",
      applicationKey: "[redacted]",
    });
    expect(committed).not.toContain("B2_MCP_CANARY_SECRET_audit_index");
    expect(committed).not.toContain("B2_MCP_CANARY_SECRET_nested_audit_index");
    expect(JSON.stringify(warnSpy.mock.calls)).toContain("idempotency_audit_append_failed");
  });

  it("returns inline durable secrets only for the explicit inline sink", async () => {
    const idempotency = testIdempotency("inline-secret");
    const result = await executeDurableSecretOperation({
      secretSink: { mode: "inline" },
      toolName: "b2_create_key",
      idempotency,
      create: async () => ({
        applicationKeyId: "key-id",
        applicationKey: "B2_MCP_CANARY_SECRET_inline",
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
    });

    expect(result.structuredContent).toMatchObject({
      applicationKeyId: "key-id",
      applicationKey: "B2_MCP_CANARY_SECRET_inline",
      warning: INLINE_SECRET_WARNING,
    });
  });

  it("redacts projected durable-secret output without invoking hostile accessors", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = testIdempotency("hostile-redacted-output");
    let getterReads = 0;

    const result = await executeDurableSecretOperation({
      ...durableSecretTestOptions(file, idempotency),
      create: async () => ({
        applicationKeyId: "key-id",
        applicationKey: "B2_MCP_CANARY_SECRET_plain_sink_record",
      }),
      projectRedacted: (_created: Record<string, unknown>, pointer) => {
        const projected: Record<string, unknown> = {
          secretSink: pointer,
          nested: {
            applicationKey: "B2_MCP_CANARY_SECRET_projected_nested",
          },
          arrayPayload: [{ appKey: "B2_MCP_CANARY_SECRET_projected_array" }],
        };
        projected.self = projected;
        Object.defineProperty(projected, "hostile", {
          enumerable: true,
          get() {
            getterReads++;
            throw new Error("B2_MCP_CANARY_SECRET_projected_getter");
          },
        });
        return projected;
      },
    });

    expect(getterReads).toBe(0);
    expect(JSON.stringify(result)).not.toContain("B2_MCP_CANARY_SECRET_projected");
    expect(result.structuredContent).toMatchObject({
      hostile: "[accessor]",
      self: "[circular]",
      nested: { applicationKey: "[redacted]" },
      arrayPayload: [{ appKey: "[redacted]" }],
    });
  });

  it("reclaims stale append locks whose payload is not an object", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const appendLock = appendLockPath(file);
    writeFileSync(file, "", { mode: 0o600 });
    writeFileSync(appendLock, "[]\n", { mode: 0o600 });
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(appendLock, stale, stale);

    const pointer = appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
      applicationKey: "B2_MCP_CANARY_SECRET_array_lock_payload",
    });

    expect(pointer.recordId).toEqual(expect.any(String));
    expect(JSON.stringify(warnSpy.mock.calls)).toContain("stale_append_lock_reclaimed");
  });

  it("continues when a stale append lock disappears during reclaim", () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const appendLock = appendLockPath(file);
    writeFileSync(file, "", { mode: 0o600 });
    writeFileSync(appendLock, `${JSON.stringify({ status: "appending" })}\n`, { mode: 0o600 });
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(appendLock, stale, stale);
    const unlink = secretSinkFileOpsForTests.unlinkSync;
    let disappeared = false;
    vi.spyOn(secretSinkFileOpsForTests, "unlinkSync").mockImplementation((path) => {
      if (!disappeared && path === appendLock) {
        disappeared = true;
        unlink(path);
        const err = new Error("lock disappeared") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return unlink(path);
    });

    const pointer = appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
      applicationKey: "B2_MCP_CANARY_SECRET_disappeared_lock",
    });

    expect(pointer.recordId).toEqual(expect.any(String));
    expect(disappeared).toBe(true);
  });

  it("waits once for a live append lock before timing out", () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const appendLock = appendLockPath(file);
    writeFileSync(file, "", { mode: 0o600 });
    writeFileSync(
      appendLock,
      `${JSON.stringify({
        ts: "2026-08-18T12:00:00Z",
        tool: "b2_create_key",
        pid: process.pid,
        token: "live-lock",
        status: "appending",
      })}\n`,
      { mode: 0o600 },
    );
    const now = Date.now();
    const unlink = secretSinkFileOpsForTests.unlinkSync;
    let firstReclaimAttemptFinished = false;
    vi.spyOn(secretSinkFileOpsForTests, "unlinkSync").mockImplementation((path) => {
      if (String(path) === appendReclaimLockPath(file)) {
        firstReclaimAttemptFinished = true;
      }
      return unlink(path);
    });
    vi.spyOn(Date, "now").mockImplementation(() =>
      firstReclaimAttemptFinished
        ? now + APPEND_LOCK_WAIT_TIMEOUT_MS + APPEND_LOCK_WAIT_TIMEOUT_MARGIN_MS
        : now,
    );

    expect(() =>
      appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
        applicationKey: "B2_MCP_CANARY_SECRET_live_lock_timeout",
      }),
    ).toThrow(/EEXIST|file already exists/i);

    expect(firstReclaimAttemptFinished).toBe(true);
    expect(existsSync(appendLock)).toBe(true);
  });

  it("releases the pending claim when sink failure recovery deletes the provider result", async () => {
    const fatalSpy = vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const secret = "B2_MCP_CANARY_SECRET_recovered_delete";
    const fsync = secretSinkFileOpsForTests.fsyncSync;
    let recordFsyncFailed = false;
    vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
      if (!recordFsyncFailed && existsSync(file) && readFileSync(file, "utf8").includes(secret)) {
        recordFsyncFailed = true;
        throw new Error("simulated sink fsync failure");
      }
      return fsync(fd);
    });
    const recoverSpy = vi.fn().mockReturnValue({ status: "deleted" });
    const idempotency = testIdempotency("recovered-delete");

    await expect(
      executeDurableSecretOperation({
        ...durableSecretTestOptions(file, idempotency, {
          diagnostics: (created) => ({ applicationKeyId: created.applicationKeyId }),
          recoverAfterSinkFailure: recoverSpy,
        }),
        create: async () => ({
          applicationKeyId: "key-id",
          applicationKey: secret,
        }),
      }),
    ).rejects.toMatchObject({ code: "secret_sink_write_failed" });

    expect(recoverSpy).toHaveBeenCalledOnce();
    expect(pendingClaimNames(dir)).toHaveLength(0);
    expect(JSON.stringify(fatalSpy.mock.calls)).toContain("write_failed_after_provider_create");
  });

  it("keeps the pending claim when sink failure recovery is inconclusive", async () => {
    const fatalSpy = vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const secret = "B2_MCP_CANARY_SECRET_recovery_unknown";
    const fsync = secretSinkFileOpsForTests.fsyncSync;
    let recordFsyncFailed = false;
    vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
      if (!recordFsyncFailed && existsSync(file) && readFileSync(file, "utf8").includes(secret)) {
        recordFsyncFailed = true;
        throw { code: "sink_write_failed" };
      }
      return fsync(fd);
    });
    const idempotency = testIdempotency("recovery-unknown");

    await expect(
      executeDurableSecretOperation({
        ...durableSecretTestOptions(file, idempotency, {
          recoverAfterSinkFailure: () => "manual-review",
        }),
        create: async () => ({
          applicationKeyId: "key-id",
          applicationKey: secret,
        }),
      }),
    ).rejects.toMatchObject({ code: "secret_sink_write_failed" });

    expect(pendingClaimNames(dir).length).toBeGreaterThan(0);
    expect(JSON.stringify(fatalSpy.mock.calls)).toContain("manual-review");
  });

  it("keeps the default recovery status when recovery returns undefined", async () => {
    const fatalSpy = vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const secret = "B2_MCP_CANARY_SECRET_recovery_undefined";
    const fsync = secretSinkFileOpsForTests.fsyncSync;
    let recordFsyncFailed = false;
    vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
      if (!recordFsyncFailed && existsSync(file) && readFileSync(file, "utf8").includes(secret)) {
        recordFsyncFailed = true;
        throw new Error("simulated sink fsync failure");
      }
      return fsync(fd);
    });
    const idempotency = testIdempotency("recovery-undefined");

    await expect(
      executeDurableSecretOperation({
        ...durableSecretTestOptions(file, idempotency, {
          recoverAfterSinkFailure: () => undefined,
        }),
        create: async () => ({
          applicationKeyId: "key-id",
          applicationKey: secret,
        }),
      }),
    ).rejects.toMatchObject({ code: "secret_sink_write_failed" });

    expect(pendingClaimNames(dir).length).toBeGreaterThan(0);
    expect(JSON.stringify(fatalSpy.mock.calls)).toContain("not_configured");
  });

  it("records recovery errors without releasing the pending claim", async () => {
    const fatalSpy = vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const secret = "B2_MCP_CANARY_SECRET_recovery_error";
    const fsync = secretSinkFileOpsForTests.fsyncSync;
    let recordFsyncFailed = false;
    vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
      if (!recordFsyncFailed && existsSync(file) && readFileSync(file, "utf8").includes(secret)) {
        recordFsyncFailed = true;
        throw new Error("simulated sink fsync failure");
      }
      return fsync(fd);
    });
    const idempotency = testIdempotency("recovery-error");

    await expect(
      executeDurableSecretOperation({
        ...durableSecretTestOptions(file, idempotency, {
          recoverAfterSinkFailure: () => {
            throw "cleanup failed";
          },
        }),
        create: async () => ({
          applicationKeyId: "key-id",
          applicationKey: secret,
        }),
      }),
    ).rejects.toMatchObject({ code: "secret_sink_write_failed" });

    expect(pendingClaimNames(dir).length).toBeGreaterThan(0);
    expect(JSON.stringify(fatalSpy.mock.calls)).toContain("cleanup failed");
  });

  it("records Error recovery messages without releasing the pending claim", async () => {
    const fatalSpy = vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const secret = "B2_MCP_CANARY_SECRET_recovery_error_object";
    const fsync = secretSinkFileOpsForTests.fsyncSync;
    let recordFsyncFailed = false;
    vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
      if (!recordFsyncFailed && existsSync(file) && readFileSync(file, "utf8").includes(secret)) {
        recordFsyncFailed = true;
        throw new Error("simulated sink fsync failure");
      }
      return fsync(fd);
    });
    const idempotency = testIdempotency("recovery-error-object");

    await expect(
      executeDurableSecretOperation({
        ...durableSecretTestOptions(file, idempotency, {
          recoverAfterSinkFailure: () => {
            throw new Error("cleanup failed with Error");
          },
        }),
        create: async () => ({
          applicationKeyId: "key-id",
          applicationKey: secret,
        }),
      }),
    ).rejects.toMatchObject({ code: "secret_sink_write_failed" });

    expect(pendingClaimNames(dir).length).toBeGreaterThan(0);
    expect(JSON.stringify(fatalSpy.mock.calls)).toContain("cleanup failed with Error");
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
    expect(pendingClaimNames(dir).length).toBeGreaterThan(0);
    expect(JSON.stringify(fatalSpy.mock.calls)).toContain("pending_reconciliation");
  });
});
