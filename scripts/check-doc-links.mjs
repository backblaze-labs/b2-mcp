#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  process.env.B2_MCP_DOC_LINK_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const skippedDirs = new Set([".git", "coverage", "dist", "node_modules", "reports"]);
const markdownLinkPattern = /!?\[[^\]\n]+\]\(([^)\n]+)\)/g;
const referenceDefinitionPattern = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(\S+)/gm;

function isInsideRoot(candidate, rootDir) {
  const relative = path.relative(rootDir, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function listMarkdownFiles(dir, { rootRealpath, visited }) {
  const dirRealpath = realpathSync(dir);
  if (!isInsideRoot(dirRealpath, rootRealpath) || visited.has(dirRealpath)) return [];
  visited.add(dirRealpath);

  const entries = readdirSync(dir)
    .map((name) => path.join(dir, name))
    .sort();
  const files = [];
  for (const entry of entries) {
    const name = path.basename(entry);
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (!skippedDirs.has(name))
        files.push(...listMarkdownFiles(entry, { rootRealpath, visited }));
    } else if (entry.endsWith(".md")) {
      files.push(entry);
    }
  }
  return files;
}

function stripInlineCode(line) {
  let output = "";
  for (let index = 0; index < line.length; ) {
    if (line[index] !== "`") {
      output += line[index];
      index += 1;
      continue;
    }

    let ticks = 1;
    while (line[index + ticks] === "`") ticks += 1;
    const closing = line.indexOf("`".repeat(ticks), index + ticks);
    if (closing === -1) {
      output += line.slice(index);
      break;
    }
    index = closing + ticks;
  }
  return output;
}

function stripMarkdownCode(text) {
  const lines = text.split(/\r?\n/);
  const output = [];
  let fence = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      output.push("");
      if (fenceMatch?.[1].startsWith(fence.char) && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      output.push("");
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) {
      output.push("");
      continue;
    }
    output.push(stripInlineCode(line));
  }

  return output.join("\n");
}

function normalizeTarget(rawTarget) {
  const trimmed = rawTarget.trim();
  const withoutTitle = trimmed.startsWith("<")
    ? trimmed.replace(/^<([^>]+)>.*$/, "$1")
    : trimmed.split(/\s+/)[0];
  return withoutTitle.replace(/&amp;/g, "&");
}

function isExternalTarget(target) {
  return /^(?:https?:|mailto:|tel:)/i.test(target);
}

function linkPath(target) {
  const withoutFragment = target.split("#", 1)[0].split("?", 1)[0];
  if (!withoutFragment) return null;
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return withoutFragment;
  }
}

export function docLinkFindings({ rootDir = root } = {}) {
  const findings = [];
  const rootPath = path.resolve(rootDir);
  const rootRealpath = realpathSync(rootDir);
  for (const file of listMarkdownFiles(rootDir, { rootRealpath, visited: new Set() })) {
    const text = stripMarkdownCode(readFileSync(file, "utf8"));
    for (const match of [
      ...text.matchAll(markdownLinkPattern),
      ...text.matchAll(referenceDefinitionPattern),
    ]) {
      if (match[0].startsWith("!")) continue;
      const target = normalizeTarget(match[1]);
      if (!target || target.startsWith("#") || isExternalTarget(target)) continue;
      const targetPath = linkPath(target);
      if (!targetPath) continue;

      const resolved = path.resolve(
        targetPath.startsWith("/") ? rootPath : path.dirname(file),
        targetPath.startsWith("/") ? targetPath.slice(1) : targetPath,
      );
      if (!isInsideRoot(resolved, rootPath)) {
        findings.push(`${path.relative(rootDir, file)} links outside the repository: ${target}`);
        continue;
      }
      if (!existsSync(resolved)) {
        findings.push(`${path.relative(rootDir, file)} has a broken local link: ${target}`);
      }
    }
  }
  return findings.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const findings = docLinkFindings();
  if (findings.length > 0) {
    console.error("Broken Markdown links:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exit(1);
  }
  console.log("doc-links: local Markdown links are valid");
}
