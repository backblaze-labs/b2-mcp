import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Owner-read/write mode used for newly created append-only secret/log files. */
export const SECURE_APPEND_FILE_MODE = 0o600;
/** Permission mask used to reject group/other access on existing files. */
export const GROUP_OR_OTHER_PERMISSIONS = 0o077;

/** Options for opening an append file with owner-only permissions. */
export interface SecureAppendFileOptions {
  /** Environment variable whose value supplied the file path. */
  envVarName: string;
  /** Required file mode. Defaults to {@link SECURE_APPEND_FILE_MODE}. */
  mode?: number;
  /** Whether to chmod an existing file to the required mode before rejecting it. */
  tightenExistingPermissions?: boolean;
}

function hasCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && typeof err.code === "string" && err.code === code;
}

/**
 * Render an unknown file-open failure for startup diagnostics.
 *
 * @param err - Error thrown by fs operations.
 *
 * @returns Stable human-readable error detail.
 */
export function secureAppendFileErrorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = "code" in err && typeof err.code === "string" ? `${err.code}: ` : "";
  return `${code}${err.message}`;
}

function failSecureAppendFile(envVarName: string, message: string): never {
  throw new Error(`${envVarName} ${message}`);
}

function assertSecureAppendFilePlatformSupported(filePath: string, envVarName: string): void {
  if (process.platform === "win32") {
    failSecureAppendFile(
      envVarName,
      `is not supported on Windows because owner-only file permissions cannot be enforced: ${filePath}`,
    );
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function normalizeExistingAppendFile(
  filePath: string,
  fd: number,
  options: SecureAppendFileOptions,
): void {
  const mode = options.mode ?? SECURE_APPEND_FILE_MODE;
  let stats = fstatSync(fd);
  if (!stats.isFile()) {
    failSecureAppendFile(options.envVarName, `must point to a regular file: ${filePath}`);
  }
  if (stats.nlink > 1) {
    failSecureAppendFile(options.envVarName, `must not be a hard link: ${filePath}`);
  }

  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) {
    failSecureAppendFile(options.envVarName, `must be owned by the current user: ${filePath}`);
  }

  if ((stats.mode & GROUP_OR_OTHER_PERMISSIONS) !== 0) {
    if (options.tightenExistingPermissions === true) {
      fchmodSync(fd, mode);
      stats = fstatSync(fd);
    }
    if ((stats.mode & GROUP_OR_OTHER_PERMISSIONS) !== 0) {
      failSecureAppendFile(
        options.envVarName,
        `must not be readable or writable by group or other users: ${filePath}`,
      );
    }
  }
}

/**
 * Open a secure owner-only append file without following symlinks.
 *
 * @param filePath - Absolute file path to open or create.
 * @param options - Permission and diagnostic options.
 *
 * @returns File descriptor opened for append writes.
 *
 * @throws Error when the path is unsafe or cannot be opened securely.
 */
export function openSecureAppendFile(filePath: string, options: SecureAppendFileOptions): number {
  assertSecureAppendFilePlatformSupported(filePath, options.envVarName);
  if (!isAbsolute(filePath)) {
    failSecureAppendFile(options.envVarName, `must be an absolute path: ${filePath}`);
  }

  let fd: number | undefined;
  try {
    fd = openSync(
      filePath,
      constants.O_CREAT |
        constants.O_APPEND |
        constants.O_WRONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      options.mode ?? SECURE_APPEND_FILE_MODE,
    );
    normalizeExistingAppendFile(filePath, fd, options);
    return fd;
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    if (err instanceof Error && err.message.startsWith(`${options.envVarName} `)) {
      throw err;
    }
    if (hasCode(err, "ELOOP")) {
      failSecureAppendFile(options.envVarName, `must not be a symlink: ${filePath}`);
    }
    failSecureAppendFile(
      options.envVarName,
      `is not writable: ${filePath} (${secureAppendFileErrorDetail(err)})`,
    );
  }
}
