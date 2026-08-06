#!/usr/bin/env node
"use strict";

const { existsSync, readFileSync, readdirSync } = require("node:fs");
const path = require("node:path");

const REQUIRED_SECTIONS = Object.freeze([
  "When To Use",
  "Tools Referenced",
  "Byte Path",
  "Safety Gates",
  "Playbook",
]);

const FRONTMATTER_RE = /^---\r?\n(?<body>[\s\S]*?)\r?\n---\r?\n/;
const H2_RE = /^##\s+(?<title>.+?)\s*$/gm;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const BACKTICK_TOOL_REF_RE = /`((?:b2|s3)_[a-z0-9_]+)`/g;
const TOOL_BULLET_RE = /^\s*-\s*`((?:b2|s3)_[a-z0-9_]+)`/gm;
const TRIGGER_RE = /^\s*-\s*Trigger\s*:/m;
const SAFETY_GATE_LINE_RE = /^\s*-\s*`((?:b2|s3)_[a-z0-9_]+)`(?::|\s|$)/;
const CONFIRM_DIRECTIVE_RE = /confirm\s*:\s*true/i;

// These exact phrases are a published pack contract. They keep safety-critical
// prose auditable across Markdown-only clients, so update tests when changing them.
const BYTE_PATH_REQUIRED_PHRASES = Object.freeze([
  "never route object bytes through the model",
  "never route object bytes through the mcp server",
]);

const BYTE_PATH_HANDOFF_TERMS = Object.freeze([
  "client-to-b2",
  "presigned url",
  "presigned urls",
  "server-side copy",
  "no object bytes are involved",
]);

const SECRET_PATTERNS = Object.freeze([
  {
    label: "credential assignment",
    pattern:
      /\b(?:B2_APPLICATION_KEY|B2_MASTER_KEY|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|B2_APPLICATION_KEY_ID|AWS_ACCESS_KEY_ID)\s*=\s*['"]?[A-Za-z0-9+/_=-]{8,}/i,
  },
  {
    label: "secret field",
    pattern:
      /\b(?:applicationKey|appKey|masterKey|secretAccessKey|authorizationToken)\b["']?\s*[:=]\s*["']?[A-Za-z0-9+/_=-]{12,}/i,
  },
  {
    label: "account id field",
    pattern: /\b(?:accountId|account_id)\b["']?\s*[:=]\s*["']?[A-Za-z0-9-]{10,}/i,
  },
  {
    label: "presigned URL",
    pattern: /https?:\/\/\S+(?:X-Amz-Signature|X-Amz-Credential|AWSAccessKeyId|Signature)=/i,
  },
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function relativePath(from, target) {
  return toPosix(path.relative(from, target) || ".");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function orderedUnique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function parseFrontmatter(text, location) {
  const match = text.match(FRONTMATTER_RE);
  if (!match) {
    return {
      metadata: {},
      markdown: text,
      errors: [`${location}: missing YAML-style frontmatter`],
    };
  }

  const metadata = {};
  const errors = [];
  const lines = match.groups.body.split(/\r?\n/);
  for (const [offset, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (!line.includes(":")) {
      errors.push(`${location}:${offset + 2}: invalid frontmatter line`);
      continue;
    }
    const [rawKey, ...rawValue] = line.split(":");
    const key = rawKey.trim();
    const value = rawValue
      .join(":")
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (!key) {
      errors.push(`${location}:${offset + 2}: empty frontmatter key`);
      continue;
    }
    metadata[key] = value;
  }

  return {
    metadata,
    markdown: text.slice(match[0].length),
    errors,
  };
}

function sections(markdown) {
  const matches = [...markdown.matchAll(H2_RE)];
  const result = {};
  for (const [index, match] of matches.entries()) {
    const title = match.groups.title.trim();
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    result[title] = markdown.slice(start, end).trim();
  }
  return result;
}

function knownToolReferenceRegex(knownTools) {
  const alternatives = [...knownTools].sort((left, right) => right.length - left.length);
  if (alternatives.length === 0) return null;
  return new RegExp(
    `(?<![A-Za-z0-9_])(${alternatives.map(escapeRegExp).join("|")})(?![A-Za-z0-9_])`,
    "g",
  );
}

function knownToolReferences(markdown, knownTools) {
  const regex = knownToolReferenceRegex(knownTools);
  if (!regex) return [];
  return orderedUnique([...markdown.matchAll(regex)].map((match) => match[1]));
}

function backtickedToolReferences(markdown) {
  return orderedUnique([...markdown.matchAll(BACKTICK_TOOL_REF_RE)].map((match) => match[1]));
}

function loadContract(contractPath) {
  const data = JSON.parse(readFileSync(contractPath, "utf8"));
  const fullProfile = data?.profiles?.full;
  if (!fullProfile || !Array.isArray(fullProfile.names)) {
    throw new Error(`${contractPath}: missing profiles.full.names`);
  }

  const knownTools = new Set(fullProfile.names);
  const gatedTools = new Set([
    ...(Array.isArray(fullProfile.confirmTools) ? fullProfile.confirmTools : []),
    ...(Array.isArray(fullProfile.destructiveConfirmTools)
      ? fullProfile.destructiveConfirmTools
      : []),
  ]);
  const unknownGates = [...gatedTools].filter((name) => !knownTools.has(name)).sort();
  if (unknownGates.length > 0) {
    throw new Error(
      `${contractPath}: gated tools are not present in full tool surface: ${unknownGates.join(
        ", ",
      )}`,
    );
  }

  return { knownTools, gatedTools };
}

function loadManifest(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function manifestSkillEntries(manifest) {
  return Array.isArray(manifest?.skills) ? manifest.skills : [];
}

function validateManifest(manifest, manifestPath, root, errors) {
  const rel = relativePath(root, manifestPath);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    errors.push(`${rel}: manifest must be a JSON object`);
    return;
  }
  if (manifest.schemaVersion !== 1) {
    errors.push(`${rel}: schemaVersion must be 1`);
  }
  if (String(manifest.packName ?? "").trim() !== "backblaze-b2-phase1") {
    errors.push(`${rel}: packName must be backblaze-b2-phase1`);
  }
  if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
    errors.push(`${rel}: manifest must list Phase 1 skills`);
    return;
  }

  const names = new Set();
  const paths = new Set();
  for (const [index, entry] of manifest.skills.entries()) {
    const label = `${rel}: skills[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label} must be an object`);
      continue;
    }

    const name = String(entry.name ?? "").trim();
    const skillPath = String(entry.path ?? "").trim();
    const description = String(entry.description ?? "").trim();
    if (!name) {
      errors.push(`${label}.name must be non-empty`);
    } else if (!SKILL_NAME_RE.test(name)) {
      errors.push(`${label}.name must match ${SKILL_NAME_RE.source}`);
    } else if (names.has(name)) {
      errors.push(`${label}.name '${name}' is duplicated`);
    }
    if (name) names.add(name);

    if (!description) {
      errors.push(`${label}.description must be non-empty`);
    }

    if (!skillPath) {
      errors.push(`${label}.path must be non-empty`);
    } else {
      const expectedPath = name ? `skills/${name}/SKILL.md` : "";
      if (
        skillPath.includes("\\") ||
        skillPath.startsWith("/") ||
        skillPath.split("/").includes("..")
      ) {
        errors.push(`${label}.path must be a relative POSIX path below skills/`);
      }
      if (name && skillPath !== expectedPath) {
        errors.push(`${label}.path must be ${expectedPath}`);
      }
      if (paths.has(skillPath)) {
        errors.push(`${label}.path '${skillPath}' is duplicated`);
      }
      paths.add(skillPath);
    }
  }
}

function validateMetadata(metadata, skillPath, skillsDir, errors) {
  const rel = relativePath(path.dirname(skillsDir), skillPath);
  const name = String(metadata.name ?? "").trim();
  const description = String(metadata.description ?? "").trim();

  if (!name) {
    errors.push(`${rel}: frontmatter requires non-empty name`);
  } else if (!SKILL_NAME_RE.test(name)) {
    errors.push(`${rel}: skill name must match ${SKILL_NAME_RE.source}`);
  } else if (path.basename(path.dirname(skillPath)) !== name) {
    errors.push(`${rel}: skill directory must match frontmatter name '${name}'`);
  }

  if (!description) {
    errors.push(`${rel}: frontmatter requires non-empty description`);
  }
}

function validateSections(sectionMap, rel, errors) {
  for (const title of REQUIRED_SECTIONS) {
    if (!sectionMap[title]) {
      errors.push(`${rel}: missing required section '## ${title}'`);
    }
  }

  if (sectionMap["When To Use"] && !TRIGGER_RE.test(sectionMap["When To Use"])) {
    errors.push(`${rel}: When To Use must include at least one '- Trigger:' bullet`);
  }
}

function validateTools(markdown, sectionMap, rel, contract, errors) {
  const referencedTools = orderedUnique(
    [...String(sectionMap["Tools Referenced"] ?? "").matchAll(TOOL_BULLET_RE)].map(
      (match) => match[1],
    ),
  );
  if (referencedTools.length === 0) {
    errors.push(`${rel}: Tools Referenced must list at least one backticked MCP tool`);
  }

  const referencedKnownTools = new Set(knownToolReferences(markdown, contract.knownTools));
  const referencedBacktickedTools = new Set(backtickedToolReferences(markdown));
  const referencedToolSet = new Set(referencedTools);
  const unlisted = [...referencedKnownTools].filter((name) => !referencedToolSet.has(name)).sort();
  if (unlisted.length > 0) {
    errors.push(`${rel}: tool references missing from Tools Referenced: ${unlisted.join(", ")}`);
  }

  const unknownBackticked = [...referencedBacktickedTools]
    .filter((name) => !contract.knownTools.has(name))
    .sort();
  if (unknownBackticked.length > 0) {
    errors.push(
      `${rel}: tool references are not in the full tool surface: ${unknownBackticked.join(", ")}`,
    );
  }

  return referencedTools;
}

function validateBytePath(sectionMap, rel, errors) {
  const body = String(sectionMap["Byte Path"] ?? "");
  const lower = body.toLowerCase();
  for (const phrase of BYTE_PATH_REQUIRED_PHRASES) {
    if (!lower.includes(phrase)) {
      errors.push(`${rel}: Byte Path must state '${phrase}'`);
    }
  }
  if (!BYTE_PATH_HANDOFF_TERMS.some((term) => lower.includes(term))) {
    errors.push(
      `${rel}: Byte Path must name a direct handoff such as presigned URLs, client-to-B2 transfer, server-side copy, or no object bytes involved`,
    );
  }
}

function safetyGateLinesByTool(body) {
  const linesByTool = new Map();
  for (const line of String(body).split(/\r?\n/)) {
    const match = line.match(SAFETY_GATE_LINE_RE);
    if (!match) continue;
    const tool = match[1];
    const lines = linesByTool.get(tool) ?? [];
    lines.push(line);
    linesByTool.set(tool, lines);
  }
  return linesByTool;
}

function validateSafetyGates(sectionMap, rel, referencedTools, contract, errors) {
  const body = String(sectionMap["Safety Gates"] ?? "");
  const lower = body.toLowerCase();
  const gatedUsed = [
    ...new Set(referencedTools.filter((name) => contract.gatedTools.has(name))),
  ].sort();

  if (!lower.includes("pause")) {
    errors.push(`${rel}: Safety Gates must require a pause before risky actions`);
  }
  if (!lower.includes("explicit user confirmation")) {
    errors.push(`${rel}: Safety Gates must require explicit user confirmation`);
  }
  if (!lower.includes("b2_destructive_policy")) {
    errors.push(`${rel}: Safety Gates must reference B2_DESTRUCTIVE_POLICY`);
  }

  if (gatedUsed.length > 0) {
    const linesByTool = safetyGateLinesByTool(body);
    for (const tool of gatedUsed) {
      const lines = linesByTool.get(tool) ?? [];
      if (lines.length === 0) {
        errors.push(`${rel}: missing safety gate for ${tool}`);
      } else if (!lines.some((line) => CONFIRM_DIRECTIVE_RE.test(line))) {
        errors.push(`${rel}: safety gate for ${tool} must state confirm: true`);
      }
    }
  } else if (!lower.includes("no destructive or protection-weakening tools")) {
    errors.push(
      `${rel}: Safety Gates must explicitly say no destructive or protection-weakening tools are used when no gated tool is listed`,
    );
  }
}

function validateNoSecrets(text, rel, errors) {
  for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
    for (const { label, pattern } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        errors.push(
          `${rel}:${lineIndex + 1}: credential-shaped content must not appear in shipped SKILL.md (${label})`,
        );
      }
    }
  }
}

function validateSkill(skillPath, skillsDir, contract) {
  const rel = relativePath(path.dirname(skillsDir), skillPath);
  const text = readFileSync(skillPath, "utf8");
  const { metadata, markdown, errors } = parseFrontmatter(text, rel);

  validateNoSecrets(text, rel, errors);
  validateMetadata(metadata, skillPath, skillsDir, errors);
  const sectionMap = sections(markdown);
  validateSections(sectionMap, rel, errors);
  const referencedTools = validateTools(text, sectionMap, rel, contract, errors);
  validateBytePath(sectionMap, rel, errors);
  validateSafetyGates(sectionMap, rel, referencedTools, contract, errors);

  return { name: metadata.name, errors };
}

function discoveredSkillFiles(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsDir, entry.name, "SKILL.md"))
    .filter((skillPath) => existsSync(skillPath))
    .sort();
}

function validateExpectedSkillSet(skillsDir, root, manifest, errors) {
  const expectedNames = new Set(manifestSkillEntries(manifest).map((entry) => String(entry.name)));
  const seenNames = new Map();

  for (const skillPath of discoveredSkillFiles(skillsDir)) {
    const rel = relativePath(root, skillPath);
    const text = readFileSync(skillPath, "utf8");
    const { metadata, errors: parseErrors } = parseFrontmatter(text, rel);
    errors.push(...parseErrors);
    const name = String(metadata.name ?? "").trim();
    if (!name) continue;
    if (seenNames.has(name)) {
      errors.push(`${rel}: duplicate skill name '${name}' also used by ${seenNames.get(name)}`);
    }
    seenNames.set(name, rel);
  }

  const actualNames = new Set(seenNames.keys());
  const missing = [...expectedNames].filter((name) => !actualNames.has(name)).sort();
  const unexpected = [...actualNames].filter((name) => !expectedNames.has(name)).sort();
  if (missing.length > 0) {
    errors.push(`skills: missing expected Phase 1 skill(s): ${missing.join(", ")}`);
  }
  if (unexpected.length > 0) {
    errors.push(`skills: unexpected Phase 1 skill(s): ${unexpected.join(", ")}`);
  }
}

function uniqueSorted(errors) {
  return [...new Set(errors)].sort();
}

function validatePack({ root, skillsDir, contractPath, manifestPath }) {
  const errors = [];
  if (!existsSync(skillsDir)) {
    return [`${relativePath(root, skillsDir)}: skills directory is missing`];
  }

  let contract;
  try {
    contract = loadContract(contractPath);
  } catch (error) {
    return [error.message];
  }

  let manifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (error) {
    return [`${relativePath(root, manifestPath)}: ${error.message}`];
  }

  validateManifest(manifest, manifestPath, root, errors);
  validateExpectedSkillSet(skillsDir, root, manifest, errors);

  for (const skillPath of discoveredSkillFiles(skillsDir)) {
    errors.push(...validateSkill(skillPath, skillsDir, contract).errors);
  }

  return uniqueSorted(errors);
}

function parseArgs(argv) {
  const args = { root: path.resolve(__dirname, "..") };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      args.root = path.resolve(argv[++index]);
    } else if (arg === "--skills-dir") {
      args.skillsDir = path.resolve(argv[++index]);
    } else if (arg === "--contract") {
      args.contractPath = path.resolve(argv[++index]);
    } else if (arg === "--manifest") {
      args.manifestPath = path.resolve(argv[++index]);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  args.skillsDir ??= path.join(args.root, "skills");
  args.contractPath ??= path.join(args.root, "docs", "tool-profile-contract.json");
  args.manifestPath ??= path.join(args.root, "skills", "manifest.json");
  return args;
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`validate-pack: ${error.message}`);
    return 2;
  }

  const errors = validatePack(args);
  if (errors.length > 0) {
    for (const error of errors) console.error(`validate-pack: ${error}`);
    return 1;
  }

  const manifest = loadManifest(args.manifestPath);
  console.log(`validate-pack: validated ${manifestSkillEntries(manifest).length} skill(s)`);
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  knownToolReferences,
  loadContract,
  loadManifest,
  main,
  parseFrontmatter,
  safetyGateLinesByTool,
  validatePack,
};
