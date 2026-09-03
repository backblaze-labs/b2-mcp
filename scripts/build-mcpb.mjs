#!/usr/bin/env node
/**
 * Pack the MCPB (MCP Bundle) desktop-extension artifact.
 *
 * The bundle is a versioned release artifact — its `version` must match
 * `package.json` (kept in lockstep by `scripts/update-server-json-version.mjs`).
 * The output `.mcpb` is produced on every release by `publish.yml`, attached to
 * the GitHub Release, and recorded in the release `SHA256SUMS`. It is also the
 * artifact a maintainer uploads through Smithery's Local (MCPB Bundle) publish
 * tab. See docs/references/discoverability.md.
 *
 * The packer stamps each zip entry with the current wall-clock time, which would
 * make the `.mcpb` bytes differ on every build and defeat a meaningful release
 * checksum. After packing we normalize every entry timestamp to a fixed epoch so
 * the artifact is byte-for-byte reproducible from identical inputs.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "dist-mcpb");
const outFile = path.join(outDir, "b2-mcp.mcpb");

// Fixed DOS date/time stamped into every zip entry for reproducibility:
// 1980-01-01 00:00:00 (the earliest value the DOS timestamp format can encode).
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x0021;

// Named byte offsets into the ZIP records we touch, per the PKWARE APPNOTE
// (.ZIP File Format Specification). Naming each field keeps the offset→field
// mapping readable without holding the spec open, and makes a mistranscribed
// addend obvious at the read site instead of silently corrupting the archive.
const ZIP = {
  EOCD_SIGNATURE: 0x06054b50,
  CENTRAL_SIGNATURE: 0x02014b50,
  LOCAL_SIGNATURE: 0x04034b50,
  ZIP64_SENTINEL: 0xffffffff,
  // End Of Central Directory record.
  EOCD_MIN_SIZE: 22,
  EOCD_ENTRY_COUNT: 10, // total central-directory records (2 bytes)
  EOCD_CENTRAL_OFFSET: 16, // offset of first central-directory header (4 bytes)
  EOCD_COMMENT_LENGTH: 20, // archive comment length (2 bytes)
  // Central-directory file header.
  CENTRAL_HEADER_SIZE: 46, // fixed-size prefix before name/extra/comment
  CENTRAL_MODTIME: 12, // last-mod file time (2 bytes)
  CENTRAL_MODDATE: 14, // last-mod file date (2 bytes)
  CENTRAL_NAME_LENGTH: 28, // file-name length (2 bytes)
  CENTRAL_EXTRA_LENGTH: 30, // extra-field length (2 bytes)
  CENTRAL_COMMENT_LENGTH: 32, // file-comment length (2 bytes)
  CENTRAL_LOCAL_OFFSET: 42, // offset of matching local header (4 bytes)
  // Local file header.
  LOCAL_MODTIME: 10, // last-mod file time (2 bytes)
  LOCAL_MODDATE: 12, // last-mod file date (2 bytes)
};

/**
 * Rewrite every local-file-header and central-directory-header timestamp in a
 * zip buffer to a fixed value, so packing identical inputs yields identical
 * bytes. Parses the archive from its End Of Central Directory record rather than
 * scanning for signatures, so byte sequences inside compressed data are never
 * mistaken for headers.
 *
 * The mcpb packer emits a plain, single-disk, comment-less zip well under the
 * 4 GiB ZIP64 threshold, so this normalizer assumes that shape and fails loud if
 * an input ever violates it — a non-zero archive comment (which could contain a
 * spurious EOCD signature and defeat the backward scan) or a ZIP64 sentinel
 * central-directory offset (which would make the offset field unreadable as a
 * plain 32-bit value). It never silently corrupts bytes.
 */
function normalizeZipTimestamps(buffer) {
  let eocd = -1;
  for (let offset = buffer.length - ZIP.EOCD_MIN_SIZE; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP.EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("build-mcpb: could not locate zip End Of Central Directory record");
  }
  if (buffer.readUInt16LE(eocd + ZIP.EOCD_COMMENT_LENGTH) !== 0) {
    throw new Error(
      "build-mcpb: refusing to normalize a zip with an archive comment (EOCD scan is ambiguous)",
    );
  }

  const entryCount = buffer.readUInt16LE(eocd + ZIP.EOCD_ENTRY_COUNT);
  let central = buffer.readUInt32LE(eocd + ZIP.EOCD_CENTRAL_OFFSET);
  if (central === ZIP.ZIP64_SENTINEL) {
    throw new Error("build-mcpb: ZIP64 archives are not supported by the timestamp normalizer");
  }
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(central) !== ZIP.CENTRAL_SIGNATURE) {
      throw new Error(`build-mcpb: malformed central directory header at offset ${central}`);
    }
    buffer.writeUInt16LE(FIXED_DOS_TIME, central + ZIP.CENTRAL_MODTIME);
    buffer.writeUInt16LE(FIXED_DOS_DATE, central + ZIP.CENTRAL_MODDATE);

    const localOffset = buffer.readUInt32LE(central + ZIP.CENTRAL_LOCAL_OFFSET);
    if (buffer.readUInt32LE(localOffset) !== ZIP.LOCAL_SIGNATURE) {
      throw new Error(`build-mcpb: malformed local file header at offset ${localOffset}`);
    }
    buffer.writeUInt16LE(FIXED_DOS_TIME, localOffset + ZIP.LOCAL_MODTIME);
    buffer.writeUInt16LE(FIXED_DOS_DATE, localOffset + ZIP.LOCAL_MODDATE);

    const fileNameLength = buffer.readUInt16LE(central + ZIP.CENTRAL_NAME_LENGTH);
    const extraLength = buffer.readUInt16LE(central + ZIP.CENTRAL_EXTRA_LENGTH);
    const commentLength = buffer.readUInt16LE(central + ZIP.CENTRAL_COMMENT_LENGTH);
    central += ZIP.CENTRAL_HEADER_SIZE + fileNameLength + extraLength + commentLength;
  }

  return buffer;
}

// Drop any prior artifact up front so a later validation/pack failure can never
// leave a stale `.mcpb` (from an earlier version) sitting in the documented
// upload path.
mkdirSync(outDir, { recursive: true });
rmSync(outFile, { force: true });

const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const manifestVersion = JSON.parse(
  readFileSync(path.join(root, "mcpb", "manifest.json"), "utf8"),
).version;
if (manifestVersion !== packageVersion) {
  console.error(
    `build-mcpb: mcpb/manifest.json version ${manifestVersion} does not match package.json ${packageVersion}. ` +
      "Run `node scripts/update-server-json-version.mjs` first.",
  );
  process.exit(2);
}

// Invoke the lockfile-resolved mcpb binary (pinned as an exact dev dependency)
// so the packer's full dependency graph is frozen with the rest of the repo,
// rather than re-resolving transitive deps via `npx -y` on each release.
execFileSync("pnpm", ["exec", "mcpb", "pack", "mcpb", outFile], {
  cwd: root,
  stdio: "inherit",
});

// Normalize entry timestamps in place so the release artifact is reproducible.
writeFileSync(outFile, normalizeZipTimestamps(readFileSync(outFile)));

console.log(`build-mcpb: packed ${outFile} (b2-mcp@${packageVersion})`);
