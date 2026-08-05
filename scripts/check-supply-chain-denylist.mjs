#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDenylist } from "./lib/supply-chain-denylist-schema.mjs";
import {
  refsForBranchScan,
  scanFilesystemRoot,
  scanPacklist,
  scanRefs,
  scanTarball,
} from "./lib/supply-chain-scan.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return [
    "Usage: node scripts/check-supply-chain-denylist.mjs [options]",
    "",
    "Options:",
    "  --root <path>              Repository or expanded artifact root to scan",
    "  --denylist <path>          Denylist JSON path",
    "  --ref <ref>                Scan one git ref; repeatable",
    "  --all-branches            Scan all fetched local and remote branch refs",
    "  --artifacts-dir <path>     Scan an expanded artifact directory; repeatable",
    "  --tarball <path>           Extract and scan a .tgz package; repeatable",
    "  --packlist                Scan files that npm would include in the package",
    "  --expect-pack-file <path>  Require npm pack --dry-run to include this file",
    "  --help                    Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    root: repoRoot,
    denylist: path.join(repoRoot, "supply-chain-denylist.json"),
    refs: [],
    allBranches: false,
    artifactDirs: [],
    tarballs: [],
    packlist: false,
    expectedPackFiles: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--all-branches") {
      options.allBranches = true;
      continue;
    }
    if (arg === "--packlist") {
      options.packlist = true;
      continue;
    }
    if (
      arg === "--root" ||
      arg === "--denylist" ||
      arg === "--ref" ||
      arg === "--artifacts-dir" ||
      arg === "--tarball" ||
      arg === "--expect-pack-file"
    ) {
      const value = argv[index + 1];
      if (!value) {
        console.error(`supply-chain-denylist: ${arg} requires a value`);
        process.exit(2);
      }
      index += 1;
      if (arg === "--root") options.root = value;
      else if (arg === "--denylist") options.denylist = value;
      else if (arg === "--ref") options.refs.push(value);
      else if (arg === "--artifacts-dir") options.artifactDirs.push(value);
      else if (arg === "--tarball") options.tarballs.push(value);
      else options.expectedPackFiles.push(value.replace(/\\/g, "/"));
      continue;
    }

    console.error(`supply-chain-denylist: unknown option ${arg}`);
    console.error(usage());
    process.exit(2);
  }

  options.root = path.resolve(options.root);
  options.denylist = path.resolve(options.denylist);
  options.artifactDirs = options.artifactDirs.map((dir) => path.resolve(dir));
  options.tarballs = options.tarballs.map((file) => path.resolve(file));
  return options;
}

function printAndExit(report, state) {
  if (report.errors.length > 0) {
    for (const error of [...new Set(report.errors)].sort()) {
      console.error(`::error::supply-chain-denylist: scanner-error: ${error}`);
    }
    process.exit(2);
  }

  if (report.detections.length > 0) {
    for (const finding of [...new Set(report.detections)].sort()) {
      console.error(`::error::supply-chain-denylist: detected: ${finding}`);
    }
    process.exit(1);
  }

  console.log(
    `supply-chain-denylist: no denied packages or IOCs found for ${state.denylist.incident}`,
  );
}

const options = parseArgs(process.argv.slice(2));
const report = { detections: [], errors: [] };
let state;

try {
  state = loadDenylist(options.denylist);
} catch (error) {
  report.errors.push(`denylist schema: ${error.message}`);
  state = { denylist: { incident: "unknown" } };
  printAndExit(report, state);
}

scanFilesystemRoot(options.root, "working-tree", state, report);
if (options.allBranches) {
  scanRefs(options.root, refsForBranchScan(options.root, report), state, report);
}
if (options.refs.length > 0) scanRefs(options.root, options.refs, state, report);
if (options.packlist) scanPacklist(options.root, state, report, options.expectedPackFiles);
for (const artifactDir of options.artifactDirs) {
  if (!existsSync(artifactDir)) {
    report.errors.push(`artifact-dir:${artifactDir}: directory does not exist`);
    continue;
  }
  scanFilesystemRoot(artifactDir, `artifact-dir:${artifactDir}`, state, report);
}
for (const tarball of options.tarballs) scanTarball(tarball, state, report);

printAndExit(report, state);
