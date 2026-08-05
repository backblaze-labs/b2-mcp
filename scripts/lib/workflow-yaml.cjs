function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripInlineComment(value) {
  return value.replace(/\s+#.*$/, "").trim();
}

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
  const start = text.search(new RegExp(`^  ${escapeRegExp(jobName)}:\\s*$`, "m"));
  if (start === -1) return null;
  const rest = text.slice(start + 1);
  const next = rest.search(/\n {2}[a-zA-Z0-9_-]+:\s*$/m);
  return next === -1 ? text.slice(start) : text.slice(start, start + 1 + next);
}

module.exports = {
  yamlValuesForKey,
  valuesEqual,
  workflowJobBlock,
};
