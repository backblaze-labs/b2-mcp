/**
 * Tests for the filesystem sandbox (resolveLocalPath). Covers the policy
 * switch (allowLocalFiles), the unrestricted mode, sandbox-root containment for
 * both read and write, and symlink escape attempts.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileAccessError, isInsideFileRoot, resolveLocalPath } from "../../src/utils/fs-guard";
import { parseB2Error } from "../../src/utils/errors";
import { B2Config } from "../../src/utils/types";
import { expectDefect, knownDefect } from "../support/known-defect";

const baseConfig: B2Config = {
  applicationKeyId: "k",
  applicationKey: "s",
  appKeyId: "k",
  appKey: "s",
  masterKeyId: "s",
  masterKey: "s",
  region: "us-west-004",
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
    const escapedPath = path.join(root, "..", path.basename(outside), "secret.txt");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    expect(() => resolveLocalPath(cfg, escapedPath, "read")).toThrow(FileAccessError);
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

describe("isInsideFileRoot", () => {
  it("allows paths whose component begins with two dots", () => {
    const realRoot = fs.realpathSync(root);
    const cfg = { ...baseConfig, fileRoot: root };
    const file = path.join(realRoot, "..cache");
    fs.writeFileSync(file, "cache");
    expect(isInsideFileRoot(cfg, file)).toBe(true);
    expect(resolveLocalPath(cfg, file, "read")).toBe(file);
    expect(resolveLocalPath(cfg, file, "write")).toBe(file);
  });

  it("rejects the parent and paths under the parent", () => {
    const realRoot = fs.realpathSync(root);
    const cfg = { ...baseConfig, fileRoot: root };
    expect(isInsideFileRoot(cfg, path.dirname(realRoot))).toBe(false);
    expect(isInsideFileRoot(cfg, path.join(realRoot, "..", "outside.txt"))).toBe(false);
  });

  it("accepts any path when no sandbox root is configured", () => {
    expect(isInsideFileRoot(baseConfig, outside)).toBe(true);
  });

  it("compares a resolved path against the real root without resolving it again", () => {
    const rootLink = path.join(outside, "root-link");
    fs.symlinkSync(root, rootLink);
    const cfg = { ...baseConfig, fileRoot: rootLink };
    const realRoot = fs.realpathSync(rootLink);
    fs.symlinkSync(outside, path.join(root, "escape"));
    expect(isInsideFileRoot(cfg, realRoot)).toBe(true);
    expect(isInsideFileRoot(cfg, path.join(realRoot, "a", "b.txt"))).toBe(true);
    // Taken as already resolved: following `escape` again would leave the root.
    expect(isInsideFileRoot(cfg, path.join(realRoot, "escape", "f.txt"))).toBe(true);
    expect(isInsideFileRoot(cfg, fs.realpathSync(outside))).toBe(false);
    expect(isInsideFileRoot(cfg, `${realRoot}-sibling`)).toBe(false);
  });

  it("throws FileAccessError when the configured root is missing", () => {
    const cfg = { ...baseConfig, fileRoot: path.join(outside, "missing") };
    expect(() => isInsideFileRoot(cfg, outside)).toThrow(FileAccessError);
  });
});

describe("resolveLocalPath — refusal classification", () => {
  it.each([
    [
      "local files disabled",
      () => resolveLocalPath({ ...baseConfig, allowLocalFiles: false }, root, "read"),
    ],
    [
      "a read path that does not exist",
      () => resolveLocalPath({ ...baseConfig, fileRoot: root }, path.join(root, "nope"), "read"),
    ],
    [
      "a read outside the root",
      () => resolveLocalPath({ ...baseConfig, fileRoot: root }, outside, "read"),
    ],
    [
      "a missing sandbox root",
      () => resolveLocalPath({ ...baseConfig, fileRoot: path.join(root, "gone") }, root, "read"),
    ],
    [
      "a write outside the root",
      () =>
        resolveLocalPath({ ...baseConfig, fileRoot: root }, path.join(outside, "out.bin"), "write"),
    ],
  ])("classifies %s as bad_request", (_branch, refuse) => {
    let refusal: unknown;
    try {
      refuse();
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(FileAccessError);
    expect(parseB2Error(refusal)).toMatchObject({ code: "bad_request", status: 400 });
  });
});

describe("resolveLocalPath — sandbox names that begin with two dots (case C22)", () => {
  knownDefect(
    "Finding C22: allows a file inside a directory named '..cache' under the root",
    async () => {
      const dir = path.join(root, "..cache");
      fs.mkdirSync(dir);
      const file = path.join(dir, "data.bin");
      fs.writeFileSync(file, "x");
      const cfg = { ...baseConfig, fileRoot: root };

      // The defect is the sandbox wrongly refusing the path (FileAccessError) or reporting it
      // outside the root; any other error (a TypeError, or a FileAccessError for another reason) is not the defect.
      await expectDefect(
        () => {
          expect(resolveLocalPath(cfg, file, "read"), "read path resolves").toBe(
            fs.realpathSync(file),
          );
        },
        {
          match: (error) =>
            (error instanceof FileAccessError &&
              error.message.includes("outside the allowed directory")) ||
            (error as Error)?.name === "AssertionError",
        },
      );
      // Checked once the marker above is removed.
      expect(resolveLocalPath(cfg, path.join(dir, "new.bin"), "write"), "write path resolves").toBe(
        path.join(fs.realpathSync(dir), "new.bin"),
      );
      expect(isInsideFileRoot(cfg, fs.realpathSync(file)), "file is inside the root").toBe(true);
    },
  );

  it("Finding C22 guard: a path that really escapes the root through '..' is still refused", () => {
    const cfg = { ...baseConfig, fileRoot: root };
    expect(
      () => resolveLocalPath(cfg, path.join(root, "..", "elsewhere.bin"), "write"),
      "a real escape through '..' is refused",
    ).toThrow(FileAccessError);
  });
});
