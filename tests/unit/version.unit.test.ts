import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RELEASE_CHANNEL, productVersion, resolveBuildVersion } from "../../src/version";

const packageName = "@backblaze-labs/b2-mcp";

function withVersionFixture(
  version: string,
  run: (fixture: { packageRoot: string; runtimeDir: string }) => void,
): void {
  const packageRoot = mkdtempSync(join(tmpdir(), "b2-mcp-version-"));
  try {
    const runtimeDir = join(packageRoot, "dist");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      `${JSON.stringify({ name: packageName, version }, null, 2)}\n`,
    );
    run({ packageRoot, runtimeDir });
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
}

function writeMarker(runtimeDir: string, version: string): void {
  writeFileSync(
    join(runtimeDir, "release-version.json"),
    `${JSON.stringify({ name: packageName, releaseChannel: "published", version }, null, 2)}\n`,
  );
}

describe("build version resolution", () => {
  it("reports dev from the source checkout without a release marker", () => {
    expect(RELEASE_CHANNEL).toBe("dev");
    expect(productVersion()).toBe("dev");
  });

  it("resolves a stable published release from the marker file", () => {
    withVersionFixture("1.2.3", ({ packageRoot, runtimeDir }) => {
      writeMarker(runtimeDir, "1.2.3");

      expect(resolveBuildVersion({ packageRoot, runtimeDir })).toEqual({
        version: "1.2.3",
        releaseChannel: "published",
        isPublishedRelease: true,
      });
    });
  });

  it("defaults to dev without relying on package.json version alone", () => {
    withVersionFixture("1.2.3", ({ packageRoot, runtimeDir }) => {
      expect(resolveBuildVersion({ packageRoot, runtimeDir })).toEqual({
        version: "1.2.3",
        releaseChannel: "dev",
        isPublishedRelease: false,
      });
    });
  });

  it("keeps prerelease builds on the dev channel even when marked", () => {
    withVersionFixture("1.2.3-rc.1", ({ packageRoot, runtimeDir }) => {
      writeMarker(runtimeDir, "1.2.3-rc.1");

      const resolved = resolveBuildVersion({ packageRoot, runtimeDir });

      expect(resolved.version).toBe("1.2.3-rc.1");
      expect(resolved.releaseChannel).toBe("dev");
      expect(resolved.isPublishedRelease).toBe(false);
    });
  });

  it("ignores stale release markers from another version", () => {
    withVersionFixture("1.2.3", ({ packageRoot, runtimeDir }) => {
      writeMarker(runtimeDir, "1.2.2");

      expect(resolveBuildVersion({ packageRoot, runtimeDir }).releaseChannel).toBe("dev");
      expect(readFileSync(join(runtimeDir, "release-version.json"), "utf8")).toContain("1.2.2");
    });
  });
});
