import { existsSync, fstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSecretSinkRecord,
  durableSecretIdempotency,
  executeDurableSecretOperation,
  secretSinkFileOpsForTests,
  setSinkWriteForTests,
} from "../../src/utils/secret-sink";
import { logger } from "../../src/utils/logger";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b2-ledger-durable-"));
  file = join(dir, "secrets.jsonl");
  writeFileSync(file, "", { mode: 0o600 });
  vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
  vi.spyOn(logger, "fatal").mockImplementation(() => undefined as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
const sink = () => ({ mode: "file" as const, filePath: file });
function claim(name: string) {
  return durableSecretIdempotency({
    toolName: "b2_create_key",
    callerFingerprint: "durability-owner",
    idempotencyKey: name,
    normalizedInput: { name },
  });
}
function options(idempotency: ReturnType<typeof claim>) {
  return {
    secretSink: sink(),
    toolName: "b2_create_key",
    idempotency,
    projectRedacted: (result: Record<string, unknown>, pointer: unknown) => ({
      ...result,
      applicationKey: "[redacted]",
      secretSink: pointer,
    }),
    projectInline: (result: Record<string, unknown>) => result,
  };
}

it.each(["ordinary append", "complete tail", "torn tail"])(
  "closes the actual synchronized descriptors after %s",
  (state) => {
    if (state !== "ordinary append") {
      appendSecretSinkRecord(sink(), "b2_create_key", { label: "prior" });
      const previous = readFileSync(file, "utf8");
      writeFileSync(
        file,
        state === "complete tail" ? previous.trimEnd() : previous + '{"interrupted"',
        { mode: 0o600 },
      );
    }
    const descriptors = new Set<number>();
    const sync = secretSinkFileOpsForTests.fsyncSync;
    vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
      descriptors.add(fd);
      return sync(fd);
    });
    const pointer = appendSecretSinkRecord(sink(), "b2_create_key", { label: "new" });
    expect(readFileSync(file, "utf8")).toContain(pointer.recordId);
    expect(descriptors.size).toBeGreaterThan(0);
    for (const fd of descriptors)
      expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  },
);

it("closes the acquired descriptor when writing its lock record fails", () => {
  let descriptor: number | undefined;
  const failure = new Error("lock record write failed");
  const previousWrite = setSinkWriteForTests((fd) => {
    descriptor = fd;
    throw failure;
  });
  try {
    expect(() =>
      appendSecretSinkRecord(sink(), "b2_create_key", { label: "never committed" }),
    ).toThrow(failure);
  } finally {
    setSinkWriteForTests(previousWrite);
  }
  expect(descriptor).toEqual(expect.any(Number));
  expect(() => fstatSync(descriptor as number)).toThrow(expect.objectContaining({ code: "EBADF" }));
  expect(existsSync(`${file}.append.lock`)).toBe(false);
  expect(readFileSync(file, "utf8")).toBe("");
});

it("retains the provider claim when rollback bytes cannot be synchronized", async () => {
  const idempotency = claim("rollback-barrier");
  const secret = "synthetic-rollback-barrier-secret";
  const sync = secretSinkFileOpsForTests.fsyncSync;
  let recordFailed = false;
  let rollbackFailed = false;
  vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
    if (!fstatSync(fd).isDirectory()) {
      const bytes = readFileSync(file, "utf8");
      if (!recordFailed && bytes.includes(secret)) {
        recordFailed = true;
        throw new Error("record sync failed");
      }
      if (recordFailed && !rollbackFailed && bytes === "") {
        rollbackFailed = true;
        throw new Error("rollback sync failed");
      }
    }
    return sync(fd);
  });
  const recover = vi.fn(() => ({ status: "deleted" }));
  const create = vi.fn(async () => ({
    applicationKeyId: "retained-provider-key",
    applicationKey: secret,
  }));
  const operation = { ...options(idempotency), create, recoverAfterSinkFailure: recover };
  await expect(executeDurableSecretOperation(operation)).rejects.toMatchObject({
    code: "secret_sink_commit_ambiguous",
  });
  expect(recordFailed).toBe(true);
  expect(rollbackFailed).toBe(true);
  expect(existsSync(`${file}.${idempotency.claimFingerprint}.pending`)).toBe(true);
  await expect(executeDurableSecretOperation(operation)).rejects.toMatchObject({
    code: "idempotency_key_pending",
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(recover).not.toHaveBeenCalled();
});

it.each(["complete", "torn"])(
  "refuses a new append if the %s tail repair cannot be synchronized",
  (state) => {
    appendSecretSinkRecord(sink(), "b2_create_key", { label: "prior" });
    const clean = readFileSync(file, "utf8");
    writeFileSync(file, state === "complete" ? clean.trimEnd() : clean + '{"interrupted"', {
      mode: 0o600,
    });
    const sync = secretSinkFileOpsForTests.fsyncSync;
    let failed = false;
    vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
      if (!failed && !fstatSync(fd).isDirectory() && readFileSync(file, "utf8") === clean) {
        failed = true;
        throw new Error("tail repair sync failed");
      }
      return sync(fd);
    });
    expect(() =>
      appendSecretSinkRecord(sink(), "b2_create_key", { label: "not committed" }),
    ).toThrow("tail repair sync failed");
    expect(failed).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(clean);
    expect(existsSync(`${file}.append.lock`)).toBe(false);
  },
);

it("retains committed replay after marker directory sync fails without compensating the provider", async () => {
  const idempotency = claim("marker-directory-barrier");
  const marker = `${file}.${idempotency.claimFingerprint}.committed.json`;
  const index = `${file}.idempotency.jsonl`;
  const sync = secretSinkFileOpsForTests.fsyncSync;
  let failed = false;
  vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
    if (!failed && fstatSync(fd).isDirectory() && existsSync(marker) && !existsSync(index)) {
      failed = true;
      throw new Error("marker directory sync failed");
    }
    return sync(fd);
  });
  const create = vi.fn(async () => ({
    applicationKeyId: "committed-key",
    applicationKey: "synthetic-marker-secret",
  }));
  const recover = vi.fn();
  const operation = { ...options(idempotency), create, recoverAfterSinkFailure: recover };
  await expect(executeDurableSecretOperation(operation)).rejects.toMatchObject({
    code: "secret_sink_replay_unavailable",
  });
  expect(failed).toBe(true);
  expect(existsSync(`${file}.${idempotency.claimFingerprint}.pending`)).toBe(true);
  const committed = JSON.parse(readFileSync(marker, "utf8"));
  expect(committed.result).toMatchObject({
    applicationKeyId: "committed-key",
    applicationKey: "[redacted]",
  });
  const replay = await executeDurableSecretOperation(operation);
  expect(replay.structuredContent).toMatchObject({
    applicationKeyId: "committed-key",
    secretSink: committed.pointer,
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(recover).not.toHaveBeenCalled();
});
