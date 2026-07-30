/**
 * Drift guard for the official B2 SDK adoption contract.
 *
 * Issue #71 freezes a 40-tool SDK parity matrix. If the registered surface,
 * runtime import sites, or reviewed SDK version changes, this document must be
 * updated intentionally instead of drifting behind the implementation.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createServer } from "../../src/server";

const ROOT = join(__dirname, "../..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8")) as T;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("SDK adoption contract", () => {
  const contract = readFileSync(join(ROOT, "docs/SDK_ADOPTION_CONTRACT.md"), "utf8");

  it("pins the reviewed Backblaze SDK version exactly", () => {
    const pkg = readJson<{ dependencies: Record<string, string> }>("package.json");
    const lock = readJson<{
      packages: Record<string, { version?: string }>;
    }>("package-lock.json");

    expect(pkg.dependencies["@backblaze-labs/b2-sdk"]).toBe("0.2.0");
    expect(lock.packages["node_modules/@backblaze-labs/b2-sdk"]?.version).toBe("0.2.0");
  });

  it("has one matrix row for every registered tool", () => {
    const config = {
      applicationKeyId: "test",
      applicationKey: "test",
      appKeyId: "test",
      appKey: "test",
      masterKeyId: "test",
      masterKey: "test",
      region: "us-west-004",
      allowLocalFiles: true,
      fileRoot: null,
    };
    const server = createServer(config);
    const registered = Object.keys((server as any)._registeredTools ?? {}).sort();
    const matrixRows = [...contract.matchAll(/^\| `((?:b2|s3)_[a-z0-9_]+)`\s+\|/gm)].map(
      (match) => match[1],
    );

    expect(matrixRows).toHaveLength(40);
    expect([...new Set(matrixRows)].sort()).toEqual(registered);
  });

  it("inventories every runtime Axios and AWS SDK import site", () => {
    const sites = [
      ["src/auth.ts", "axios"],
      ["src/b2/client.ts", "axios"],
      ["src/utils/user-agent.ts", "axios"],
      ["src/s3/client.ts", "@aws-sdk/client-s3"],
      ["src/s3/buckets.ts", "@aws-sdk/client-s3"],
      ["src/s3/objects.ts", "@aws-sdk/client-s3"],
      ["src/s3/multipart.ts", "@aws-sdk/client-s3"],
      ["src/s3/multipart.ts", "@aws-sdk/s3-request-presigner"],
      ["src/s3/presigned.ts", "@aws-sdk/client-s3"],
      ["src/s3/presigned.ts", "@aws-sdk/s3-request-presigner"],
      ["src/s3/extras.ts", "@aws-sdk/client-s3"],
      ["src/b2/insights.ts", "@aws-sdk/client-s3"],
    ];

    for (const [file, pkg] of sites) {
      expect(contract).toMatch(
        new RegExp(`\\\`${escapeRegExp(file)}\\\`[^\\n]+\\\`${escapeRegExp(pkg)}\\\``),
      );
    }
  });

  it("links the upstream SDK gaps and the #49 release gate", () => {
    expect(contract).toContain("backblaze-labs/b2-sdk-typescript/issues/153");
    expect(contract).toContain("backblaze-labs/b2-sdk-typescript/issues/154");
    expect(contract).toContain("github.com/backblaze-labs/b2-mcp/issues/49");
  });
});
