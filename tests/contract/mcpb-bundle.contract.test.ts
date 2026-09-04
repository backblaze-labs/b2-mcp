/**
 * Contract test for the MCPB desktop-extension bundle (`dist-mcpb/b2-mcp.mcpb`).
 *
 * The bundle is built and attached to every GitHub Release by `publish.yml` and
 * recorded in the release `SHA256SUMS`. Nothing else exercises `mcpb/manifest.json`
 * or `scripts/build-mcpb.mjs` before release, so a manifest schema break, a
 * version drift, or a regression in the reproducibility normalization would
 * otherwise only surface at release time. This test packs the bundle in CI,
 * parses and inflates it with a real ZIP reader, and asserts it is a readable,
 * version-aligned archive whose entries are normalized to fixed timestamps and
 * host metadata (so it is byte-reproducible across build OSes) and whose checksum
 * detects tampering, and that the release workflow actually builds, checksums,
 * and uploads it.
 *
 * The bundle is packed once in `beforeAll` and reused across assertions, so the
 * otherwise fast/deterministic contract layer pays for at most two `mcpb pack`
 * subprocesses (the shared build plus one rebuild that proves reproducibility).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { readJson, root } from "./support";

const mcpbPath = join(root, "dist-mcpb", "b2-mcp.mcpb");

// The Unix host + regular-file 0644 metadata the normalizer pins on every OS so
// a Windows rebuild reproduces the Linux release bytes (see build-mcpb.mjs).
const FIXED_VERSION_MADE_BY = 0x0314;
const FIXED_EXTERNAL_ATTRS = 0x01a40000;

interface ZipEntry {
  name: string;
  content: Buffer;
  versionMadeBy: number;
  externalAttrs: number;
  central: { time: number; date: number };
  local: { time: number; date: number };
}

/**
 * Minimal but real ZIP reader: walks the central directory, follows each entry
 * to its local header, and inflates the stored bytes. Unlike a magic-byte check
 * this fails if the hand-rolled record rewriting in build-mcpb.mjs corrupts the
 * central directory, an offset, or the compressed payload, and it exposes the
 * exact header fields the normalizer is responsible for pinning.
 */
function readZipEntries(buffer: Buffer): ZipEntry[] {
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;
  const LOCAL = 0x04034b50;
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("no End Of Central Directory record");
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL) {
      throw new Error(`corrupt central directory header at ${cursor}`);
    }
    const versionMadeBy = buffer.readUInt16LE(cursor + 4);
    const method = buffer.readUInt16LE(cursor + 10);
    const time = buffer.readUInt16LE(cursor + 12);
    const date = buffer.readUInt16LE(cursor + 14);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttrs = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    if (buffer.readUInt32LE(localOffset) !== LOCAL) {
      throw new Error(`corrupt local file header for ${name}`);
    }
    const localTime = buffer.readUInt16LE(localOffset + 10);
    const localDate = buffer.readUInt16LE(localOffset + 12);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const content =
      method === 0 ? Buffer.from(Uint8Array.from(raw)) : inflateRawSync(Uint8Array.from(raw));
    entries.push({
      name,
      content,
      versionMadeBy,
      externalAttrs,
      central: { time, date },
      local: { time: localTime, date: localDate },
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

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

  it("packs a real, readable zip whose manifest round-trips", () => {
    // Parse and inflate the archive with a real reader (not a magic-byte check),
    // so any corruption of the central directory or payload from the hand-rolled
    // record rewriting fails here rather than shipping a broken bundle.
    const entries = readZipEntries(bundle);
    expect([...entries.map((entry) => entry.name)].sort()).toEqual(["icon.png", "manifest.json"]);
    const manifestEntry = entries.find((entry) => entry.name === "manifest.json");
    expect(manifestEntry).toBeDefined();
    expect(JSON.parse(manifestEntry!.content.toString("utf8"))).toEqual(readJson("mcpb/manifest.json"));
    // The bundled icon is the declared 512x512 PNG (magic bytes) and matches the source.
    const iconEntry = entries.find((entry) => entry.name === "icon.png");
    expect(iconEntry).toBeDefined();
    expect(iconEntry!.content.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(iconEntry!.content).toEqual(readFileSync(join(root, "mcpb", "icon.png")));
  });

  it("normalizes every entry's timestamp and host metadata to fixed values", () => {
    // Assert the observable normalized state rather than relying on two
    // back-to-back builds matching: DOS timestamps have two-second granularity,
    // so a same-second unnormalized pack could coincide, but no real build dates
    // to 1980-01-01, so this fails the moment normalization is removed.
    for (const entry of readZipEntries(bundle)) {
      for (const stamp of [entry.central, entry.local]) {
        expect(stamp.time).toBe(0); // 00:00:00
        expect(stamp.date & 0x1f).toBe(1); // day 1
        expect((stamp.date >> 5) & 0x0f).toBe(1); // month 1
        expect(1980 + (stamp.date >> 9)).toBe(1980); // year 1980
      }
      // Host-independent so a Windows rebuild reproduces the Linux release bytes.
      expect(entry.versionMadeBy).toBe(FIXED_VERSION_MADE_BY);
      expect(entry.externalAttrs).toBe(FIXED_EXTERNAL_ATTRS);
    }
  });

  it("produces byte-reproducible output across repeated builds", () => {
    // A second pack of the same inputs must reproduce the shared build's digest;
    // this is what lets a third party rebuild and confirm the release SHA-256.
    // This proves intra-host reproducibility; the cross-OS comparison (that every
    // supported build OS emits the SAME bytes) is enforced by the
    // `cross-platform-minimum` job in .github/workflows/test.yml, which compares
    // this bundle's digest across the ubuntu/windows/macos matrix legs.
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
