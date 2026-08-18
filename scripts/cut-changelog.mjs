#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { releaseRoot } from "./lib/release-utils.mjs";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeRepositoryUrl(value) {
  return String(value ?? "")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

async function main() {
  const root = releaseRoot();
  const changelogPath = path.join(root, "CHANGELOG.md");
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const version = String(pkg.version ?? "");
  const repoUrl = normalizeRepositoryUrl(pkg.repository?.url);

  if (!version) throw new Error("package.json version is missing");
  if (!repoUrl) throw new Error("package.json repository.url is missing");

  let text = await fs.readFile(changelogPath, "utf8");
  if (new RegExp(`^## \\[${escapeRegExp(version)}\\]`, "m").test(text)) {
    throw new Error(`CHANGELOG.md already has a "## [${version}]" section`);
  }

  const unreleasedMatch = /^## \[Unreleased\]\s*$/m.exec(text);
  if (!unreleasedMatch) throw new Error('CHANGELOG.md is missing "## [Unreleased]"');

  const sectionStart = unreleasedMatch.index + unreleasedMatch[0].length;
  const rest = text.slice(sectionStart);
  const nextHeadingOffset = rest.search(/^## \[/m);
  const sectionEnd = nextHeadingOffset === -1 ? text.length : sectionStart + nextHeadingOffset;
  const unreleasedBody = text.slice(sectionStart, sectionEnd).trim();
  const previousVersion = /^## \[(\d+\.\d+\.\d+(?:-[^\]]+)?)\]/m.exec(rest)?.[1] ?? "";

  if (!unreleasedBody) {
    console.warn(
      `cut-changelog: WARNING - [Unreleased] is empty; releasing v${version} with no notes.`,
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  const before = text.slice(0, unreleasedMatch.index);
  const promoted = unreleasedBody ? `${unreleasedBody}\n\n` : "";
  const after = text.slice(sectionEnd);
  text = `${before}## [Unreleased]\n\n## [${version}] - ${date}\n\n${promoted}${after}`;

  const unreleasedLink = `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD`;
  const versionLink = previousVersion
    ? `[${version}]: ${repoUrl}/compare/v${previousVersion}...v${version}`
    : `[${version}]: ${repoUrl}/releases/tag/v${version}`;

  if (/^\[Unreleased\]:.*$/m.test(text)) {
    text = text.replace(/^\[Unreleased\]:.*$/m, `${unreleasedLink}\n${versionLink}`);
  } else {
    text = `${text.replace(/\s*$/, "")}\n\n${unreleasedLink}\n${versionLink}\n`;
  }

  await fs.writeFile(changelogPath, text);
  console.log(`cut-changelog: promoted [Unreleased] to [${version}] - ${date}`);
}

try {
  await main();
} catch (error) {
  console.error(`cut-changelog: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
