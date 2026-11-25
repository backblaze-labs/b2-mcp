const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const ts = require("typescript");

const profiles = new Set(["http-oauth", "secret-recovery"]);

function mutationProfileConfig(profile, base, root = resolve(__dirname, "../..")) {
  if (!profiles.has(profile)) throw new Error(`Unknown mutation profile: ${profile}`);
  const manifest = JSON.parse(
    readFileSync(join(root, "mutation-scopes", `${profile}.json`), "utf8"),
  );
  if (
    typeof manifest.description !== "string" ||
    manifest.description.trim().length === 0 ||
    !Array.isArray(manifest.targets) ||
    manifest.targets.length === 0
  ) {
    throw new Error(`Invalid mutation profile ${profile}: a description and targets are required`);
  }

  const mutate = [];
  const files = new Set();
  for (const target of manifest.targets) {
    if (
      !target ||
      typeof target.file !== "string" ||
      !/^src\/[A-Za-z0-9_./-]+\.ts$/.test(target.file) ||
      target.file.split("/").some((part) => part === "." || part === ".." || part === "") ||
      files.has(target.file) ||
      !Array.isArray(target.declarations) ||
      target.declarations.length === 0 ||
      target.declarations.some((name) => typeof name !== "string" || name.trim().length === 0) ||
      new Set(target.declarations).size !== target.declarations.length
    ) {
      throw new Error(`Invalid mutation profile ${profile}: explicit source declarations required`);
    }
    files.add(target.file);
    const source = ts.createSourceFile(
      target.file,
      readFileSync(join(root, target.file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const name of target.declarations) {
      const matches = source.statements.filter(
        (node) =>
          node.name?.text === name &&
          ((ts.isFunctionDeclaration(node) && node.body) || ts.isClassDeclaration(node)),
      );
      if (matches.length !== 1) {
        throw new Error(
          `Mutation profile ${profile}: expected one implementation of ${name} in ${target.file}`,
        );
      }
      const node = matches[0];
      const first = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const last = source.getLineAndCharacterOfPosition(node.end - 1).line + 1;
      mutate.push(`${target.file}:${first}-${last}`);
    }
  }

  return {
    ...base,
    mutate,
    jsonReporter: { fileName: `reports/mutation/${profile}/mutation.json` },
    htmlReporter: { fileName: `reports/mutation/${profile}/mutation.html` },
    tempDirName: `.stryker-tmp/${profile}`,
  };
}

module.exports = { mutationProfileConfig };
