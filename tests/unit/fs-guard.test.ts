/**
 * Tests for the filesystem sandbox (resolveLocalPath). Covers the policy
 * switch (allowLocalFiles), the unrestricted mode, sandbox-root containment for
 * both read and write, and symlink escape attempts.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveLocalPath, FileAccessError } from "../../src/utils/fs-guard";
import { B2Config } from "../../src/utils/types";

const baseConfig: B2Config = {
  applicationKeyId: "k",
  applicationKey: "s",
  appKeyId: "k",
  appKey: "s",
  masterKeyId: "s",
  masterKey: "s",
  region: "us-west-004",
  largeFileThreshold: 1e8,
  partSize: 1e8,
  allowLocalFiles: true,
  fileRoot: null,
};

let root: string;
let outside: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "b2-root-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "b2-out-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("resolveLocalPath — policy switch", () => {
  it("throws FileAccessError when local files are disabled", () => {
    const cfg = { ...baseConfig, allowLocalFiles: false };
    expect(() => resolveLocalPath(cfg, "/tmp/whatever", "read")).toThrow(FileAccessError);
    expect(() => resolveLocalPath(cfg, "/tmp/whatever", "write")).toThrow(/disabled/i);
  });

  it("returns the resolved absolute path when unrestricted (no fileRoot)", () => {
    const f = path.join(root, "a.txt");
    fs.writeFileSync(f, "hi");
    // Unrestricted mode returns the lexically-resolved path (no symlink resolution).
    expect(resolveLocalPath(baseConfig, f, "read")).toBe(path.resolve(f));
    // write of a non-existent path is still allowed and normalized
    expect(resolveLocalPath(baseConfig, path.join(root, "x/y.txt"), "write")).toBe(
      path.resolve(root, "x/y.txt"),
    );
  });
});

describe("resolveLocalPath — sandbox root", () => {
  it("allows a read of a file inside the root", () => {
    const cfg = { ...baseConfig, fileRoot: root };
    const f = path.join(root, "inside.txt");
    fs.writeFileSync(f, "data");
    expect(resolveLocalPath(cfg, f, "read")).toBe(fs.realpathSync(f));
  });

  it("rejects a read of a file outside the root", () => {
    const cfg = { ...baseConfig, fileRoot: root };
    const f = path.join(outside, "secret.txt");
    fs.writeFileSync(f, "secret");
    expect(() => resolveLocalPath(cfg, f, "read")).toThrow(/outside the allowed directory/i);
  });

  it("rejects a read of a non-existent file", () => {
    const cfg = { ...baseConfig, fileRoot: root };
    expect(() => resolveLocalPath(cfg, path.join(root, "nope.txt"), "read")).toThrow(/not found/i);
  });

  it("rejects a traversal escape via ..", () => {
    const cfg = { ...baseConfig, fileRoot: root };
    const escape = path.join(root, "..", path.basename(outside), "secret.txt");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    expect(() => resolveLocalPath(cfg, escape, "read")).toThrow(FileAccessError);
  });

  it("allows a write to a new nested path inside the root", () => {
    const cfg = { ...baseConfig, fileRoot: root };
    const dest = path.join(root, "sub/dir/out.bin");
    // Returned path is mapped onto the real root (resolves /tmp → /private/tmp etc.).
    expect(resolveLocalPath(cfg, dest, "write")).toBe(
      path.join(fs.realpathSync(root), "sub/dir/out.bin"),
    );
  });

  it("rejects a write outside the root", () => {
    const cfg = { ...baseConfig, fileRoot: root };
    expect(() => resolveLocalPath(cfg, path.join(outside, "out.bin"), "write")).toThrow(
      FileAccessError,
    );
  });

  it("rejects a read that escapes the root through a symlink", () => {
    const cfg = { ...baseConfig, fileRoot: root };
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "secret");
    const link = path.join(root, "link.txt");
    fs.symlinkSync(secret, link);
    // The path is lexically inside root, but realpath resolves outside it.
    expect(() => resolveLocalPath(cfg, link, "read")).toThrow(/outside the allowed directory/i);
  });

  it("rejects a write whose existing ancestor symlinks outside the root", () => {
    const cfg = { ...baseConfig, fileRoot: root };
    const linkDir = path.join(root, "evil");
    fs.symlinkSync(outside, linkDir); // root/evil -> outside
    expect(() => resolveLocalPath(cfg, path.join(linkDir, "out.bin"), "write")).toThrow(
      FileAccessError,
    );
  });
});
