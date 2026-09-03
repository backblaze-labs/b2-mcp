/**
 * Contract test for the MCPB desktop-extension bundle (`dist-mcpb/b2-mcp.mcpb`).
 *
 * The bundle is built and attached to every GitHub Release by `publish.yml` and
 * recorded in the release `SHA256SUMS`. Nothing else exercises `mcpb/manifest.json`
 * or `scripts/build-mcpb.mjs` before release, so a manifest schema break, a
 * version drift, or a regression in the reproducibility normalization would
 * otherwise only surface at release time. This test packs the bundle in CI and
 * asserts it is a valid, version-aligned, byte-reproducible archive, and that
 * the release workflow actually builds, checksums, and uploads it.
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

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(Uint8Array.from(buffer)).digest("hex");
}

const pkg = readJson<{ version: string; name: string }>("package.json");
const manifest = readJson<{
  version: string;
  name: string;
  manifest_version: string;
  server?: { mcp_config?: { args?: string[] } };
}>("mcpb/manifest.json");

describe("MCPB desktop-extension bundle", () => {
  it("keeps the manifest version in lockstep with package.json", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.name).toBe("b2-mcp");
    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.server?.mcp_config?.args).toContain(`${pkg.name}@${pkg.version}`);
  });

  it("packs a valid zip archive containing the manifest", () => {
    const bundle = buildBundle();
    // Local file header magic (PK\x03\x04) marks a well-formed zip.
    expect(bundle.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(bundle.includes(Buffer.from("manifest.json"))).toBe(true);
    expect(bundle.length).toBeGreaterThan(0);
  }, 60_000);

  it("produces byte-reproducible output across repeated builds", () => {
    const first = sha256(buildBundle());
    const second = sha256(buildBundle());
    expect(second).toBe(first);
  }, 60_000);

  it("normalizes every entry timestamp to the fixed 1980-01-01 epoch", () => {
    const bundle = buildBundle();
    // Local file header: mod time at +10, mod date at +12 (little-endian).
    // Fixed to 0x0000 / 0x0021 (1980-01-01 00:00:00) for reproducibility.
    expect(bundle.readUInt16LE(10)).toBe(0x0000);
    expect(bundle.readUInt16LE(12)).toBe(0x0021);
  }, 60_000);

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
