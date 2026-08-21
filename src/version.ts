import { readFileSync } from "fs";
import { join } from "path";

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

export function resolveBuildVersion(options: VersionResolutionOptions = {}): VersionResolution {
  const packageRoot = options.packageRoot ?? join(__dirname, "..");
  const runtimeDir = options.runtimeDir ?? __dirname;
  const pkg = readJson(join(packageRoot, "package.json"));
  const marker = readJson(join(runtimeDir, RELEASE_MARKER_FILE));
  const version = stringValue(pkg.version, "unknown");
  const isPublishedRelease =
    stringValue(pkg.name) === PACKAGE_NAME &&
    marker.name === pkg.name &&
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
