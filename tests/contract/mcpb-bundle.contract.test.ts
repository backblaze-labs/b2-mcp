/**
 * Contract test for the MCPB desktop-extension bundle (`dist-mcpb/b2-mcp.mcpb`).
 *
 * The bundle is built and attached to every GitHub Release by `publish.yml` and
 * recorded in the release `SHA256SUMS`. Nothing else exercises `mcpb/manifest.json`
 * or `scripts/build-mcpb.mjs` before release, so a manifest schema break, a
 * version drift, or a regression in the reproducibility normalization would
 * otherwise only surface at release time. This test packs the bundle in CI and
 * asserts it is a valid, version-aligned, byte-reproducible archive whose
 * checksum detects tampering, and that the release workflow actually builds,
 * checksums, and uploads it.
 *
 * The bundle is packed once in `beforeAll` and reused across assertions, so the
 * otherwise fast/deterministic contract layer pays for at most two `mcpb pack`
 * subprocesses (the shared build plus one rebuild that proves reproducibility).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, root } from "./support";

const mcpbPath = join(root, "dist-mcpb", "b2-mcp.mcpb");

function buildBundle(): Buffer {
  execFileSync("node", ["scripts/build-mcpb.mjs"], { cwd: root, stdio: "pipe" });
  return readFileSync(mcpbPath);
}

function sha256(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

const pkg = readJson<{ version: string; name: string }>("package.json");
const manifest = readJson<{
  version: string;
  name: string;
  manifest_version: string;
  server?: { mcp_config?: { args?: string[] } };
}>("mcpb/manifest.json");

describe("MCPB desktop-extension bundle", () => {
  let bundle: Buffer;
  let digest: string;

  beforeAll(() => {
    bundle = buildBundle();
    digest = sha256(Uint8Array.from(bundle));
  }, 60_000);

  it("keeps the manifest version in lockstep with package.json", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.name).toBe("b2-mcp");
    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.server?.mcp_config?.args).toContain(`${pkg.name}@${pkg.version}`);
  });

  it("packs a valid zip archive containing the manifest", () => {
    // Local file header magic (PK\x03\x04) marks a well-formed zip.
    expect(bundle.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(bundle.includes(Buffer.from("manifest.json"))).toBe(true);
    expect(bundle.length).toBeGreaterThan(0);
  });

  it("produces byte-reproducible output across repeated builds", () => {
    // A second pack of the same inputs must reproduce the shared build's digest;
    // this is what lets a third party rebuild and confirm the release SHA-256.
    expect(sha256(Uint8Array.from(buildBundle()))).toBe(digest);
  }, 60_000);

  it("yields a checksum that detects a tampered bundle", () => {
    const tampered = Uint8Array.from(bundle);
    tampered[tampered.length - 1] ^= 0xff;
    expect(sha256(tampered)).not.toBe(digest);
  });

  it("is built, checksummed, and attached by the release workflow", () => {
    const publish = readFileSync(join(root, ".github/workflows/publish.yml"), "utf8");
    expect(publish).toContain("pnpm run build:mcpb");
    expect(publish).toContain("cp dist-mcpb/b2-mcp.mcpb publish-package/b2-mcp.mcpb");
    // The checksums manifest and release upload both cover the bundle.
    expect(publish).toContain("sha256sum *.tgz *.cdx.json *.mcpb release-notes.md npm-pack.json");
    expect(publish).toContain("EXPECTED_MCPB_NAME");
    expect(publish).toContain('"publish-package/${EXPECTED_MCPB_NAME}"');
  });

  it("keeps the build artifact directory out of version control", () => {
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/)).toContain("dist-mcpb/");
  });
});
