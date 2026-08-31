/**
 * Local filesystem policy enforcement for tool read and write paths.
 *
 * @packageDocumentation
 */
import * as fs from "fs";
import * as path from "path";
import { B2Config } from "./types.js";

/**
 * Raised when a tool requests local filesystem access that policy forbids —
 * either because disk access is disabled entirely (the HTTP default) or
 * because the path escapes the configured sandbox root.
 */
export class FileAccessError extends Error {
  /**
   * Create a local filesystem policy error.
   *
   * @param message - Human-readable policy failure message.
   */
  constructor(message: string) {
    super(message);
    this.name = "FileAccessError";
  }
}

/** True if `target` is `root` itself or lives somewhere beneath it. */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Map a (possibly not-yet-existing) absolute path onto the real path of its
 * nearest existing ancestor. This resolves symlinks in the existing portion —
 * so a symlinked ancestor can't redirect a write outside the root, and platform
 * symlinks (e.g. macOS /tmp → /private/tmp) don't cause false mismatches.
 */
function realTargetForWrite(resolved: string): string {
  let dir = resolved;
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    realDir = dir;
  }
  const tail = path.relative(dir, resolved);
  return tail ? path.resolve(realDir, tail) : realDir;
}

/**
 * Validate a caller-supplied local file path against the server's filesystem
 * policy and return a safe absolute path to use. Throws FileAccessError when
 * access is disabled or the path escapes the sandbox root.
 *
 * - `read`: the file must exist; its real path (symlinks resolved) must be
 *   inside the root.
 * - `write`: the file need not exist yet, but its resolved path and nearest
 *   existing ancestor must both be inside the root, so symlinked ancestors
 *   can't redirect the write outside.
 *
 * @param config - Runtime filesystem policy from server configuration.
 * @param userPath - Caller-supplied path to validate.
 * @param mode - Whether the caller intends to read or write the path.
 *
 * @returns The safe absolute path to use for the requested access.
 *
 * @throws FileAccessError when local file access is disabled or outside policy.
 */
export function resolveLocalPath(
  config: B2Config,
  userPath: string,
  mode: "read" | "write",
): string {
  if (!config.allowLocalFiles) {
    throw new FileAccessError(
      "Local filesystem access is disabled on this server. " +
        "Provide base64 `content` instead of a local file path.",
    );
  }

  const resolved = path.resolve(userPath);

  // Unrestricted mode (trusted local stdio): no root to enforce.
  if (!config.fileRoot) return resolved;

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(path.resolve(config.fileRoot));
  } catch {
    throw new FileAccessError(`Configured sandbox root does not exist: ${config.fileRoot}`);
  }

  if (mode === "read") {
    let real: string;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      throw new FileAccessError(`Path not found or inaccessible: ${userPath}`);
    }
    if (!isInside(realRoot, real)) {
      throw new FileAccessError(`Path is outside the allowed directory (${config.fileRoot}).`);
    }
    return real;
  }

  // write — the file may not exist yet.
  const finalReal = realTargetForWrite(resolved);
  if (!isInside(realRoot, finalReal)) {
    throw new FileAccessError(`Path is outside the allowed directory (${config.fileRoot}).`);
  }
  return finalReal;
}
