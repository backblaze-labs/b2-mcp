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

// Single-character YAML double-quote escapes. JSON.parse handles a subset of
// these plus \uXXXX, but YAML also supports \xXX, \U00XXXXXX, and letter
// escapes like \N/\_/\L/\P that JSON rejects. Decoding them ourselves keeps the
// parser fail-closed: an escaped structural token such as "u\x73es" resolves to
// `uses`, so leaving it undecoded would let an escaped key hide an action.
const YAML_SIMPLE_ESCAPES = {
  0: "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\u0085",
  _: "\u00a0",
  L: "\u2028",
  P: "\u2029",
};

function decodeYamlDoubleQuoted(inner) {
  let out = "";
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = inner[index + 1];
    if (next === undefined) {
      out += char;
      break;
    }
    if (next === "x" || next === "u" || next === "U") {
      const width = next === "x" ? 2 : next === "u" ? 4 : 8;
      const hex = inner.slice(index + 2, index + 2 + width);
      if (hex.length === width && /^[0-9a-fA-F]+$/.test(hex)) {
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        index += 1 + width;
        continue;
      }
      // Malformed hex escape: leave it undecoded so it cannot spell a token.
      out += char;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(YAML_SIMPLE_ESCAPES, next)) {
      out += YAML_SIMPLE_ESCAPES[next];
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

// Workflow policy tests need only small GitHub Actions snippets and deliberately
// strip inline comments. pnpm-lock.cjs has a separate fail-closed parser for the
// stricter pnpm-lock.yaml trust boundary, so these helpers are not
// interchangeable YAML primitives.
function unquoteYamlScalar(value) {
  const trimmed = stripInlineComment(value);
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return decodeYamlDoubleQuoted(trimmed.slice(1, -1));
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

function workflowJobsRegion(text) {
  const lines = text.split(/\r?\n/);
  const jobsEntries = lines
    .map((line, index) => {
      const entry = yamlMappingEntry(line);
      return entry?.key === "jobs" && hasEmptyOrAnchorValue(entry.rawValue)
        ? { index, indent: entry.indent }
        : null;
    })
    .filter(Boolean);
  if (jobsEntries.length === 0) return null;

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
  if (jobIndents.length === 0) return null;

  return { jobsLines, jobIndent: Math.min(...jobIndents) };
}

function workflowJobBlocks(text) {
  const region = workflowJobsRegion(text);
  if (!region) return [];

  const { jobsLines, jobIndent } = region;
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

// Fail closed on job keys this block parser cannot turn into a step block. A
// flow-style mapping (`deploy: { steps: [...] }`) or any inline scalar value at
// job indent is skipped by workflowJobBlocks, so callers that only inspect
// parsed job blocks would never see a Pages action hidden in that form. Callers
// treat a non-empty return as a policy failure instead of silently proceeding.
function unsupportedWorkflowJobForms(text) {
  const region = workflowJobsRegion(text);
  if (!region) return [];

  const { jobsLines, jobIndent } = region;
  return jobsLines
    .map((line) => {
      const entry = yamlMappingEntry(line);
      return entry?.indent === jobIndent && !hasEmptyOrAnchorValue(entry.rawValue)
        ? entry.key
        : null;
    })
    .filter(Boolean);
}

module.exports = {
  decodeYamlDoubleQuoted,
  yamlValuesForKey,
  yamlMappingEntry,
  yamlBlockForKey,
  yamlMappingForKey,
  valuesEqual,
  workflowJobBlock,
  workflowJobBlocks,
  unsupportedWorkflowJobForms,
};
