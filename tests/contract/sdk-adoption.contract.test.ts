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
import { readJson, readLock, root as ROOT } from "./support";

const SDK_VERSION = "0.4.0";
const SDK_RESOLVED = "https://registry.npmjs.org/@backblaze-labs/b2-sdk/-/b2-sdk-0.4.0.tgz";
const SDK_INTEGRITY =
  "sha512-Xs5dHWF2YNDVaZpumgJAAqy1rFYVw1F8l2ZAsKL36AA6lwpxuqjRHPgwQMX92WiowQLCl5O1bZRjD3pVJA7m+Q==";

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

function matrixRows(
  contract: string,
): Map<string, { className: string; path: string; row: string }> {
  const rows = new Map<string, { className: string; path: string; row: string }>();
  for (const line of contract.split("\n")) {
    const match = line.match(/^\| `((?:b2|s3)_[a-z0-9_]+)`\s+\| `?([^`| ]+)`?\s+\| ([^|]+)\|/);
    if (!match) continue;
    rows.set(match[1], {
      className: match[2],
      path: match[3],
      row: line,
    });
  }
  return rows;
}

describe("SDK adoption contract", () => {
  const contract = readFileSync(join(ROOT, "docs/design-docs/sdk-adoption-contract.md"), "utf8");

  it("pins the reviewed Backblaze SDK package exactly", () => {
    const pkg = readJson<{
      dependencies: Record<string, string>;
    }>("package.json");
    const lock = readLock<{
      packages: Record<
        string,
        { version?: string; resolved?: string; integrity?: string; engines?: { node?: string } }
      >;
    }>();
    const sdk = lock.packages["node_modules/@backblaze-labs/b2-sdk"];

    expect(pkg.dependencies["@backblaze-labs/b2-sdk"]).toBe(SDK_VERSION);
    expect(sdk?.version).toBe(SDK_VERSION);
    expect(sdk?.resolved).toBe(SDK_RESOLVED);
    expect(sdk?.integrity).toBe(SDK_INTEGRITY);
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

  it("keeps reviewed matrix classes and paths aligned with runtime adapters", () => {
    const rows = matrixRows(contract);
    const b2Client = readFileSync(join(ROOT, "src/b2/client.ts"), "utf8");
    const partner = readFileSync(join(ROOT, "src/b2/partner.ts"), "utf8");
    const s3Objects = readFileSync(join(ROOT, "src/s3/objects.ts"), "utf8");
    const s3Presigned = readFileSync(join(ROOT, "src/s3/presigned.ts"), "utf8");
    const s3Adapter = readFileSync(join(ROOT, "src/s3/aws-sdk-adapter.ts"), "utf8");
    const s3Buckets = readFileSync(join(ROOT, "src/s3/buckets.ts"), "utf8");
    const s3Extras = readFileSync(join(ROOT, "src/s3/extras.ts"), "utf8");
    const s3Multipart = readFileSync(join(ROOT, "src/s3/multipart.ts"), "utf8");
    const reportClient = readFileSync(join(ROOT, "src/b2/report-client.ts"), "utf8");

    function expectMatrixPath(tool: string, className: string, path: string): void {
      const row = rows.get(tool);
      expect(row?.className).toBe(className);
      expect(row?.path).toContain(path);
    }

    expectMatrixPath("b2_list_buckets", "raw", "RawClient.listBuckets");
    expect(b2Client).toContain("client.raw.listBuckets");
    expectMatrixPath("b2_update_bucket", "raw", "RawClient.updateBucket");
    expect(b2Client).toContain("client.raw.updateBucket");

    expectMatrixPath("b2_list_groups", "partner", "PartnerRawClient.listGroups");
    expectMatrixPath("b2_create_group_member", "partner", "PartnerClient.createGroupMember");
    expectMatrixPath("b2_eject_group_member", "partner", "PartnerRawClient.ejectGroupMember");
    expectMatrixPath("b2_list_group_members", "partner", "PartnerRawClient.listGroupMembers");
    expectMatrixPath(
      "b2_reserve_trial_create_account",
      "partner",
      "PartnerClient.reserveTrialAccount",
    );
    expect(b2Client).toContain('@backblaze-labs/b2-sdk/partner"');
    expect(b2Client).not.toContain("postPartnerJson");
    expect(b2Client).not.toContain("postJson");
    expect(b2Client).not.toContain("postNonRetryingMutationJson");
    expect(b2Client).toContain("runWithSuccessfulResponseCapture");
    expect(b2Client).toContain("client.createGroupMember");
    expect(b2Client).toContain("client.reserveTrialAccount");
    expect(b2Client).toContain("client.raw.listGroups");
    expect(b2Client).toContain("client.raw.ejectGroupMember");
    expect(b2Client).toContain("client.raw.listGroupMembers");
    expect(b2Client).toContain("b2_create_group_member");
    expect(b2Client).toContain("b2_reserve_trial_create_account");
    expect(partner).toContain("client.listGroups");
    expect(partner).toContain("client.createGroupMember");
    expect(partner).toContain("client.ejectGroupMember");
    expect(partner).toContain("client.listGroupMembers");
    expect(partner).toContain("client.reserveTrialCreateAccount");
    expect(partner).not.toContain("client.call(");
    expect(b2Client).not.toContain("async call<");

    expectMatrixPath("s3_put_object", "s3", "B2S3PeerClient.putObject");
    expectMatrixPath("s3_get_object", "s3", "B2S3PeerClient.getObject");
    expectMatrixPath("s3_delete_object", "s3", "B2S3PeerClient.deleteObject");
    expectMatrixPath("s3_delete_objects", "s3", "B2S3PeerClient.deleteObjects");
    expectMatrixPath("s3_copy_object", "s3", "B2S3PeerClient.copyObject");
    expectMatrixPath("s3_list_objects_v2", "s3", "B2S3PeerClient.listObjectsV2");
    expectMatrixPath("s3_list_object_versions", "s3", "B2S3PeerClient.listObjectVersions");
    expectMatrixPath("s3_get_presigned_url", "s3", "B2S3PeerClient.presignObjectUrl");
    expect(b2Client).not.toContain("s3PutObject");
    expect(b2Client).not.toContain("presignS3GetObjectUrl");
    expect(s3Objects).toContain("putObject");
    expect(s3Objects).not.toContain("../b2/client");
    expect(s3Objects).not.toContain("@aws-sdk/client-s3");
    expect(s3Presigned).toContain("presignObjectUrl");
    expect(s3Presigned).not.toContain("@aws-sdk/s3-request-presigner");

    expectMatrixPath("b2_usage_growth", "compose", "createReportS3Client");
    expectMatrixPath("b2_egress_leaders", "compose", "createReportS3Client");
    expect(reportClient).toContain("createReportS3Client");
    expect(s3Adapter).toContain("export class B2S3PeerClient");
    for (const caller of [s3Buckets, s3Objects, s3Presigned, s3Extras, s3Multipart, reportClient]) {
      expect(caller).not.toMatch(/\b[A-Z][A-Za-z0-9]*Command\b/);
      expect(caller).not.toContain("getSignedUrl");
    }
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
    const lock = readLock<{ packages: Record<string, unknown> }>();

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
    expect(typeof sdkS3.presignS3GetObjectUrl).toBe("function");
    expect(typeof sdkS3.presignS3PutObjectUrl).toBe("function");
    expect(shim).toContain("export function createS3ClientConfig");
    expect(shim).toContain("export function presignS3GetObjectUrl");
    expect(shim).toContain("export function presignS3PutObjectUrl");
    expect(shim).toContain("readonly forcePathStyle: boolean");
    expect(typeof sdkSimulator.B2Simulator).toBe("function");
    expect(shim).toContain("export class B2Simulator");
  });

  it("links the remaining upstream SDK gap and the #49 release gate", () => {
    expect(contract).toContain("backblaze-labs/b2-sdk-typescript/issues/154");
    expect(contract).toContain("github.com/backblaze-labs/b2-mcp/issues/49");
    expect(contract).toContain("intentionally pre-provisioned in runtime dependencies");
  });
});
