import { existsSync } from "fs";
import { join } from "path";

export const ROOT = join(__dirname, "..");
export const DIST_INDEX = join(ROOT, "dist/index.js");
export const DIST_HTTP = join(ROOT, "dist/http-server.js");
export const SIMULATOR_ENTRYPOINT = join(ROOT, "tests/protocol/support/simulator-entrypoint.mjs");

const SAFE_ENV_NAMES = [
  "PATH",
  "Path",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
];

export function requireBuiltFiles(paths: string[], message: string): void {
  if (paths.some((path) => !existsSync(path))) {
    throw new Error(message);
  }
}

export function safeSpawnEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    SAFE_ENV_NAMES.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name] as string]],
    ),
  );
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    ...extra,
  };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

export function stringifySpawnEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
