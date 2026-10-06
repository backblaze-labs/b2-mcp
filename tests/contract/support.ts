import { readdirSync, readFileSync, statSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

export const root = join(__dirname, "../..");
const nodeRequire = createRequire(__filename);
const { readPackageManagerLock } = nodeRequire("../../scripts/lib/pnpm-lock.cjs") as {
  readPackageManagerLock: (root: string) => unknown;
};

export function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8")) as T;
}

export function readLock<T>(): T {
  return readPackageManagerLock(root) as T;
}

/**
 * Whether the pinned `@modelcontextprotocol/server` satisfies the peer range declared by the
 * installed `@modelcontextprotocol/node` adapter. The adapter is released on its own cadence, so
 * the dev SDK split is held to the adapter's declared compatibility rather than to an identical
 * version string. Throws on any range shape other than a plain caret range so a changed peer
 * declaration fails loudly instead of passing silently.
 */
export function serverAcceptedByNodeAdapter(serverVersion: string): boolean {
  const adapter = readJson<{ peerDependencies?: Record<string, string> }>(
    "node_modules/@modelcontextprotocol/node/package.json",
  );
  const range = adapter.peerDependencies?.["@modelcontextprotocol/server"];
  const match = range?.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Unsupported node adapter server peer range: ${String(range)}`);
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  const [vMajor, vMinor, vPatch] = serverVersion.split(".").map(Number) as [number, number, number];
  return vMajor === major && (vMinor > minor || (vMinor === minor && vPatch >= patch));
}

export function listFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? listFiles(path) : [path];
    })
    .sort();
}
