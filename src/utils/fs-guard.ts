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
 * Report whether an already resolved path is inside the sandbox root without
 * resolving it again, as for a path the kernel reported for an open descriptor.
 *
 * @param config - Server configuration carrying the optional sandbox root.
 * @param realPath - Absolute path with every symlink already resolved.
 *
 * @returns True when no sandbox root is configured or the path is inside it.
 *
 * @throws FileAccessError when the configured sandbox root does not exist.
 */
export function isInsideFileRoot(config: B2Config, realPath: string): boolean {
  if (!config.fileRoot) return true;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(path.resolve(config.fileRoot));
  } catch {
    throw new FileAccessError(`Configured sandbox root does not exist: ${config.fileRoot}`);
  }
  return isInside(realRoot, realPath);
}

const ignoreError = (): undefined => undefined;

/**
 * Report whether a file opened from a validated path is inside the sandbox
 * root; Node has no `openat`, so the path can change before the open. Uses
 * `/proc` on Linux when readable; otherwise the path is resolved again, which
 * narrows that window without closing it.
 *
 * @param config - Server configuration carrying the optional sandbox root.
 * @param handle - Descriptor opened from `openedPath`.
 * @param openedPath - Path the descriptor was opened from.
 * @param requireSoleLink - When the path is resolved again, require one hard link.
 *
 * @returns True when no sandbox root is configured or the file is inside it.
 *
 * @throws FileAccessError when the configured sandbox root does not exist.
 */
export async function isOpenedInsideFileRoot(
  config: B2Config,
  handle: fs.promises.FileHandle,
  openedPath: string,
  requireSoleLink: boolean,
): Promise<boolean> {
  if (!config.fileRoot) return true;
  let realPath: string | undefined;
  if (process.platform === "linux") {
    realPath = await fs.promises.readlink(`/proc/self/fd/${handle.fd}`).catch(ignoreError);
  }
  if (realPath === undefined) {
    // bigint: NTFS file IDs can exceed 2^53.
    const opened = await handle.stat({ bigint: true });
    // JS resolver, as for the root: the native one can differ (macOS case, SUBST).
    let resolved: string | undefined;
    try {
      resolved = fs.realpathSync(openedPath);
    } catch {
      resolved = undefined;
    }
    const onDisk = resolved
      ? await fs.promises.stat(resolved, { bigint: true }).catch(ignoreError)
      : undefined;
    if (
      onDisk?.dev === opened.dev &&
      onDisk.ino === opened.ino &&
      (!requireSoleLink || opened.nlink === 1n)
    )
      realPath = resolved;
  }
  return realPath !== undefined && isInsideFileRoot(config, realPath);
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
