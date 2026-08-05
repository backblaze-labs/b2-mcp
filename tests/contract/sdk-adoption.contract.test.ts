/**
 * Drift guard for the official B2 SDK adoption contract.
 *
 * Issue #71 freezes the SDK parity matrix. If the registered surface, runtime
 * import sites, or reviewed SDK version changes, this document must be updated
 * intentionally instead of drifting behind the implementation.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { createServer, getRegisteredTools } from "../../src/server";
import { DURABLE_SECRET_PRODUCING_TOOLS } from "../../src/utils/tool-capabilities";
import { readJson, root as ROOT } from "./support";

const SDK_VERSION = "0.2.0";
const SDK_RESOLVED = "https://registry.npmjs.org/@backblaze-labs/b2-sdk/-/b2-sdk-0.2.0.tgz";
const SDK_INTEGRITY =
  "sha512-qYjCVtFuiHp54R8okZbuG7oVU0U0Xj9A/Yn4VBLeMKp5JxVKFp3+M3Ywry+aB6ZKX24P3NTh8JURZMGuayFWDQ==";

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir)
    .map((name) => join(dir, name))
    .sort();
  const files: string[] = [];
  for (const entry of entries) {
    const stat = statSync(entry);
    if (stat.isDirectory()) files.push(...listSourceFiles(entry));
    else if (entry.endsWith(".ts")) files.push(entry);
  }
  return files;
}

function runtimeImportInventory(): string[] {
  const importRe =
    /(?:import\s+(?:[^'"]+\s+from\s+)?|export\s+[^'"]+\s+from\s+|require\()\s*["']([^"']+)["']/g;
  const found = new Set<string>();
  for (const file of listSourceFiles(join(ROOT, "src"))) {
    const rel = file.slice(ROOT.length + 1);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importRe)) {
      const specifier = match[1];
      if (specifier === "axios" || specifier.startsWith("@aws-sdk/")) {
        found.add(`${rel}|${specifier}`);
      }
    }
  }
  return [...found].sort();
}

function contractImportInventory(contract: string): string[] {
  const found = new Set<string>();
  for (const line of contract.split("\n")) {
    const row = line.match(/^\| `([^`]+)`\s+\| ([^|]+)\|/);
    if (!row || !row[1].startsWith("src/")) continue;
    const file = row[1];
    for (const match of row[2].matchAll(/`([^`]+)`/g)) {
      const specifier = match[1];
      if (specifier === "axios" || specifier.startsWith("@aws-sdk/")) {
        found.add(`${file}|${specifier}`);
      }
    }
  }
  return [...found].sort();
}

function parseFloor(value: string): [number, number, number] {
  const match = value.match(/^>=(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Unsupported engine floor: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareFloor(a: string, b: string): number {
  const left = parseFloor(a);
  const right = parseFloor(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

describe("SDK adoption contract", () => {
  const contract = readFileSync(join(ROOT, "docs/SDK_ADOPTION_CONTRACT.md"), "utf8");

  it("pins the reviewed Backblaze SDK package exactly", () => {
    const pkg = readJson<{
      dependencies: Record<string, string>;
      engines: { node: string };
    }>("package.json");
    const lock = readJson<{
      packages: Record<
        string,
        { version?: string; resolved?: string; integrity?: string; engines?: { node?: string } }
      >;
    }>("package-lock.json");
    const sdk = lock.packages["node_modules/@backblaze-labs/b2-sdk"];

    expect(pkg.dependencies["@backblaze-labs/b2-sdk"]).toBe(SDK_VERSION);
    expect(sdk?.version).toBe(SDK_VERSION);
    expect(sdk?.resolved).toBe(SDK_RESOLVED);
    expect(sdk?.integrity).toBe(SDK_INTEGRITY);
    expect(compareFloor(pkg.engines.node, sdk?.engines?.node ?? "")).toBeGreaterThanOrEqual(0);
  });

  it("has rows for every registered tool and only approved sink-blocked extras", () => {
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
    const registered = Object.keys(getRegisteredTools(server) ?? {}).sort();
    const matrixRows = [...contract.matchAll(/^\| `((?:b2|s3)_[a-z0-9_]+)`\s+\|/gm)].map(
      (match) => match[1],
    );
    const rowCounts = new Map<string, number>();
    for (const tool of matrixRows) rowCounts.set(tool, (rowCounts.get(tool) ?? 0) + 1);
    const duplicateRows = [...rowCounts]
      .filter(([, count]) => count > 1)
      .map(([tool]) => tool)
      .sort();
    const uniqueRows = [...rowCounts.keys()].sort();

    const registeredSet = new Set(registered);
    const extraRows = uniqueRows.filter((tool) => !registeredSet.has(tool)).sort();
    const approvedExtraRows = [...DURABLE_SECRET_PRODUCING_TOOLS]
      .filter((tool) => !registeredSet.has(tool))
      .sort();
    const expectedRows = [...new Set([...registered, ...DURABLE_SECRET_PRODUCING_TOOLS])].sort();

    expect(duplicateRows).toEqual([]);
    expect(uniqueRows).toEqual(expectedRows);
    expect(extraRows).toEqual(approvedExtraRows);
  });

  it("inventories every runtime Axios and AWS SDK import site from src", () => {
    expect(contractImportInventory(contract)).toEqual(runtimeImportInventory());
  });

  it("keeps S3 multipart rows decided rather than deferring the name/path choice", () => {
    const unresolved = [...contract.matchAll(/^\| `(s3_[a-z0-9_]+)`\s+\|[^\n]+$/gm)].flatMap(
      ([row, tool]) =>
        /if #49 freezes|otherwise rename|if renamed| or native /.test(row) ? [tool] : [],
    );

    expect(unresolved).toEqual([]);
    expect(contract).not.toContain("s3_presign_upload_part` remains release-blocking");
    expect(contract).not.toContain("keep the existing name as a release-blocking SDK gap");
  });

  it("delegates Node runtime and SDK floor policy to check-runtime-policy", () => {
    const result = spawnSync(process.execPath, ["scripts/check-runtime-policy.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("runtime-policy:");
  });

  it("keeps unsupported S3 POST presigning out of runtime dependencies", () => {
    const pkg = readJson<{ dependencies: Record<string, string> }>("package.json");
    const lock = readJson<{ packages: Record<string, unknown> }>("package-lock.json");

    expect(pkg.dependencies).not.toHaveProperty("@aws-sdk/s3-presigned-post");
    expect(lock.packages["node_modules/@aws-sdk/s3-presigned-post"]).toBeUndefined();
    expect(contract).toContain("`@aws-sdk/s3-presigned-post` is intentionally absent");
  });

  it("keeps the SDK subpath shim documented and aligned with public subpaths", async () => {
    const shim = readFileSync(join(ROOT, "src/types/backblaze-b2-sdk-s3.d.ts"), "utf8");
    const sdkS3 = await import("@backblaze-labs/b2-sdk/s3");
    const sdkSimulator = await import("@backblaze-labs/b2-sdk/simulator");

    expect(shim).toContain("Temporary TypeScript-resolution shim");
    expect(shim).toContain("Issue");
    expect(typeof sdkS3.createS3ClientConfig).toBe("function");
    expect(shim).toContain("export function createS3ClientConfig");
    expect(shim).toContain("readonly forcePathStyle: boolean");
    expect(typeof sdkSimulator.B2Simulator).toBe("function");
    expect(shim).toContain("export class B2Simulator");
  });

  it("links the upstream SDK gaps and the #49 release gate", () => {
    expect(contract).toContain("backblaze-labs/b2-sdk-typescript/issues/153");
    expect(contract).toContain("backblaze-labs/b2-sdk-typescript/issues/154");
    expect(contract).toContain("github.com/backblaze-labs/b2-mcp/issues/49");
    expect(contract).toContain("intentionally pre-provisioned in runtime dependencies");
  });
});
