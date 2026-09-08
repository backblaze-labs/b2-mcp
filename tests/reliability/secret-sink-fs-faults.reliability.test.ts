/**
 * Reliability-layer fault-injection coverage for the durable secret sink.
 *
 * These scenarios drive the filesystem fault-recovery and edge branches of
 * `src/utils/secret-sink.ts` that the deterministic unit suite does not reach:
 * error-cause coercion, symlink parent guards, canonicalization failures,
 * torn-tail recovery, EEXIST claim races, and secret-scanning cycle detection.
 * They combine real temp-dir fixtures with targeted `node:fs` fault injection
 * (a module mock delegating to the real implementation except for the calls a
 * test overrides), and assert the fail-safe behavior (reject, recover, or
 * retain a pending claim) rather than merely executing the line.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type FsOverride = (...args: unknown[]) => unknown;

const fsMock = vi.hoisted(() => ({
  overrides: {} as Record<string, FsOverride | undefined>,
  actual: {} as typeof import("node:fs"),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  Object.assign(fsMock.actual, actual);
  const wrap =
    (name: keyof typeof import("node:fs")) =>
    (...args: unknown[]) => {
      const override = fsMock.overrides[name as string];
      if (override) return override(...args);
      return (actual[name] as (...a: unknown[]) => unknown)(...args);
    };
  const realpathSync = ((...args: unknown[]) => {
    const override = fsMock.overrides.realpathSync;
    if (override) return override(...args);
    return (actual.realpathSync as (...a: unknown[]) => unknown)(...args);
  }) as unknown as typeof actual.realpathSync;
  (realpathSync as { native: (...a: unknown[]) => unknown }).native = (...args: unknown[]) => {
    const override = fsMock.overrides["realpathSync.native"];
    if (override) return override(...args);
    return (actual.realpathSync.native as (...a: unknown[]) => unknown)(...args);
  };
  return {
    ...actual,
    openSync: wrap("openSync"),
    lstatSync: wrap("lstatSync"),
    statSync: wrap("statSync"),
    realpathSync,
  };
});

import {
  appendSecretSinkRecord,
  durableSecretIdempotency,
  durableSecretPostCreateFailure,
  executeDurableSecretOperation,
  resolveSecretSinkConfig,
  secretSinkFileOpsForTests,
  setSinkWriteForTests,
} from "../../src/utils/secret-sink";
import { logger } from "../../src/utils/logger";
import * as fs from "node:fs";

const PENDING_CLAIM_MARKER_SUFFIX = ".pending";
const COMMITTED_MARKER_SUFFIX = ".committed.json";
const O_DIRECTORY = fsMock.actual.constants.O_DIRECTORY;
const O_EXCL = fsMock.actual.constants.O_EXCL;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "b2-mcp-sink-fault-"));
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

function clearFsOverrides(): void {
  for (const key of Object.keys(fsMock.overrides)) delete fsMock.overrides[key];
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

function durableSecretOptions(
  file: string,
  idempotency: ReturnType<typeof durableSecretIdempotency>,
  overrides: Partial<{
    create: () => Promise<Record<string, unknown>>;
    projectRedacted: (result: Record<string, unknown>, pointer: unknown) => unknown;
  }> = {},
) {
  return {
    secretSink: { mode: "file" as const, filePath: file },
    toolName: "b2_create_key",
    idempotency,
    create:
      overrides.create ??
      (async () => ({
        applicationKeyId: "key-id",
        applicationKey: "B2_MCP_CANARY_SECRET_default",
      })),
    projectRedacted:
      overrides.projectRedacted ??
      ((result: Record<string, unknown>, pointer: unknown) => ({
        ...result,
        applicationKey: "[redacted]",
        secretSink: pointer,
      })),
    projectInline: (result: Record<string, unknown>, warning: string) => ({
      ...result,
      warning,
    }),
  };
}

function loggedCalls(spy: { mock: { calls: unknown[][] } }): string {
  return JSON.stringify(spy.mock.calls);
}

describe("secret sink filesystem fault recovery", () => {
  afterEach(() => {
    clearFsOverrides();
    vi.restoreAllMocks();
  });

  it("coerces Error, non-Error, and object post-create failure causes", () => {
    // String (non-Error, non-object) cause: message is coerced via String(),
    // and the empty causeRecord leaves status/code undefined.
    const stringCauseFailure = durableSecretPostCreateFailure(
      { applicationKey: "B2_MCP_CANARY_SECRET_string_cause" },
      "provider normalization failed",
    ) as Error & { status?: unknown; code?: unknown; cause?: unknown };
    expect(stringCauseFailure.message).toBe("provider normalization failed");
    expect(stringCauseFailure.status).toBeUndefined();
    expect(stringCauseFailure.code).toBeUndefined();
    expect(stringCauseFailure.cause).toBe("provider normalization failed");

    // Error cause: message comes from cause.message, and status/code are read
    // off the (object) Error instance's own enumerable-ish properties.
    const errorCause = Object.assign(new Error("normalization threw"), {
      status: 422,
      code: "bad_shape",
    });
    const errorCauseFailure = durableSecretPostCreateFailure(
      { applicationKey: "B2_MCP_CANARY_SECRET_error_cause" },
      errorCause,
    ) as Error & { status?: unknown; code?: unknown; cause?: unknown };
    expect(errorCauseFailure.message).toBe("normalization threw");
    expect(errorCauseFailure.status).toBe(422);
    expect(errorCauseFailure.code).toBe("bad_shape");
    expect(errorCauseFailure.cause).toBe(errorCause);

    // Plain object (non-Error) cause: message is String(cause), but status/code
    // are still lifted from the object.
    const objectCauseFailure = durableSecretPostCreateFailure(
      { applicationKey: "B2_MCP_CANARY_SECRET_object_cause" },
      { status: 409, code: "operation_status_unknown", message: "maybe created" },
    ) as Error & { status?: unknown; code?: unknown };
    expect(objectCauseFailure.message).toBe("[object Object]");
    expect(objectCauseFailure.status).toBe(409);
    expect(objectCauseFailure.code).toBe("operation_status_unknown");
  });

  it("recovers a post-create failure raised with a non-Error string cause", async () => {
    vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
    const file = join(tempDir(), "secrets.jsonl");
    const idempotency = testIdempotency("post-create-string-cause");

    await expect(
      executeDurableSecretOperation(
        durableSecretOptions(file, idempotency, {
          create: async () => {
            throw durableSecretPostCreateFailure(
              { applicationKey: "B2_MCP_CANARY_SECRET_post_create" },
              "torn provider response",
            );
          },
        }),
      ),
    ).rejects.toMatchObject({ status: 500, code: "secret_sink_projection_failed" });
  });

  it("rejects a parent that lstat reports as both a directory and a symlink", () => {
    const file = join(tempDir(), "nested", "secrets.jsonl");
    fsMock.overrides.lstatSync = () =>
      ({
        isDirectory: () => true,
        isSymbolicLink: () => true,
        uid: currentUid(),
        mode: 0o700,
      }) as unknown as fs.Stats;

    expect(() =>
      appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
        applicationKey: "B2_MCP_CANARY_SECRET_symlink_parent",
      }),
    ).toThrow(/parent must not be a symlink/);
  });

  it("propagates a non-ENOENT parent canonicalization failure for the log-file guard", () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const logFile = join(dir, "b2.log");
    fsMock.overrides["realpathSync.native"] = (target: unknown) => {
      if (String(target) === file) throw errno("ENOENT");
      if (String(target) === dir) throw errno("ENOTDIR");
      return fsMock.actual.realpathSync.native(target as fs.PathLike);
    };

    expect(() =>
      resolveSecretSinkConfig({
        transport: "stdio",
        env: { B2_SECRET_SINK: "file", B2_SECRET_SINK_FILE: file, B2_LOG_FILE: logFile },
        preflight: false,
      }),
    ).toThrow(/simulated ENOTDIR/);
  });

  it("skips the directory-fd close when the parent directory fsync open fails", () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    fsMock.overrides.openSync = (path: unknown, flags: unknown, mode?: unknown) => {
      if (typeof flags === "number" && (flags & O_DIRECTORY) !== 0) {
        throw errno("EACCES");
      }
      return fsMock.actual.openSync(
        path as fs.PathLike,
        flags as number,
        mode as fs.Mode | undefined,
      );
    };

    // The directory descriptor is never opened, so the finally block must not
    // dereference an undefined fd; the original EACCES is what surfaces.
    expect(() =>
      appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
        applicationKey: "B2_MCP_CANARY_SECRET_dir_open_fail",
      }),
    ).toThrow(/simulated EACCES/);
  });

  it("logs a pre-commit close failure that races a write failure", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    fs.writeFileSync(file, "", { mode: 0o600 });
    let realWrite!: (fd: number, buffer: Uint8Array, offset: number, length: number) => number;
    // Fail only the ledger-record write (identified by its canary secret), so
    // the append-lock write still succeeds and the ledger fd is reached.
    realWrite = setSinkWriteForTests((fd, buffer, offset, length) => {
      const text = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        .subarray(offset, offset + length)
        .toString("utf8");
      if (text.includes("B2_MCP_CANARY_SECRET_write_and_close_fail")) {
        throw new Error("simulated write failure");
      }
      return realWrite(fd, buffer, offset, length);
    });
    const restoreWrite = realWrite;
    vi.spyOn(secretSinkFileOpsForTests, "closeSync").mockImplementation(() => {
      throw new Error("simulated close failure");
    });

    try {
      expect(() =>
        appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
          applicationKey: "B2_MCP_CANARY_SECRET_write_and_close_fail",
        }),
      ).toThrow(/simulated write failure/);
    } finally {
      setSinkWriteForTests(restoreWrite);
    }

    expect(loggedCalls(warnSpy)).toContain("close_failed_before_commit");
  });

  it("omits undefined-valued fields when fingerprinting idempotent input", () => {
    const withUndefined = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "undefined-field",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: {
        keyName: "undefined-field",
        note: undefined,
        capabilities: ["listBuckets"],
      },
    });
    const withoutUndefined = durableSecretIdempotency({
      toolName: "b2_create_key",
      idempotencyKey: "undefined-field",
      callerFingerprint: "credential-fingerprint",
      normalizedInput: { keyName: "undefined-field", capabilities: ["listBuckets"] },
    });

    // An explicit `undefined` property is dropped by sortedJson, so the
    // fingerprint matches the object that never carried the field.
    expect(withUndefined.fingerprint).toBe(withoutUndefined.fingerprint);
  });

  it("truncates a trailing whitespace-only ledger fragment before reuse", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = testIdempotency("whitespace-tail");
    const pointer = appendSecretSinkRecord(
      { mode: "file", filePath: file },
      "b2_create_key",
      { applicationKeyId: "key-id", applicationKey: "B2_MCP_CANARY_SECRET_whitespace" },
      idempotency,
    );
    // A torn append that left only trailing whitespace after the last newline.
    fs.appendFileSync(file, "   ");
    let createCalls = 0;

    const result = await executeDurableSecretOperation(
      durableSecretOptions(file, idempotency, {
        create: async () => {
          createCalls++;
          return { applicationKey: "B2_MCP_CANARY_SECRET_duplicate" };
        },
      }),
    );

    expect(createCalls).toBe(0);
    expect(result.structuredContent).toMatchObject({
      applicationKeyId: "key-id",
      applicationKey: "[redacted]",
      secretSink: pointer,
    });
    expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    expect(loggedCalls(warnSpy)).toContain("incomplete_tail_truncated");
  });

  it("treats a vanished ledger as an empty tail during idempotency lookup", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    fs.writeFileSync(file, "", { mode: 0o600 });
    const idempotency = testIdempotency("vanished-ledger");
    fsMock.overrides.statSync = (path: unknown, options?: unknown) => {
      if (String(path) === file) throw errno("ENOENT");
      return fsMock.actual.statSync(path as fs.PathLike, options as fs.StatSyncOptions);
    };
    let createCalls = 0;

    const result = await executeDurableSecretOperation(
      durableSecretOptions(file, idempotency, {
        create: async () => {
          createCalls++;
          return {
            applicationKeyId: "key-id",
            applicationKey: "B2_MCP_CANARY_SECRET_vanished",
          };
        },
      }),
    );

    // ENOENT while reading the tail must fail safe to "no prior record" so the
    // provider create still runs and the secret is stored.
    expect(createCalls).toBe(1);
    expect(result.structuredContent).toMatchObject({
      applicationKeyId: "key-id",
      applicationKey: "[redacted]",
    });
  });

  it("retains a pending claim when the exclusive claim create loses an EEXIST race", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = testIdempotency("eexist-pending-race");
    const pendingPath = `${file}.${idempotency.claimFingerprint}${PENDING_CLAIM_MARKER_SUFFIX}`;
    let raced = false;
    fsMock.overrides.openSync = (path: unknown, flags: unknown, mode?: unknown) => {
      if (
        !raced &&
        String(path) === pendingPath &&
        typeof flags === "number" &&
        (flags & O_EXCL) !== 0
      ) {
        raced = true;
        // A concurrent worker created the same pending claim first.
        fsMock.actual.writeFileSync(pendingPath, `${JSON.stringify({ idempotency })}\n`, {
          mode: 0o600,
        });
        throw errno("EEXIST");
      }
      return fsMock.actual.openSync(
        path as fs.PathLike,
        flags as number,
        mode as fs.Mode | undefined,
      );
    };
    let createCalls = 0;

    await expect(
      executeDurableSecretOperation(
        durableSecretOptions(file, idempotency, {
          create: async () => {
            createCalls++;
            return { applicationKey: "B2_MCP_CANARY_SECRET_duplicate" };
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "idempotency_key_pending" });

    expect(createCalls).toBe(0);
    expect(raced).toBe(true);
  });

  it("rejects a conflicting pending claim that races claim creation", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = testIdempotency("eexist-conflict-race");
    const conflicting = testIdempotency("eexist-conflict-race", {
      keyName: "eexist-conflict-race",
      capabilities: ["listBuckets", "writeFiles"],
    });
    const pendingPath = `${file}.${idempotency.claimFingerprint}${PENDING_CLAIM_MARKER_SUFFIX}`;
    let raced = false;
    fsMock.overrides.openSync = (path: unknown, flags: unknown, mode?: unknown) => {
      if (
        !raced &&
        String(path) === pendingPath &&
        typeof flags === "number" &&
        (flags & O_EXCL) !== 0
      ) {
        raced = true;
        fsMock.actual.writeFileSync(
          pendingPath,
          `${JSON.stringify({ idempotency: conflicting })}\n`,
          { mode: 0o600 },
        );
        throw errno("EEXIST");
      }
      return fsMock.actual.openSync(
        path as fs.PathLike,
        flags as number,
        mode as fs.Mode | undefined,
      );
    };

    await expect(
      executeDurableSecretOperation(
        durableSecretOptions(file, idempotency, {
          create: async () => ({ applicationKey: "B2_MCP_CANARY_SECRET_duplicate" }),
        }),
      ),
    ).rejects.toMatchObject({ code: "idempotency_key_conflict" });
    expect(raced).toBe(true);
  });

  it("returns a committed record that races exclusive claim creation", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = testIdempotency("eexist-committed-race");
    const pendingPath = `${file}.${idempotency.claimFingerprint}${PENDING_CLAIM_MARKER_SUFFIX}`;
    const committedPath = `${file}.${idempotency.claimFingerprint}${COMMITTED_MARKER_SUFFIX}`;
    const pointer = { type: "file" as const, path: file, recordId: "raced-committed-record" };
    let raced = false;
    fsMock.overrides.openSync = (path: unknown, flags: unknown, mode?: unknown) => {
      if (
        !raced &&
        String(path) === pendingPath &&
        typeof flags === "number" &&
        (flags & O_EXCL) !== 0
      ) {
        raced = true;
        // A concurrent worker committed the same idempotency record first.
        fsMock.actual.writeFileSync(
          committedPath,
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
        throw errno("EEXIST");
      }
      return fsMock.actual.openSync(
        path as fs.PathLike,
        flags as number,
        mode as fs.Mode | undefined,
      );
    };
    let createCalls = 0;

    const result = await executeDurableSecretOperation(
      durableSecretOptions(file, idempotency, {
        create: async () => {
          createCalls++;
          return { applicationKey: "B2_MCP_CANARY_SECRET_duplicate" };
        },
      }),
    );

    expect(createCalls).toBe(0);
    expect(raced).toBe(true);
    expect(result.structuredContent).toMatchObject({
      applicationKeyId: "key-id",
      applicationKey: "[redacted]",
      secretSink: pointer,
    });
  });

  it("retries after a non-EEXIST reclaim-lock creation failure", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    fs.writeFileSync(file, "", { mode: 0o600 });
    const appendLock = `${file}.append.lock`;
    const reclaimLock = `${appendLock}.reclaim`;
    fs.writeFileSync(appendLock, `${JSON.stringify({ status: "appending" })}\n`, { mode: 0o600 });
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(appendLock, stale, stale);

    let reclaimOpenFailed = false;
    fsMock.overrides.openSync = (path: unknown, flags: unknown, mode?: unknown) => {
      if (
        !reclaimOpenFailed &&
        String(path) === reclaimLock &&
        typeof flags === "number" &&
        (flags & O_EXCL) !== 0
      ) {
        // First attempt to grab the reclaim lock hits a transient FS error;
        // acquireReclaimLock must warn and return null, and the append loop
        // must sleep and retry rather than crash.
        reclaimOpenFailed = true;
        throw errno("EACCES");
      }
      return fsMock.actual.openSync(
        path as fs.PathLike,
        flags as number,
        mode as fs.Mode | undefined,
      );
    };

    const pointer = appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
      applicationKey: "B2_MCP_CANARY_SECRET_reclaim_lock_failed",
    });

    expect(reclaimOpenFailed).toBe(true);
    expect(pointer.recordId).toEqual(expect.any(String));
    expect(fs.existsSync(appendLock)).toBe(false);
    expect(loggedCalls(warnSpy)).toContain("reclaim_lock_failed");
    expect(loggedCalls(warnSpy)).toContain("stale_append_lock_reclaimed");
  });

  it("retries after a non-ENOENT stat error while reading a lock identity", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    fs.writeFileSync(file, "", { mode: 0o600 });
    const appendLock = `${file}.append.lock`;
    fs.writeFileSync(appendLock, `${JSON.stringify({ status: "appending" })}\n`, { mode: 0o600 });
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(appendLock, stale, stale);

    let statThrown = false;
    fsMock.overrides.statSync = (path: unknown, options?: unknown) => {
      if (!statThrown && String(path) === appendLock) {
        // A transient stat error while reading the lock identity must bubble
        // out of readLockIdentity, be treated as "not reclaimable this pass",
        // and be retried rather than swallowed as a missing lock.
        statThrown = true;
        throw errno("EACCES");
      }
      return fsMock.actual.statSync(path as fs.PathLike, options as fs.StatSyncOptions);
    };

    const pointer = appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
      applicationKey: "B2_MCP_CANARY_SECRET_lock_stat_error",
    });

    expect(statThrown).toBe(true);
    expect(pointer.recordId).toEqual(expect.any(String));
    expect(fs.existsSync(appendLock)).toBe(false);
    expect(loggedCalls(warnSpy)).toContain("stale_append_lock_reclaimed");
  });

  it("treats a lock that vanishes mid-reclaim as not reclaimable this pass", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    fs.writeFileSync(file, "", { mode: 0o600 });
    const appendLock = `${file}.append.lock`;
    fs.writeFileSync(appendLock, `${JSON.stringify({ status: "appending" })}\n`, { mode: 0o600 });
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(appendLock, stale, stale);

    let statMissed = false;
    fsMock.overrides.statSync = (path: unknown, options?: unknown) => {
      if (!statMissed && String(path) === appendLock) {
        // The lock file disappeared between the EEXIST check and the identity
        // read; readLockIdentity must report null so the pass yields no reclaim
        // and the loop simply retries.
        statMissed = true;
        throw errno("ENOENT");
      }
      return fsMock.actual.statSync(path as fs.PathLike, options as fs.StatSyncOptions);
    };

    const pointer = appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
      applicationKey: "B2_MCP_CANARY_SECRET_lock_vanished",
    });

    expect(statMissed).toBe(true);
    expect(pointer.recordId).toEqual(expect.any(String));
    expect(fs.existsSync(appendLock)).toBe(false);
    expect(loggedCalls(warnSpy)).toContain("stale_append_lock_reclaimed");
  });

  it("scans circular and getter-only result graphs when logging a sink failure", async () => {
    vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
    const dir = tempDir();
    const file = join(dir, "secrets.jsonl");
    const idempotency = testIdempotency("circular-getter-result");
    const circular: Record<string, unknown> = {
      applicationKey: "B2_MCP_CANARY_SECRET_circular",
    };
    circular.self = circular;
    Object.defineProperty(circular, "lazy", {
      enumerable: true,
      get: () => "getter-value",
    });

    await expect(
      executeDurableSecretOperation(
        durableSecretOptions(file, idempotency, {
          create: async () => circular,
          projectRedacted: () => {
            throw new Error("projection boom");
          },
        }),
      ),
    ).rejects.toMatchObject({ status: 500, code: "secret_sink_projection_failed" });
  });
});
