import { existsSync, fstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSecretSinkRecord, secretSinkFileOpsForTests } from "../../src/utils/secret-sink";
import { logger } from "../../src/utils/logger";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b2-ledger-lock-"));
  file = join(dir, "secrets.jsonl");
  writeFileSync(file, "", { mode: 0o600 });
  vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

it("releases its newly created append lock when directory sync fails", () => {
  const lock = `${file}.append.lock`;
  const failure = new Error("append lock directory sync failed");
  const sync = secretSinkFileOpsForTests.fsyncSync;
  let failed = false;
  vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
    if (!failed && fstatSync(fd).isDirectory() && existsSync(lock)) {
      failed = true;
      throw failure;
    }
    return sync(fd);
  });
  expect(() =>
    appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", { label: "first" }),
  ).toThrow(failure);
  expect(failed).toBe(true);
  expect(existsSync(lock)).toBe(false);
  expect(readFileSync(file, "utf8")).toBe("");
  const pointer = appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
    label: "retry",
  });
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
    recordId: pointer.recordId,
    result: { label: "retry" },
  });
});

it("releases its reclaim lock on directory sync failure without deleting the candidate", () => {
  const lock = `${file}.append.lock`;
  const reclaim = `${lock}.reclaim`;
  const owner = { pid: 987654321, token: "dead-owner" };
  writeFileSync(lock, JSON.stringify(owner), { mode: 0o600 });
  const sync = secretSinkFileOpsForTests.fsyncSync;
  const base = Date.now();
  let failed = false;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => (failed ? base + 31_000 : base));
  vi.spyOn(secretSinkFileOpsForTests, "fsyncSync").mockImplementation((fd) => {
    if (!failed && fstatSync(fd).isDirectory() && existsSync(reclaim)) {
      failed = true;
      throw new Error("reclaim directory sync failed");
    }
    return sync(fd);
  });
  expect(() =>
    appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", { label: "first" }),
  ).toThrow();
  expect(failed).toBe(true);
  expect(existsSync(reclaim)).toBe(false);
  expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual(owner);
  expect(readFileSync(file, "utf8")).toBe("");
  clock.mockRestore();
  const pointer = appendSecretSinkRecord({ mode: "file", filePath: file }, "b2_create_key", {
    label: "retry",
  });
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
    recordId: pointer.recordId,
    result: { label: "retry" },
  });
});
