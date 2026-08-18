#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packManifestPath = "skills/pack.json";
const requiredSections = ["When to use", "Byte path", "Safety gates", "Tools used", "Playbook"];
const toolRe = /\b(?:b2|s3|bz)_[a-z0-9_]+\b/g;

/*
 * These checks are intentionally structural guardrails, not a proof that
 * arbitrary prose is safe. Byte-path units are accepted only when object-data
 * wording, movement wording, negation, and the model/chat/MCP-server target
 * appear in the same sentence or bullet, with the negation before the movement
 * verb and target. Affirmative object-data movement to the model/chat/server is
 * always rejected, even if another sentence has the canonical safe wording.
 *
 * Safety-gate units are accepted only when the same bullet or sentence names
 * each destructive tool and requires pause/explicit confirmation. Any unit that
 * also says approval can be skipped, omitted, optional, unnecessary, scoped only
 * to some targets, or not needed is rejected.
 */
const byteSubjectRe =
  /\b(?:object\s+(?:data|bytes|contents?|bodies|payloads?)|bulk\s+object\s+bytes)\b/i;
const byteRouteVerbRe =
  /\b(?:route|send|sent|move|transfer|flow|stream|pass|enter|reach|upload|download|relay|forward|copy|fetch|read|store|dump|print)\b/i;
const byteNegationRe = /\b(?:must\s+not|never|do\s+not|don't|no)\b/i;
const modelOrServerDestRe = /\b(?:model|chat|mcp\s+server|server)\b/i;
const directToB2Re =
  /\bdirect(?:ly)?\b[\s\S]{0,140}\b(?:client|workload|worker)\b[\s\S]{0,140}\bb2\b|\b(?:client|workload|worker)\b[\s\S]{0,140}\bdirect(?:ly)?\b[\s\S]{0,140}\bb2\b/i;
const negatedDirectToB2Re =
  /\b(?:must\s+not|never|do\s+not|don't|no)\b[\s\S]{0,100}\bdirect(?:ly)?\b|\bdirect(?:ly)?\b[\s\S]{0,100}\b(?:must\s+not|never|do\s+not|don't|no)\b/i;
const confirmationGateRe =
  /\b(?:pause|stop|ask|require|requires|requiring)\b[\s\S]{0,160}\b(?:explicit\s+)?(?:confirmation|approval)\b|\b(?:explicit\s+)?(?:confirmation|approval)\b[\s\S]{0,160}\b(?:pause|stop|ask|require|requires|requiring)\b/i;
const gateWeakeningRe =
  /\b(?:do\s+not|don't|never)\b[\s\S]{0,90}\b(?:pause|confirm|confirmation|approval|ask|require)\b|\b(?:without|skip|omit|bypass(?:ing)?)\s+(?:the\s+)?(?:pause|confirm|confirmation|approval)\b|\bno\s+(?:explicit\s+)?(?:approval|confirmation)\s+(?:needed|required)?\b|\b(?:approval|confirmation)\b[\s\S]{0,80}\b(?:not\s+required|not\s+needed|unnecessary|optional)\b|\b(?:for\s+all\s+other|otherwise|non-production|nonproduction)\b[\s\S]{0,120}\b(?:no|without|skip|omit|bypass|optional|unnecessary)\b[\s\S]{0,60}\b(?:approval|confirmation|confirm|pause)\b|\b(?:only|just)\b[\s\S]{0,40}\b(?:production|prod|public|external|matching|listed|selected)\b[\s\S]{0,80}\b(?:approval|confirmation|confirm|pause)\b/i;
const secretPathParts = new Set([
  ".env",
  ".env.local",
  ".npmrc",
  "credentials",
  "secrets",
  "private.key",
]);
const secretValuePatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:B2_APPLICATION_KEY|B2_MASTER_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|NPM_TOKEN)\s*[:=]/i,
  /\b(?:applicationKey|application_key|secretAccessKey|privateKey|password)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{12,}/i,
  // cspell:disable-next-line
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bK[0-9A-Za-z]{20,}\b/,
];

function fail(message) {
  console.error(`validate_pack: ${message}`);
  process.exit(1);
}

function readText(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`${filePath}: ${error.message}`);
  }
}

function readJson(root, relativePath) {
  const filePath = path.join(root, relativePath);
  try {
    return JSON.parse(readText(filePath));
  } catch (error) {
    fail(`${filePath}: invalid JSON: ${error.message}`);
  }
}

function sorted(values) {
  return [...values].sort();
}

function difference(left, right) {
  return new Set([...left].filter((item) => !right.has(item)));
}

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function parseFrontmatter(text, filePath) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) fail(`${filePath}: missing YAML frontmatter`);

  const values = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator === -1) fail(`${filePath}: invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^"|"$/g, "");
    values.set(key, value);
  }
  return values;
}

function sectionBodies(text) {
  const headings = [...text.matchAll(/^##\s+(.+?)\s*$/gm)];
  const sections = new Map();
  for (const [index, heading] of headings.entries()) {
    const start = heading.index + heading[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length;
    sections.set(heading[1].trim(), text.slice(start, end).trim());
  }
  return sections;
}

function loadContract(root) {
  const contractPath = path.join("docs", "tool-profile-contract.json");
  const contract = readJson(root, contractPath);
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    fail(`${path.join(root, contractPath)}: expected JSON object`);
  }
  const fullProfile = contract.profiles?.full;
  if (!fullProfile || typeof fullProfile !== "object" || Array.isArray(fullProfile)) {
    fail(`${path.join(root, contractPath)}: missing profiles.full`);
  }
  const { names, destructiveConfirmTools } = fullProfile;
  if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) {
    fail(`${path.join(root, contractPath)}: profiles.full.names must be a string array`);
  }
  if (
    !Array.isArray(destructiveConfirmTools) ||
    !destructiveConfirmTools.every((name) => typeof name === "string")
  ) {
    fail(
      `${path.join(root, contractPath)}: profiles.full.destructiveConfirmTools must be a string array`,
    );
  }
  const allTools = new Set(names);
  const destructiveTools = new Set(destructiveConfirmTools);
  if (destructiveTools.size === 0) {
    fail(`${path.join(root, contractPath)}: destructiveConfirmTools must not be empty`);
  }
  if (difference(destructiveTools, allTools).size > 0) {
    fail(
      `${path.join(root, contractPath)}: destructiveConfirmTools contains tools missing from names`,
    );
  }
  return { allTools, destructiveTools };
}

function loadManifest(root) {
  const manifest = readJson(root, packManifestPath);
  const manifestLocation = path.join(root, packManifestPath);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail(`${manifestLocation}: expected JSON object`);
  }
  if (manifest.schemaVersion !== 1) fail(`${manifestLocation}: schemaVersion must be 1`);
  if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
    fail(`${manifestLocation}: skills must be a non-empty array`);
  }

  const normalized = [];
  const seenNames = new Set();
  for (const [index, skill] of manifest.skills.entries()) {
    if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
      fail(`${manifestLocation}: skills[${index}] must be an object`);
    }
    const { name, path: skillPath } = skill;
    if (typeof name !== "string" || !/^b2-[a-z0-9-]+$/.test(name)) {
      fail(`${manifestLocation}: skills[${index}].name must be a b2-* slug`);
    }
    if (typeof skillPath !== "string" || skillPath !== `${name}/SKILL.md`) {
      fail(`${manifestLocation}: skills[${index}].path must be ${name}/SKILL.md`);
    }
    if (seenNames.has(name)) fail(`${manifestLocation}: duplicate skill name ${name}`);
    seenNames.add(name);
    normalized.push({ name, path: skillPath });
  }

  const expectedPackageFiles = new Set([
    packManifestPath,
    ...normalized.map((skill) => `skills/${skill.path}`),
  ]);
  if (
    !Array.isArray(manifest.packageFiles) ||
    !manifest.packageFiles.every((item) => typeof item === "string")
  ) {
    fail(`${manifestLocation}: packageFiles must be a string array`);
  }
  const packageFiles = new Set(manifest.packageFiles);
  if (
    difference(expectedPackageFiles, packageFiles).size > 0 ||
    difference(packageFiles, expectedPackageFiles).size > 0
  ) {
    fail(
      `${manifestLocation}: packageFiles must match declared skills exactly; missing=${JSON.stringify(
        sorted(difference(expectedPackageFiles, packageFiles)),
      )} unexpected=${JSON.stringify(sorted(difference(packageFiles, expectedPackageFiles)))}`,
    );
  }
  return { manifestSkills: normalized, expectedPackageFiles };
}

function validatePackageAllowlist(root, expectedPackageFiles) {
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = readJson(root, "package.json");
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    fail(`${packageJsonPath}: expected JSON object`);
  }
  if (
    !Array.isArray(packageJson.files) ||
    !packageJson.files.every((item) => typeof item === "string")
  ) {
    fail(`${packageJsonPath}: files must be a string array`);
  }
  const skillPackageEntries = new Set(
    packageJson.files.filter((item) => item.startsWith("skills/")),
  );
  if ([...skillPackageEntries].some((item) => item.includes("*"))) {
    fail(`${packageJsonPath}: skills package entries must be explicit, not globs`);
  }
  if (
    difference(expectedPackageFiles, skillPackageEntries).size > 0 ||
    difference(skillPackageEntries, expectedPackageFiles).size > 0
  ) {
    fail(
      `${packageJsonPath}: files must package the validated skill manifest exactly; missing=${JSON.stringify(
        sorted(difference(expectedPackageFiles, skillPackageEntries)),
      )} unexpected=${JSON.stringify(sorted(difference(skillPackageEntries, expectedPackageFiles)))}`,
    );
  }
}

function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(absolutePath));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

function shannonEntropy(token) {
  const counts = new Map();
  for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / token.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function stripRecognizedNonSecretTokens(text) {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b(?:\.github|deploy|docs|scripts|skills|src|tests)\/[A-Za-z0-9_./-]+/g, " ")
    .replace(/\b(?:b2|s3|bz)_[a-z0-9_]+\b/g, " ");
}

function hasHighEntropyToken(text) {
  const tokenRe = /\b[A-Za-z0-9][A-Za-z0-9+/=_-]{31,}\b/g;
  for (const match of stripRecognizedNonSecretTokens(text).matchAll(tokenRe)) {
    const token = match[0];
    if (!/[A-Za-z]/.test(token) || !/\d/.test(token)) continue;
    if (shannonEntropy(token) >= 3.8) return true;
  }
  return false;
}

function validateNoSecretLikeContent(filePath, relativePath) {
  const parts = new Set(relativePath.split("/").map((part) => part.toLowerCase()));
  if ([...parts].some((part) => secretPathParts.has(part))) {
    fail(`${relativePath}: secret-like path is not allowed in bundled skills`);
  }
  const text = readText(filePath);
  if (secretValuePatterns.some((pattern) => pattern.test(text)) || hasHighEntropyToken(text)) {
    fail(`${relativePath}: secret-like content is not allowed in bundled skills`);
  }
}

function validateSkillTree(root, expectedPackageFiles) {
  const skillsRoot = path.join(root, "skills");
  if (!existsSync(skillsRoot)) fail("skills directory is missing");
  const actualFiles = new Set(
    listFiles(skillsRoot).map((filePath) => toPosix(path.relative(root, filePath))),
  );
  for (const relativePath of sorted(actualFiles)) {
    validateNoSecretLikeContent(path.join(root, relativePath), relativePath);
  }
  if (
    difference(expectedPackageFiles, actualFiles).size > 0 ||
    difference(actualFiles, expectedPackageFiles).size > 0
  ) {
    fail(
      `skills directory must contain only manifest-declared packaged files; missing=${JSON.stringify(
        sorted(difference(expectedPackageFiles, actualFiles)),
      )} unexpected=${JSON.stringify(sorted(difference(actualFiles, expectedPackageFiles)))}`,
    );
  }
}

function textUnits(section) {
  const units = [];
  let current = [];
  for (const line of section.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped) continue;
    if (stripped.startsWith("- ")) {
      if (current.length > 0) units.push(current.join(" "));
      current = [stripped.slice(2).trim()];
    } else if (current.length > 0) {
      current.push(stripped);
    }
  }
  if (current.length > 0) units.push(current.join(" "));
  if (units.length > 0) return units;
  return section
    .split(/(?<=[.!?])\s+/u)
    .filter((unit) => unit.trim())
    .map((unit) => unit.trim());
}

function sentenceUnits(section) {
  return textUnits(section).flatMap((unit) =>
    unit
      .split(/(?<=[.!?])\s+/u)
      .filter((part) => part.trim())
      .map((part) => part.trim()),
  );
}

function clauses(unit) {
  return unit.split(/[;]\s*/).filter((clause) => clause.trim());
}

function forbidsObjectDataToModelOrServer(unit) {
  for (const clause of clauses(unit)) {
    const routeMatch = clause.match(byteRouteVerbRe);
    const destMatch = clause.match(modelOrServerDestRe);
    const negationMatch = clause.match(byteNegationRe);
    if (!(routeMatch && destMatch && negationMatch && byteSubjectRe.test(clause))) continue;
    if (negationMatch.index < routeMatch.index && negationMatch.index < destMatch.index) {
      return true;
    }
  }
  return false;
}

function allowsObjectDataToModelOrServer(unit) {
  for (const clause of clauses(unit)) {
    const routeMatch = clause.match(byteRouteVerbRe);
    if (!(routeMatch && byteSubjectRe.test(clause) && modelOrServerDestRe.test(clause))) {
      continue;
    }
    if (!byteNegationRe.test(clause.slice(0, routeMatch.index))) return true;
  }
  return false;
}

function requiresDirectObjectDataToB2(unit) {
  return byteSubjectRe.test(unit) && directToB2Re.test(unit) && !negatedDirectToB2Re.test(unit);
}

function weakensConfirmationGate(unit) {
  return gateWeakeningRe.test(unit);
}

function requiresConfirmationGate(unit) {
  return confirmationGateRe.test(unit) && !weakensConfirmationGate(unit);
}

function validateSkill(root, skillPath, expectedName, allTools, destructiveTools, namesSeen) {
  const text = readText(skillPath);
  const frontmatter = parseFrontmatter(text, skillPath);
  const name = frontmatter.get("name") ?? "";
  const description = frontmatter.get("description") ?? "";
  if (!/^b2-[a-z0-9-]+$/.test(name)) fail(`${skillPath}: frontmatter name must be a b2-* slug`);
  if (namesSeen.has(name)) fail(`${skillPath}: duplicate skill name ${name}`);
  namesSeen.add(name);
  if (name !== expectedName)
    fail(`${skillPath}: frontmatter name must match manifest name ${expectedName}`);
  if (path.basename(path.dirname(skillPath)) !== name) {
    fail(`${skillPath}: parent directory must match skill name ${name}`);
  }
  if (description.length < 40) fail(`${skillPath}: description must be at least 40 characters`);

  const sections = sectionBodies(text);
  const missing = requiredSections.filter((section) => !sections.has(section));
  if (missing.length > 0) fail(`${skillPath}: missing required sections: ${missing.join(", ")}`);

  const whenToUse = sections.get("When to use");
  if (!/^-\s+\S/m.test(whenToUse)) {
    fail(`${skillPath}: When to use must include explicit bullet triggers`);
  }

  const byteUnits = sentenceUnits(sections.get("Byte path"));
  if (!byteUnits.some((unit) => byteSubjectRe.test(unit))) {
    fail(`${skillPath}: Byte path must discuss object data/bytes`);
  }
  if (byteUnits.some((unit) => allowsObjectDataToModelOrServer(unit))) {
    fail(`${skillPath}: Byte path must not allow object bytes into the model/chat/MCP server`);
  }
  if (!byteUnits.some((unit) => forbidsObjectDataToModelOrServer(unit))) {
    fail(
      `${skillPath}: Byte path must forbid object bytes from entering the model/chat/MCP server`,
    );
  }
  if (!byteUnits.some((unit) => requiresDirectObjectDataToB2(unit))) {
    fail(`${skillPath}: Byte path must require direct client/workload-to-B2 transfer`);
  }

  const declaredTools = new Set(sections.get("Tools used").match(toolRe) ?? []);
  const mentionedTools = new Set(text.match(toolRe) ?? []);
  if (declaredTools.size === 0) {
    fail(`${skillPath}: Tools used must list at least one b2_* or s3_* tool`);
  }
  const unknownTools = difference(mentionedTools, allTools);
  if (unknownTools.size > 0) {
    fail(`${skillPath}: unknown tool references: ${sorted(unknownTools).join(", ")}`);
  }
  const undeclaredTools = difference(mentionedTools, declaredTools);
  if (undeclaredTools.size > 0) {
    fail(
      `${skillPath}: tools mentioned outside Tools used must also be listed there: ${sorted(
        undeclaredTools,
      ).join(", ")}`,
    );
  }

  const safetyUnits = textUnits(sections.get("Safety gates"));
  if (!safetyUnits.some((unit) => requiresConfirmationGate(unit))) {
    fail(`${skillPath}: Safety gates must include at least one explicit confirmation gate`);
  }
  for (const tool of sorted(
    new Set([...declaredTools].filter((name) => destructiveTools.has(name))),
  )) {
    const matchingUnits = safetyUnits.filter((unit) => unit.includes(tool));
    if (matchingUnits.length === 0) {
      fail(`${skillPath}: Safety gates must mention destructive tool ${tool}`);
    }
    const weakenedUnit = matchingUnits.find((unit) => weakensConfirmationGate(unit));
    if (weakenedUnit) {
      fail(`${skillPath}: Safety gate for ${tool} must not weaken or bypass approval`);
    }
    if (!matchingUnits.some((unit) => requiresConfirmationGate(unit))) {
      fail(
        `${skillPath}: Safety gate for ${tool} must require pause/explicit confirmation in the same bullet or sentence`,
      );
    }
  }

  const relativeToSkills = path.relative(path.join(root, "skills"), skillPath);
  if (relativeToSkills.startsWith("..") || path.isAbsolute(relativeToSkills)) {
    fail(`${skillPath}: skill must live under skills/`);
  }
}

function parseArgs(argv) {
  let root = defaultRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) fail("--root requires a path");
      root = path.resolve(value);
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  return { root };
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const { allTools, destructiveTools } = loadContract(root);
  const { manifestSkills, expectedPackageFiles } = loadManifest(root);
  validatePackageAllowlist(root, expectedPackageFiles);
  validateSkillTree(root, expectedPackageFiles);

  const namesSeen = new Set();
  for (const skill of manifestSkills) {
    validateSkill(
      root,
      path.join(root, "skills", skill.path),
      skill.name,
      allTools,
      destructiveTools,
      namesSeen,
    );
  }

  console.log(
    `Validated ${manifestSkills.length} B2 skills against ${allTools.size} tools and ${destructiveTools.size} destructive gates.`,
  );
}

main();
