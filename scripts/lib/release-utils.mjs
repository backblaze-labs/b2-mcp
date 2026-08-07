import path from "node:path";
import { fileURLToPath } from "node:url";

export const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function releaseRoot() {
  const configured = process.env.B2_MCP_RELEASE_ROOT;
  if (configured && process.env.NODE_ENV !== "test") {
    throw new Error("B2_MCP_RELEASE_ROOT is test-only");
  }
  return path.resolve(configured ?? defaultRoot);
}

export function npmDistTag(version) {
  const prerelease = String(version).split("-")[1];
  if (!prerelease) return "latest";
  const channel = prerelease.split(".")[0]?.toLowerCase();
  return ["alpha", "beta", "canary", "next", "rc"].includes(channel) ? channel : "next";
}
