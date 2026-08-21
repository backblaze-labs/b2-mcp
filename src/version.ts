import { readFileSync } from "fs";
import { join } from "path";
import packageMetadata from "../package.json";

const PACKAGE_NAME = "@backblaze-labs/b2-mcp";
const RELEASE_MARKER_FILE = "release-version.json";
const STABLE_SEMVER = /^\d+\.\d+\.\d+$/;

export type ReleaseChannel = "published" | "dev";

type JsonRecord = Record<string, unknown>;

type VersionResolution = {
  version: string;
  releaseChannel: ReleaseChannel;
  isPublishedRelease: boolean;
};

type VersionResolutionOptions = {
  packageRoot?: string;
  runtimeDir?: string;
};

function readJson(path: string): JsonRecord {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function defaultRuntimeDir(): string {
  return typeof __dirname === "string" ? __dirname : ".";
}

export function resolveBuildVersion(options: VersionResolutionOptions = {}): VersionResolution {
  const runtimeDir = options.runtimeDir ?? defaultRuntimeDir();
  const packageRoot = options.packageRoot ?? join(runtimeDir, "..");
  const pkg = readJson(join(packageRoot, "package.json"));
  const marker = readJson(join(runtimeDir, RELEASE_MARKER_FILE));
  const packageName = stringValue(pkg.name, stringValue(packageMetadata.name));
  const version = stringValue(pkg.version, stringValue(packageMetadata.version, "unknown"));
  const isPublishedRelease =
    packageName === PACKAGE_NAME &&
    marker.name === packageName &&
    marker.releaseChannel === "published" &&
    marker.version === version &&
    STABLE_SEMVER.test(version);

  return {
    version,
    releaseChannel: isPublishedRelease ? "published" : "dev",
    isPublishedRelease,
  };
}

const resolution = resolveBuildVersion();

export const VERSION = resolution.version;
export const RELEASE_CHANNEL = resolution.releaseChannel;
export const isPublishedRelease = resolution.isPublishedRelease;

export function productVersion(): string {
  if (isPublishedRelease) return VERSION;
  return "dev";
}

/**
 * The binary/package product name emitted on outbound User-Agent headers.
 * Kept here so every SDK's UA construction derives the token from one place.
 */
export const PRODUCT_NAME = "b2-mcp";

/**
 * The outbound product token identifying this server to Backblaze:
 * `b2-mcp/<version>` on a published release, `b2-mcp/dev` otherwise.
 *
 * @returns The single product token shared by every SDK User-Agent.
 */
export function productToken(): string {
  return `${PRODUCT_NAME}/${productVersion()}`;
}
