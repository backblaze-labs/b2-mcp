import { readFileSync } from "fs";
import { join } from "path";
import { root } from "./support";

type PackageLock = {
  packages: Record<string, { version?: string }>;
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

describe("security dependency policy", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as PackageLock;

  const resolvedVersion = (path: string): string => {
    const version = lock.packages[path]?.version;
    if (!version) throw new Error(`Missing lockfile version for ${path}`);
    return version;
  };

  it("excludes the vulnerable MCP Node adapter from the published graph", () => {
    expect(pkg.dependencies).not.toHaveProperty("@modelcontextprotocol/node");
    expect(lock.packages["node_modules/@modelcontextprotocol/node"]).toBeUndefined();
    expect(lock.packages["node_modules/@hono/node-server"]).toBeUndefined();
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
    expect(pkg.dependencies["@aws-sdk/client-s3"]).toBe("^3.1103.0");
    expect(pkg.dependencies["@aws-sdk/s3-request-presigner"]).toBe("^3.1103.0");
    expect(pkg.dependencies.axios).toBe("^1.19.0");
    expect(pkg.devDependencies.typescript).toBe("^6.0.3");
    expect(pkg.devDependencies["@babel/plugin-transform-modules-commonjs"]).toBe("7.29.7");
  });
});
