function stripInlineComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote === "'") {
      if (char === "'" && value[index + 1] === "'") index += 1;
      else if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === "\\") index += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

// Workflow policy tests need only small GitHub Actions snippets and deliberately
// strip inline comments. pnpm-lock.cjs has a separate fail-closed parser for the
// stricter pnpm-lock.yaml trust boundary, so these helpers are not
// interchangeable YAML primitives.
function unquoteYamlScalar(value) {
  const trimmed = stripInlineComment(value);
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function yamlMappingEntry(line) {
  const indent = line.match(/^\s*/)?.[0].length ?? 0;
  const body = line.slice(indent);
  let quote = null;

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote === "'") {
      if (char === "'" && body[index + 1] === "'") index += 1;
      else if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === "\\") index += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(body[index - 1]))) break;
    if (char !== ":") continue;
    if (body[index + 1] && !/\s|#/.test(body[index + 1])) continue;

    const rawKey = body.slice(0, index).trim();
    if (!rawKey) return null;
    return {
      indent,
      key: unquoteYamlScalar(rawKey),
      rawValue: body.slice(index + 1).trim(),
    };
  }

  return null;
}

function hasEmptyOrAnchorValue(rawValue) {
  const value = stripInlineComment(rawValue);
  return value === "" || /^&[^\s]+$/.test(value);
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

  for (let index = 0; index < lines.length; index += 1) {
    const entry = yamlMappingEntry(lines[index]);
    if (!entry || entry.key !== key || !hasEmptyOrAnchorValue(entry.rawValue)) continue;

    const indent = entry.indent;
    const blockLines = [];
    for (let child = index + 1; child < lines.length; child += 1) {
      const childLine = lines[child];
      if (childLine.trim() && !childLine.trimStart().startsWith("#")) {
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
    const entry = yamlMappingEntry(line);
    if (!entry || entry.indent !== childIndent) continue;
    const rawValue = entry.rawValue.trim();
    const inlineList = parseInlineYamlList(rawValue);
    mapping[entry.key] = inlineList ?? unquoteYamlScalar(rawValue);
  }
  return mapping;
}

function yamlValuesForKey(text, key) {
  const lines = text.split(/\r?\n/);
  const values = [];

  for (let index = 0; index < lines.length; index += 1) {
    const entry = yamlMappingEntry(lines[index]);
    if (!entry || entry.key !== key) continue;

    const indent = entry.indent;
    const rawValue = entry.rawValue.trim();
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
      const entry = yamlMappingEntry(line);
      return entry?.key === "jobs" && hasEmptyOrAnchorValue(entry.rawValue)
        ? { index, indent: entry.indent }
        : null;
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
  const matches = jobsLines
    .map((line, index) => {
      const entry = yamlMappingEntry(line);
      return entry?.indent === jobIndent && hasEmptyOrAnchorValue(entry.rawValue)
        ? { index, name: entry.key }
        : null;
    })
    .filter(Boolean);
  return matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? jobsLines.length;
    return { name: match.name, block: jobsLines.slice(match.index, end).join("\n") };
  });
}

module.exports = {
  yamlValuesForKey,
  yamlMappingEntry,
  yamlBlockForKey,
  yamlMappingForKey,
  valuesEqual,
  workflowJobBlock,
  workflowJobBlocks,
};
