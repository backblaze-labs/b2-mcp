/**
 * Drift guard for the official B2 SDK adoption contract.
 *
 * Issue #71 freezes the SDK parity matrix. If the registered surface, runtime
 * import sites, or reviewed SDK version changes, this document must be updated
 * intentionally instead of drifting behind the implementation.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { createServer, getRegisteredTools } from "../../src/server";
import { DURABLE_SECRET_PRODUCING_TOOLS } from "../../src/utils/tool-capabilities";

const ROOT = join(__dirname, "../..");
const SDK_VERSION = "0.2.0";
const SDK_RESOLVED = "https://registry.npmjs.org/@backblaze-labs/b2-sdk/-/b2-sdk-0.2.0.tgz";
const SDK_INTEGRITY =
  "sha512-qYjCVtFuiHp54R8okZbuG7oVU0U0Xj9A/Yn4VBLeMKp5JxVKFp3+M3Ywry+aB6ZKX24P3NTh8JURZMGuayFWDQ==";
const NODE_FLOOR = ">=22.13.0";

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8")) as T;
}

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

    const registeredSet = new Set(registered);
    const extraRows = [...new Set(matrixRows)].filter((tool) => !registeredSet.has(tool));

    expect(registered.every((tool) => matrixRows.includes(tool))).toBe(true);
    expect(extraRows.sort()).toEqual([...DURABLE_SECRET_PRODUCING_TOOLS].sort());
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
  });

  it("keeps the effective Node runtime floor aligned with the SDK", () => {
    const pkg = readJson<{
      engines: { node: string };
    }>("package.json");
    const lock = readJson<{
      packages: Record<string, { engines?: { node?: string } }>;
    }>("package-lock.json");
    const v1Scope = readFileSync(join(ROOT, "docs/V1_SCOPE.md"), "utf8");
    const deploy = readFileSync(join(ROOT, "docs/DEPLOY.md"), "utf8");
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const ci = readFileSync(join(ROOT, ".github/workflows/test.yml"), "utf8");

    expect(pkg.engines.node).toBe(NODE_FLOOR);
    expect(lock.packages[""]?.engines?.node).toBe(NODE_FLOOR);
    expect(
      compareFloor(
        pkg.engines.node,
        lock.packages["node_modules/@backblaze-labs/b2-sdk"]?.engines?.node ?? "",
      ),
    ).toBeGreaterThanOrEqual(0);
    expect(v1Scope).toContain("Node.js 22.13.0");
    expect(deploy).toContain("Node.js 22.13.0 or newer");
    expect(readme).toContain("Node.js 22.13.0 or newer");
    expect(ci).toContain("node-version: 22.13.0");
    expect(ci).toContain("npm ci --engine-strict");
  });

  it("keeps unsupported S3 POST presigning out of runtime dependencies", () => {
    const pkg = readJson<{ dependencies: Record<string, string> }>("package.json");
    const lock = readJson<{ packages: Record<string, unknown> }>("package-lock.json");

    expect(pkg.dependencies).not.toHaveProperty("@aws-sdk/s3-presigned-post");
    expect(lock.packages["node_modules/@aws-sdk/s3-presigned-post"]).toBeUndefined();
    expect(contract).toContain("`@aws-sdk/s3-presigned-post` is intentionally absent");
  });

  it("links the upstream SDK gaps and the #49 release gate", () => {
    expect(contract).toContain("backblaze-labs/b2-sdk-typescript/issues/153");
    expect(contract).toContain("backblaze-labs/b2-sdk-typescript/issues/154");
    expect(contract).toContain("github.com/backblaze-labs/b2-mcp/issues/49");
    expect(contract).toContain("intentionally pre-provisioned in runtime dependencies");
  });
});
