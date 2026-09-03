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

/**
 * Rewrite every local-file-header and central-directory-header timestamp in a
 * zip buffer to a fixed value, so packing identical inputs yields identical
 * bytes. Parses the archive from its End Of Central Directory record rather than
 * scanning for signatures, so byte sequences inside compressed data are never
 * mistaken for headers.
 */
function normalizeZipTimestamps(buffer) {
  const EOCD_SIGNATURE = 0x06054b50;
  const CENTRAL_SIGNATURE = 0x02014b50;
  const LOCAL_SIGNATURE = 0x04034b50;

  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("build-mcpb: could not locate zip End Of Central Directory record");
  }

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let central = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(central) !== CENTRAL_SIGNATURE) {
      throw new Error(`build-mcpb: malformed central directory header at offset ${central}`);
    }
    buffer.writeUInt16LE(FIXED_DOS_TIME, central + 12);
    buffer.writeUInt16LE(FIXED_DOS_DATE, central + 14);

    const localOffset = buffer.readUInt32LE(central + 42);
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`build-mcpb: malformed local file header at offset ${localOffset}`);
    }
    buffer.writeUInt16LE(FIXED_DOS_TIME, localOffset + 10);
    buffer.writeUInt16LE(FIXED_DOS_DATE, localOffset + 12);

    const fileNameLength = buffer.readUInt16LE(central + 28);
    const extraLength = buffer.readUInt16LE(central + 30);
    const commentLength = buffer.readUInt16LE(central + 32);
    central += 46 + fileNameLength + extraLength + commentLength;
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
