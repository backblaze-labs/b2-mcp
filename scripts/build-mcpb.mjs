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
 * The packer stamps each zip entry with the current wall-clock time and the
 * build host's system/permission metadata, which would make the `.mcpb` bytes
 * differ across builds and OSes and defeat a meaningful release checksum. After
 * packing we normalize those fields (see `normalizeZipMetadata`) so the artifact
 * is byte-for-byte reproducible from identical inputs on any supported build OS.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "dist-mcpb");
const outFile = path.join(outDir, "b2-mcp.mcpb");

// Fixed DOS date/time stamped into every zip entry for reproducibility:
// 1980-01-01 00:00:00 (the earliest value the DOS timestamp format can encode).
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x0021;

// Fixed host/permission metadata so the artifact is byte-identical regardless of
// the build OS. The mcpb packer records the host system in `version made by`
// (Unix `0x03..` on macOS/Linux vs FAT `0x00..` on Windows) and the file mode in
// the central-directory `external attributes` (Unix mode in the high bytes vs
// DOS attribute bits on Windows). Left untouched, a Windows rebuild of the same
// manifest would not match the Linux release checksum. We pin both to the values
// the Linux CI packer already emits — Unix host, zip spec 2.0, regular file 0644
// — so every platform produces the exact release bytes.
const FIXED_VERSION_MADE_BY = 0x0314;
const FIXED_EXTERNAL_ATTRS = 0x01a40000;

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
  CENTRAL_VERSION_MADE_BY: 4, // host system + zip spec version (2 bytes)
  CENTRAL_MODTIME: 12, // last-mod file time (2 bytes)
  CENTRAL_MODDATE: 14, // last-mod file date (2 bytes)
  CENTRAL_NAME_LENGTH: 28, // file-name length (2 bytes)
  CENTRAL_EXTRA_LENGTH: 30, // extra-field length (2 bytes)
  CENTRAL_COMMENT_LENGTH: 32, // file-comment length (2 bytes)
  CENTRAL_EXTERNAL_ATTRS: 38, // external file attributes / Unix mode (4 bytes)
  CENTRAL_LOCAL_OFFSET: 42, // offset of matching local header (4 bytes)
  // Local file header.
  LOCAL_MODTIME: 10, // last-mod file time (2 bytes)
  LOCAL_MODDATE: 12, // last-mod file date (2 bytes)
  LOCAL_NAME_LENGTH: 26, // file-name length (2 bytes)
  LOCAL_EXTRA_LENGTH: 28, // extra-field length (2 bytes)
};

/**
 * Rewrite every host- and time-dependent field in a zip buffer to a fixed value,
 * so packing identical inputs yields identical bytes on any build OS. Normalizes
 * each entry's DOS mod time/date, the central-directory `version made by` (which
 * encodes the packing host) and `external attributes` (which encode the Unix
 * mode on macOS/Linux vs DOS attribute bits on Windows). Parses the archive from
 * its End Of Central Directory record rather than scanning for signatures, so
 * byte sequences inside compressed data are never mistaken for headers.
 *
 * The mcpb packer emits a plain, single-disk, comment-less, extra-field-less zip
 * well under the 4 GiB ZIP64 threshold, so this normalizer assumes that shape
 * and fails loud if an input ever violates it — a non-zero archive comment
 * (which could contain a spurious EOCD signature and defeat the backward scan),
 * a ZIP64 sentinel central-directory offset (which would make the offset field
 * unreadable as a plain 32-bit value), or any extra/comment field (which could
 * carry host-dependent uid/gid or extended-timestamp bytes this normalizer does
 * not touch, silently breaking cross-platform reproducibility). It never
 * silently corrupts bytes and never leaves an unnormalized field behind.
 */
function normalizeZipMetadata(buffer) {
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
    throw new Error("build-mcpb: ZIP64 archives are not supported by the metadata normalizer");
  }
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(central) !== ZIP.CENTRAL_SIGNATURE) {
      throw new Error(`build-mcpb: malformed central directory header at offset ${central}`);
    }
    buffer.writeUInt16LE(FIXED_VERSION_MADE_BY, central + ZIP.CENTRAL_VERSION_MADE_BY);
    buffer.writeUInt16LE(FIXED_DOS_TIME, central + ZIP.CENTRAL_MODTIME);
    buffer.writeUInt16LE(FIXED_DOS_DATE, central + ZIP.CENTRAL_MODDATE);
    buffer.writeUInt32LE(FIXED_EXTERNAL_ATTRS, central + ZIP.CENTRAL_EXTERNAL_ATTRS);

    const localOffset = buffer.readUInt32LE(central + ZIP.CENTRAL_LOCAL_OFFSET);
    if (buffer.readUInt32LE(localOffset) !== ZIP.LOCAL_SIGNATURE) {
      throw new Error(`build-mcpb: malformed local file header at offset ${localOffset}`);
    }
    buffer.writeUInt16LE(FIXED_DOS_TIME, localOffset + ZIP.LOCAL_MODTIME);
    buffer.writeUInt16LE(FIXED_DOS_DATE, localOffset + ZIP.LOCAL_MODDATE);
    if (buffer.readUInt16LE(localOffset + ZIP.LOCAL_EXTRA_LENGTH) !== 0) {
      throw new Error(
        "build-mcpb: refusing to normalize a zip whose local header carries extra fields " +
          "(possible host-dependent uid/gid or timestamp bytes)",
      );
    }

    const fileNameLength = buffer.readUInt16LE(central + ZIP.CENTRAL_NAME_LENGTH);
    const extraLength = buffer.readUInt16LE(central + ZIP.CENTRAL_EXTRA_LENGTH);
    const commentLength = buffer.readUInt16LE(central + ZIP.CENTRAL_COMMENT_LENGTH);
    if (extraLength !== 0 || commentLength !== 0) {
      throw new Error(
        "build-mcpb: refusing to normalize a zip whose central header carries extra/comment " +
          "fields (possible host-dependent uid/gid or timestamp bytes)",
      );
    }
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
//
// The packer prints its own SHA-1 of the bytes it writes, but we mutate those
// bytes below to normalize metadata, so that digest never matches the final
// artifact. Capture (rather than inherit) the packer's chatty output so its
// misleading digest cannot be mistaken for the release checksum, and surface it
// only if the pack fails.
// Pack to a temporary file rather than the documented `outFile`, so the
// non-normalized packer output never occupies the published path. `outFile` is
// written only from the normalized bytes below, keeping the `.mcpb` extension
// the packer expects on its output argument.
const packFile = path.join(outDir, "b2-mcp.unnormalized.mcpb");
rmSync(packFile, { force: true });
try {
  execFileSync("pnpm", ["exec", "mcpb", "pack", "mcpb", packFile], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  rmSync(packFile, { force: true });
  throw error;
}

// Normalize host/time metadata so the release artifact is reproducible, then
// emit the authoritative post-normalization SHA-256 that the release
// `SHA256SUMS` records. If normalization or the write fails, remove any partial
// `outFile` so a stale, unverified bundle can never be left at the documented
// path for an accidental upload — matching the stale-artifact guard above.
let normalized;
try {
  normalized = normalizeZipMetadata(readFileSync(packFile));
  writeFileSync(outFile, normalized);
} catch (error) {
  rmSync(outFile, { force: true });
  throw error;
} finally {
  rmSync(packFile, { force: true });
}
const sha256 = createHash("sha256").update(normalized).digest("hex");

console.log(`build-mcpb: packed ${outFile} (b2-mcp@${packageVersion})`);
console.log(`build-mcpb: sha256 ${sha256}  ${path.basename(outFile)}`);
