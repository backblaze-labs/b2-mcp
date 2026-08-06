import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import { listFiles, readLock, root } from "./support";

type PackageLock = {
  packages: Record<
    string,
    { dev?: boolean; version?: string; peerDependencies?: Record<string, string> }
  >;
};

const nodeRequire = createRequire(__filename);
const { yamlBlockForKey } = nodeRequire("../../scripts/lib/workflow-yaml.cjs") as {
  yamlBlockForKey: (text: string, key: string) => string | null;
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
  const lock = readLock<PackageLock>();

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

  it("keeps the MCP Node adapter out of the published graph while pinning the dev SDK split", () => {
    expect(pkg.dependencies).not.toHaveProperty("@modelcontextprotocol/node");
    expect(pkg.devDependencies["@modelcontextprotocol/node"]).toBe(
      pkg.dependencies["@modelcontextprotocol/server"],
    );
    expect(lock.packages["node_modules/@modelcontextprotocol/node"]?.version).toBe(
      pkg.devDependencies["@modelcontextprotocol/node"],
    );
    expect(lock.packages["node_modules/@modelcontextprotocol/node"]?.dev).toBe(true);
    expect(pkg.overrides?.["@hono/node-server"]).toBe("2.0.10");
    expect(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")).toContain(
      "'@hono/node-server': 2.0.10",
    );
    expect(lock.packages["node_modules/@hono/node-server"]?.version).toBe("2.0.10");
    expect(lock.packages["node_modules/@hono/node-server"]?.dev).toBe(true);
    expect(pkg.overrides ?? {}).not.toHaveProperty("hono");
  });

  it("keeps the B2 SDK simulator out of production source and built output", () => {
    const dist = join(root, "dist");
    const productionFiles = [
      ...listFiles(join(root, "src")),
      ...(existsSync(dist) ? listFiles(dist) : []),
    ].filter((path) => /\.(?:c|m)?[jt]s$/.test(path) && !path.endsWith(".d.ts"));

    for (const path of productionFiles) {
      const text = readFileSync(path, "utf8");
      expect(text, path).not.toMatch(
        /(?:from\s+|import\s*\(|require\s*\()\s*["']@backblaze-labs\/b2-sdk\/simulator["']/,
      );
      expect(text, path).not.toContain("B2_MCP_TEST_SDK_SIMULATOR");
    }
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

  it("does not reintroduce the removed Jest transform stack", () => {
    for (const packageName of [
      "@babel/plugin-transform-modules-commonjs",
      "@types/jest",
      "babel-jest",
      "jest",
      "jest-junit",
      "ts-jest",
    ]) {
      expect(pkg.devDependencies).not.toHaveProperty(packageName);
      expect(lock.packages[`node_modules/${packageName}`]).toBeUndefined();
    }
    expect(lock.packages["node_modules/@babel/core"]).toBeUndefined();
    expect(versionAtLeast(resolvedVersion("node_modules/js-yaml"), "4.1.1")).toBe(true);
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
    expect(pkg.dependencies).not.toHaveProperty("axios");
    expect(lock.packages["node_modules/axios"]).toBeUndefined();
  });

  it("keeps Dependabot updates cooled down and leaves majors separate", () => {
    const dependabot = readFileSync(join(root, ".github/dependabot.yml"), "utf8");

    function groupBlock(group: string): string {
      const block = yamlBlockForKey(dependabot, group);
      if (block === null) throw new Error(`Missing Dependabot group ${group}`);
      return block;
    }

    function dependencyIgnoreBlock(dependencyName: string): string {
      const escaped = dependencyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = dependabot.match(
        new RegExp(
          `-\\s+dependency-name:\\s+["']?${escaped}["']?[\\s\\S]*?(?=\\n\\s*-\\s+dependency-name:|\\n\\s{2}-\\s+package-ecosystem:|\\s*$)`,
        ),
      );
      if (!match) throw new Error(`Missing Dependabot ignore for ${dependencyName}`);
      return match[0];
    }

    expect(dependabot).toContain("package-ecosystem: npm");
    expect(dependabot).toContain("package-ecosystem: github-actions");
    expect(dependabot).toContain("semver-major-days: 7");
    expect(dependabot).toContain("semver-minor-days: 3");
    expect(dependabot).toContain("semver-patch-days: 3");
    expect(dependabot).toContain("default-days: 3");

    for (const group of [
      "b2-sdk",
      "toon-format",
      "aws-sdk",
      "dev-dependencies",
      "github-actions-minor-patch",
    ]) {
      const block = groupBlock(group);
      expect(block, `${group} should include update-types`).toContain("update-types:");
      expect(block, `${group} should include minor updates`).toContain("- minor");
      expect(block, `${group} should include patch updates`).toContain("- patch");
      expect(block, `${group} must not group major updates`).not.toContain("- major");
    }

    for (const dependencyName of ["opossum", "@types/node", "@toon-format/toon"]) {
      const block = dependencyIgnoreBlock(dependencyName);
      expect(block).toContain("version-update:semver-major");
    }
  });

  it("keeps TypeScript on the reviewed 6.0 patch line", () => {
    const range = pkg.devDependencies.typescript;
    const [major, minor] = versionTuple(rangeFloor(range));
    expect(versionAtLeast(rangeFloor(range), "6.0.3")).toBe(true);
    expect([major, minor]).toEqual([6, 0]);
    expect(range).toMatch(/^~?6\.0\.\d+$/);

    const lockedVersion = resolvedVersion("node_modules/typescript");
    expect(versionAtLeast(lockedVersion, "6.0.3")).toBe(true);
    expect(versionTuple(lockedVersion).slice(0, 2)).toEqual([6, 0]);
  });
});
