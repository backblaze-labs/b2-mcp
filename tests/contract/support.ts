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

export function listFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? listFiles(path) : [path];
    })
    .sort();
}
