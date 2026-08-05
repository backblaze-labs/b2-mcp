import { readFileSync } from "fs";
import { join } from "path";
import { root } from "./support";

type PackageLock = {
  packages: Record<string, { version?: string; peerDependencies?: Record<string, string> }>;
};

function versionAtLeast(actual: string, floor: string): boolean {
  const left = actual.split(".").map(Number);
  const right = floor.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function versionTuple(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Invalid semver version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function rangeFloor(range: string): string {
  const match = /(\d+\.\d+\.\d+)/.exec(range);
  if (!match) throw new Error(`Missing semver floor in range: ${range}`);
  return match[1];
}

describe("security dependency policy", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    overrides?: Record<string, string>;
  };
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as PackageLock;

  const resolvedVersion = (path: string): string => {
    const version = lock.packages[path]?.version;
    if (!version) throw new Error(`Missing lockfile version for ${path}`);
    return version;
  };

  const expectManifestAndLockAtLeast = (
    manifestRange: string,
    lockPath: string,
    floor: string,
    expectedMajor: number,
  ): void => {
    const manifestFloor = rangeFloor(manifestRange);
    expect(versionAtLeast(manifestFloor, floor)).toBe(true);
    expect(versionTuple(manifestFloor)[0]).toBe(expectedMajor);

    const lockedVersion = resolvedVersion(lockPath);
    expect(versionAtLeast(lockedVersion, floor)).toBe(true);
    expect(versionTuple(lockedVersion)[0]).toBe(expectedMajor);
  };

  it("excludes the vulnerable MCP Node adapter from the published graph", () => {
    expect(pkg.dependencies).not.toHaveProperty("@modelcontextprotocol/node");
    expect(lock.packages["node_modules/@modelcontextprotocol/node"]).toBeUndefined();
    expect(lock.packages["node_modules/@hono/node-server"]).toBeUndefined();
    expect(pkg.overrides ?? {}).not.toHaveProperty("hono");
  });

  it("keeps every brace-expansion resolution above its advisory floor", () => {
    const versions = Object.entries(lock.packages)
      .filter(([path]) => path.endsWith("node_modules/brace-expansion"))
      .map(([, entry]) => entry.version)
      .filter((version): version is string => Boolean(version));

    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      const major = Number(version.split(".")[0]);
      expect(versionAtLeast(version, major === 1 ? "1.1.18" : "5.0.9")).toBe(true);
    }
  });

  it("keeps vulnerable YAML and Babel transitive packages patched", () => {
    expect(versionAtLeast(resolvedVersion("node_modules/js-yaml"), "3.15.0")).toBe(true);
    expect(versionAtLeast(resolvedVersion("node_modules/@babel/core"), "7.29.1")).toBe(true);
  });

  it("includes the consolidated safe direct dependency updates", () => {
    expectManifestAndLockAtLeast(
      pkg.dependencies["@aws-sdk/client-s3"],
      "node_modules/@aws-sdk/client-s3",
      "3.1103.0",
      3,
    );
    expectManifestAndLockAtLeast(
      pkg.dependencies["@aws-sdk/s3-request-presigner"],
      "node_modules/@aws-sdk/s3-request-presigner",
      "3.1103.0",
      3,
    );
    expectManifestAndLockAtLeast(pkg.dependencies.axios, "node_modules/axios", "1.19.0", 1);
    expectManifestAndLockAtLeast(
      pkg.devDependencies["@babel/plugin-transform-modules-commonjs"],
      "node_modules/@babel/plugin-transform-modules-commonjs",
      "7.29.7",
      7,
    );
  });

  it("keeps TypeScript inside the eslint toolchain peer window", () => {
    const range = pkg.devDependencies.typescript;
    const [major, minor] = versionTuple(rangeFloor(range));
    expect(versionAtLeast(rangeFloor(range), "6.0.3")).toBe(true);
    expect([major, minor]).toEqual([6, 0]);
    expect(range).toMatch(/^~?6\.0\.\d+$/);

    const lockedVersion = resolvedVersion("node_modules/typescript");
    expect(versionAtLeast(lockedVersion, "6.0.3")).toBe(true);
    expect(versionTuple(lockedVersion).slice(0, 2)).toEqual([6, 0]);
    expect(
      lock.packages["node_modules/@typescript-eslint/parser"]?.peerDependencies?.typescript,
    ).toContain("<6.1.0");
  });
});
