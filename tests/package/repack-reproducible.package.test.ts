import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { join } from "path";
import { root } from "../contract/support";

const nodeRequire = createRequire(__filename);
const { npmInvocation } = nodeRequire("../../scripts/lib/retry-utils.cjs") as {
  npmInvocation: (args: string[]) => { command: string; args: string[] };
};

interface PackResult {
  tarball: string;
  integrity: string;
}

interface PackOptions {
  cwd?: string;
  ignoreScripts?: boolean;
}

function packageVersion(): string {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
}

function isPrerelease(version: string): boolean {
  return version.includes("-");
}

function sha256(path: string): string {
  return createHash("sha256")
    .update(new Uint8Array(readFileSync(path)))
    .digest("hex");
}

// Mirrors the publish workflow's pack flags (`npm pack --json --ignore-scripts`)
// so this reproduces exactly what prepare/publish do.
function pack(sourceArgs: string[], destDir: string, options: PackOptions = {}): PackResult {
  mkdirSync(destDir, { recursive: true });
  const ignoreScripts = options.ignoreScripts ?? true;
  const invocation = npmInvocation([
    "pack",
    ...sourceArgs,
    "--json",
    ...(ignoreScripts ? ["--ignore-scripts"] : []),
    "--pack-destination",
    destDir,
  ]);
  const stdout = execFileSync(invocation.command, invocation.args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const [meta] = JSON.parse(stdout) as Array<{ filename: string; integrity?: string }>;
  return { tarball: join(destDir, meta.filename), integrity: String(meta.integrity ?? "") };
}

function stampReleaseMarker(): void {
  execFileSync(
    process.execPath,
    ["scripts/write-release-version.mjs", "--version", packageVersion()],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
}

function removeReleaseMarker(): void {
  rmSync(join(root, "dist", "release-version.json"), { force: true });
}

const REPACK_TEST_TIMEOUT_MS = process.platform === "win32" ? 300_000 : 120_000;

// The publish job publishes from a staged directory (to avoid leaking the
// runner's local `.tgz` path into registry `_from`/`_resolved`) but must still
// prove the staged directory reproduces the exact scanned/attested tarball. That
// release tarball includes the published-channel marker, so this test exercises
// the same stamp -> pack -> extract -> repack -> compare path in CI. The publish
// job runs on Linux; reproducibility is asserted there, not for the Windows dev
// matrix.
describe.skipIf(process.platform === "win32")("packed package reproducibility", () => {
  it(
    "repacking the extracted tarball reproduces identical bytes and integrity",
    () => {
      const tmp = mkdtempSync(join(tmpdir(), "b2-mcp-repack-"));
      try {
        removeReleaseMarker();
        stampReleaseMarker();
        const first = pack([], join(tmp, "first"));
        const firstSha256 = sha256(first.tarball);

        const stageDir = join(tmp, "stage");
        mkdirSync(stageDir, { recursive: true });
        execFileSync("tar", ["-xzf", first.tarball, "-C", stageDir], { encoding: "utf8" });
        const markerPath = join(stageDir, "package/dist/release-version.json");
        const version = packageVersion();
        if (isPrerelease(version)) {
          expect(existsSync(markerPath)).toBe(false);
        } else {
          const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { version?: string };
          expect(marker.version).toBe(version);
        }

        const second = pack([join(stageDir, "package")], join(tmp, "second"));
        const secondSha256 = sha256(second.tarball);

        expect(secondSha256).toBe(firstSha256);
        expect(second.integrity).toBe(first.integrity);

        const third = pack([], join(tmp, "third"), {
          cwd: join(stageDir, "package"),
          ignoreScripts: false,
        });
        expect(sha256(third.tarball)).toBe(firstSha256);
        expect(third.integrity).toBe(first.integrity);
        expect(existsSync(markerPath)).toBe(false);
      } finally {
        removeReleaseMarker();
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    REPACK_TEST_TIMEOUT_MS,
  );
});
