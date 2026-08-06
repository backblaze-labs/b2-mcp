#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  process.env.B2_MCP_DOC_LINK_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const skippedDirs = new Set([".git", "coverage", "dist", "node_modules", "reports"]);
const markdownLinkPattern = /!?\[[^\]\n]+\]\(([^)\n]+)\)/g;

function listMarkdownFiles(dir) {
  const entries = readdirSync(dir)
    .map((name) => path.join(dir, name))
    .sort();
  const files = [];
  for (const entry of entries) {
    const name = path.basename(entry);
    const stat = statSync(entry);
    if (stat.isDirectory()) {
      if (!skippedDirs.has(name)) files.push(...listMarkdownFiles(entry));
    } else if (entry.endsWith(".md")) {
      files.push(entry);
    }
  }
  return files;
}

function stripCodeFences(text) {
  return text.replace(/^```[\s\S]*?^```/gm, (block) => "\n".repeat(block.split("\n").length - 1));
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
  for (const file of listMarkdownFiles(rootDir)) {
    const text = stripCodeFences(readFileSync(file, "utf8"));
    for (const match of text.matchAll(markdownLinkPattern)) {
      if (match[0].startsWith("!")) continue;
      const target = normalizeTarget(match[1]);
      if (!target || target.startsWith("#") || isExternalTarget(target)) continue;
      const targetPath = linkPath(target);
      if (!targetPath) continue;

      const resolved = path.resolve(
        targetPath.startsWith("/") ? rootDir : path.dirname(file),
        targetPath.startsWith("/") ? targetPath.slice(1) : targetPath,
      );
      if (!resolved.startsWith(`${rootDir}${path.sep}`) && resolved !== rootDir) {
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
