import {
  existsSync,
  fstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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
  dir = mkdtempSync(join(tmpdir(), "b2-ledger-policy-"));
  file = join(dir, "secrets.jsonl");
  writeFileSync(file, "", { mode: 0o600 });
  vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
const sink = () => ({ mode: "file" as const, filePath: file });
const append = () => appendSecretSinkRecord(sink(), "b2_create_key", { label: "new-record" });
function fastWait(initial = Date.now(), releaseAfterWait = 2) {
  let now = initial;
  let waits = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(Atomics, "wait").mockImplementation(() => {
    now += 31_000;
    if (++waits === releaseAfterWait) {
      rmSync(`${file}.append.lock`, { force: true });
      rmSync(`${file}.append.lock.reclaim`, { force: true });
    }
    return "timed-out";
  });
}
function claim(name: string) {
  return durableSecretIdempotency({
    toolName: "b2_create_key",
    callerFingerprint: "ledger-owner",
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

it.each(["alive", "permission-denied"] as const)(
  "retains a foreign %s owner regardless of lock age",
  (state) => {
    const lock = `${file}.append.lock`;
    const owner = { pid: 987654321, token: "other-owner" };
    writeFileSync(lock, JSON.stringify(owner), { mode: 0o600 });
    const old = new Date(Date.now() - 600_000);
    utimesSync(lock, old, old);
    vi.spyOn(process, "kill").mockImplementation(() => {
      if (state === "permission-denied")
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      return true;
    });
    fastWait();
    expect(append).toThrow();
    expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual(owner);
    expect(readFileSync(file, "utf8")).toBe("");
  },
);

it("reclaims a fresh lock only when its recorded process is dead", () => {
  const lock = `${file}.append.lock`;
  writeFileSync(lock, JSON.stringify({ pid: 987654321, token: "dead-owner" }), { mode: 0o600 });
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  fastWait();
  const pointer = append();
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
    recordId: pointer.recordId,
    result: { label: "new-record" },
  });
  expect(existsSync(lock)).toBe(false);
});

it.each([0, -1, 1.5, "987654321"])(
  "does not treat invalid owner pid %j as a dead process",
  (pid) => {
    const lock = `${file}.append.lock`;
    writeFileSync(lock, JSON.stringify({ pid, token: "invalid-owner" }), { mode: 0o600 });
    fastWait();
    expect(append).toThrow();
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("");
  },
);

it("does not reclaim an ownerless lock at the exact stale-age boundary", () => {
  const lock = `${file}.append.lock`;
  const now = 1_800_000_000_000;
  writeFileSync(lock, "{}", { mode: 0o600 });
  const age = new Date(now - 300_000);
  utimesSync(lock, age, age);
  fastWait(now);
  expect(append).toThrow();
  expect(existsSync(lock)).toBe(true);
  expect(readFileSync(file, "utf8")).toBe("");
});

it("reclaims an ownerless lock just beyond the stale-age boundary", () => {
  const lock = `${file}.append.lock`;
  const now = 1_800_000_000_000;
  writeFileSync(lock, "{}", { mode: 0o600 });
  const age = new Date(now - 300_001);
  utimesSync(lock, age, age);
  fastWait(now);
  const pointer = append();
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ recordId: pointer.recordId });
  expect(existsSync(lock)).toBe(false);
});

it("does not unlink a replacement lock discovered during the stale-owner check", () => {
  const lock = `${file}.append.lock`;
  const replacement = { pid: 987654322, token: "replacement-owner" };
  writeFileSync(lock, JSON.stringify({ pid: 987654321, token: "old-owner" }), { mode: 0o600 });
  let replaced = false;
  vi.spyOn(process, "kill").mockImplementation(() => {
    if (!replaced) {
      replaced = true;
      writeFileSync(lock, JSON.stringify(replacement), { mode: 0o600 });
    }
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  fastWait();
  expect(append).toThrow();
  expect(replaced).toBe(true);
  expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual(replacement);
  expect(readFileSync(file, "utf8")).toBe("");
});

it("retains a live reclaim lock and its protected append candidate", () => {
  const lock = `${file}.append.lock`;
  const reclaim = `${lock}.reclaim`;
  writeFileSync(lock, JSON.stringify({ pid: 987654321, token: "dead-append" }), { mode: 0o600 });
  const owner = { pid: process.pid, token: "live-reclaimer" };
  writeFileSync(reclaim, JSON.stringify(owner), { mode: 0o600 });
  fastWait(Date.now(), 3);
  expect(append).toThrow();
  expect(JSON.parse(readFileSync(reclaim, "utf8"))).toEqual(owner);
  expect(existsSync(lock)).toBe(true);
  expect(readFileSync(file, "utf8")).toBe("");
});

it("keeps byte offsets correct for repeated short UTF-8 writes", () => {
  const payload = { label: "clé-🔑-日本語" };
  const previous = setSinkWriteForTests((fd, buffer, offset, length) =>
    writeSync(fd, buffer, offset, Math.min(length, 3)),
  );
  try {
    const pointer = appendSecretSinkRecord(sink(), "b2_create_key", payload);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      recordId: pointer.recordId,
      result: payload,
    });
  } finally {
    setSinkWriteForTests(previous);
  }
});

it("preserves complete ledger lines when a later append is rolled back", () => {
  const first = append();
  const bytes = readFileSync(file, "utf8");
  const sync = secretSinkFileOpsForTests.fsyncSync;
  let failed = false;
  vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
    if (!failed && !fstatSync(fd).isDirectory() && readFileSync(file, "utf8") !== bytes) {
      failed = true;
      throw new Error("record sync failed");
    }
    return sync(fd);
  });
  expect(append).toThrow("record sync failed");
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(JSON.parse(bytes).recordId).toBe(first.recordId);
  expect(existsSync(`${file}.append.lock`)).toBe(false);
});

it("replays a fully written final line after restoring its missing newline", async () => {
  const idempotency = claim("complete-tail");
  const pointer = appendSecretSinkRecord(
    sink(),
    "b2_create_key",
    { applicationKeyId: "retained-id", applicationKey: "synthetic-ledger-secret" },
    idempotency,
  );
  const original = readFileSync(file, "utf8");
  writeFileSync(file, original.trimEnd(), { mode: 0o600 });
  const create = vi.fn();
  const result = await executeDurableSecretOperation({ ...options(idempotency), create });
  expect(create).not.toHaveBeenCalled();
  expect(result.structuredContent).toMatchObject({
    applicationKeyId: "retained-id",
    applicationKey: "[redacted]",
    secretSink: pointer,
  });
  expect(readFileSync(file, "utf8")).toBe(original);
});

it("drops only the torn final bytes and preserves the complete preceding record", () => {
  const pointer = append();
  const original = readFileSync(file, "utf8");
  writeFileSync(file, original + '{"result":"interrupted', { mode: 0o600 });
  const next = append();
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0] + "\n").toBe(original);
  expect(JSON.parse(lines[0]).recordId).toBe(pointer.recordId);
  expect(JSON.parse(lines[1]).recordId).toBe(next.recordId);
});

it("appends after the live owner releases within the acquisition deadline", () => {
  const lock = `${file}.append.lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "finishing-owner" }), {
    mode: 0o600,
  });
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(Atomics, "wait").mockImplementation(() => {
    now += 20_000;
    rmSync(lock);
    return "timed-out";
  });
  const pointer = append();
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ recordId: pointer.recordId });
  expect(existsSync(lock)).toBe(false);
});
