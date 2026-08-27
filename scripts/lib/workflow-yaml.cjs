function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripInlineComment(value) {
  return value.replace(/\s+#.*$/, "").trim();
}

// Workflow policy tests need only small GitHub Actions snippets and deliberately
// strip inline comments. pnpm-lock.cjs has a separate fail-closed parser for the
// stricter pnpm-lock.yaml trust boundary, so these helpers are not
// interchangeable YAML primitives.
function unquoteYamlScalar(value) {
  const trimmed = stripInlineComment(value);
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineYamlList(value) {
  const trimmed = stripInlineComment(value);
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => unquoteYamlScalar(item))
    .filter(Boolean);
}

function yamlBlockForKey(text, key) {
  const lines = text.split(/\r?\n/);
  const keyPattern = new RegExp(`^(\\s*)${escapeRegExp(key)}:\\s*(?:#.*)?$`);

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(keyPattern);
    if (!match) continue;

    const indent = match[1].length;
    const blockLines = [];
    for (let child = index + 1; child < lines.length; child += 1) {
      const childLine = lines[child];
      if (childLine.trim()) {
        const childIndent = childLine.match(/^\s*/)?.[0].length ?? 0;
        if (childIndent <= indent) break;
      }
      blockLines.push(childLine);
    }
    return blockLines.join("\n");
  }

  return null;
}

function yamlMappingForKey(text, key) {
  const block = yamlBlockForKey(text, key);
  if (block === null) return null;

  const lines = block.split(/\r?\n/);
  const childIndents = lines
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  if (childIndents.length === 0) return {};

  const childIndent = Math.min(...childIndents);
  const mapping = {};
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent !== childIndent) continue;
    const match = line.slice(childIndent).match(/^([^:#]+):\s*(.*)$/);
    if (!match) continue;
    const rawValue = match[2].trim();
    const inlineList = parseInlineYamlList(rawValue);
    mapping[match[1].trim()] = inlineList ?? unquoteYamlScalar(rawValue);
  }
  return mapping;
}

function yamlValuesForKey(text, key) {
  const lines = text.split(/\r?\n/);
  const keyPattern = new RegExp(`^(\\s*)${escapeRegExp(key)}:\\s*(.*)$`);
  const values = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(keyPattern);
    if (!match) continue;

    const indent = match[1].length;
    const rawValue = match[2].trim();
    const inlineList = parseInlineYamlList(rawValue);
    if (inlineList) {
      values.push(inlineList);
      continue;
    }
    if (rawValue) {
      values.push(unquoteYamlScalar(rawValue));
      continue;
    }

    const blockValues = [];
    for (let child = index + 1; child < lines.length; child += 1) {
      const childLine = lines[child];
      if (!childLine.trim() || childLine.trim().startsWith("#")) continue;
      const childIndent = childLine.match(/^\s*/)?.[0].length ?? 0;
      if (childIndent <= indent) break;
      const item = childLine.trim().match(/^-\s+(.+)$/);
      if (item) blockValues.push(unquoteYamlScalar(item[1]));
    }
    if (blockValues.length > 0) values.push(blockValues);
  }

  return values;
}

function valuesEqual(actual, expected) {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function workflowJobBlock(text, jobName) {
  const job = workflowJobBlocks(text).find((candidate) => candidate.name === jobName);
  return job?.block ?? null;
}

function workflowJobBlocks(text) {
  const lines = text.split(/\r?\n/);
  const jobsEntries = lines
    .map((line, index) => {
      const match = line.match(/^(\s*)jobs:\s*(?:#.*)?$/);
      return match ? { index, indent: match[1].length } : null;
    })
    .filter(Boolean);
  if (jobsEntries.length === 0) return [];

  const { index: jobsIndex, indent: jobsIndent } = jobsEntries.reduce((least, entry) =>
    entry.indent < least.indent ? entry : least,
  );
  const jobsLines = [];
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && !line.trimStart().startsWith("#")) {
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= jobsIndent) break;
    }
    jobsLines.push(line);
  }

  const jobIndents = jobsLines
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0)
    .filter((indent) => indent > jobsIndent);
  if (jobIndents.length === 0) return [];

  const jobIndent = Math.min(...jobIndents);
  const jobsText = jobsLines.join("\n");
  const matches = [
    ...jobsText.matchAll(
      new RegExp(`^ {${jobIndent}}([A-Za-z0-9_-]+):\\s*(?:&\\S+)?\\s*(?:#.*)?$`, "gm"),
    ),
  ];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? jobsText.length;
    return { name: match[1], block: jobsText.slice(start, end) };
  });
}

module.exports = {
  yamlValuesForKey,
  yamlBlockForKey,
  yamlMappingForKey,
  valuesEqual,
  workflowJobBlock,
  workflowJobBlocks,
};
