import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSecretSinkRecord,
  DEFAULT_SECRET_SINK_PATH,
  INLINE_SECRET_WARNING,
  resetSecretSinkWarningForTests,
  resolveSecretSinkConfig,
  secretSinkFileOpsForTests,
} from "../../src/utils/secret-sink";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "b2-mcp-secret-sink-"));
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
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
});
