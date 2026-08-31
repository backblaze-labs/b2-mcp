import type { JsonCompatible } from "./result-serializer.js";

/**
 * TOON encoder used by compact tool result serialization.
 *
 * @remarks
 * The encoder keeps repeated object arrays in tabular form when possible while
 * preserving JSON-compatible scalar values and rejecting invalid UTF-16 input.
 */

interface ToonField {
  name: string;
  children?: ToonField[];
}

interface EncoderOptions {
  delimiter: ",";
  indentSize: 2;
}

const ENCODER_OPTIONS: EncoderOptions = {
  delimiter: ",",
  indentSize: 2,
};

const NUMERIC_LIKE_PATTERN = /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
const SURROGATE_PATTERN = /[\uD800-\uDFFF]/;

/**
 * Encode JSON-compatible data into TOON text.
 *
 * @param value - JSON-compatible value to encode.
 *
 * @returns TOON representation of the value.
 *
 * @throws TypeError when a string contains an unpaired surrogate.
 */
export function encodeToon(value: JsonCompatible): string {
  return [...encodeJsonValue(value, ENCODER_OPTIONS, 0)].join("\n");
}

function* encodeJsonValue(
  value: JsonCompatible,
  options: EncoderOptions,
  depth: number,
): Generator<string> {
  if (isPrimitive(value)) {
    const encodedPrimitive = encodePrimitive(value, options.delimiter);
    if (encodedPrimitive !== "") yield encodedPrimitive;
    return;
  }
  if (Array.isArray(value)) {
    yield* encodeArrayLines(undefined, value, depth, options);
    return;
  }

  const keyedFields = extractKeyedTabularFields(value);
  if (keyedFields) {
    yield* encodeKeyedObjectLines(undefined, value, keyedFields, depth, options);
    return;
  }
  yield* encodeObjectLines(value, depth, options);
}

function* encodeObjectLines(
  value: Record<string, JsonCompatible>,
  depth: number,
  options: EncoderOptions,
): Generator<string> {
  for (const [key, val] of Object.entries(value)) {
    yield* encodeKeyValuePairLines(key, val, depth, options);
  }
}

function* encodeKeyValuePairLines(
  key: string,
  value: JsonCompatible,
  depth: number,
  options: EncoderOptions,
): Generator<string> {
  const encodedKey = encodeKey(key);
  if (isPrimitive(value)) {
    yield indentedLine(depth, `${encodedKey}: ${encodePrimitive(value, options.delimiter)}`);
    return;
  }
  if (Array.isArray(value)) {
    yield* encodeArrayLines(key, value, depth, options);
    return;
  }

  const keyedFields = extractKeyedTabularFields(value);
  if (keyedFields) {
    yield* encodeKeyedObjectLines(key, value, keyedFields, depth, options);
    return;
  }

  yield indentedLine(depth, `${encodedKey}:`);
  if (!isEmptyObject(value)) yield* encodeObjectLines(value, depth + 1, options);
}

function* encodeKeyedObjectLines(
  key: string | undefined,
  value: Record<string, JsonCompatible>,
  fields: ToonField[],
  depth: number,
  options: EncoderOptions,
): Generator<string> {
  const entries = Object.entries(value);
  yield indentedLine(depth, formatHeader(entries.length, { key, fields, keyed: true }));
  yield* encodeKeyedEntryRowsLines(entries, fields, depth + 1, options);
}

function* encodeKeyedEntryRowsLines(
  entries: Array<[string, JsonCompatible]>,
  fields: ToonField[],
  depth: number,
  options: EncoderOptions,
): Generator<string> {
  for (const [entryKey, entryValue] of entries) {
    if (!isObjectRecord(entryValue)) continue;
    const leaves = collectRowLeaves(entryValue, fields);
    yield indentedLine(
      depth,
      `${encodeKey(entryKey)}: ${encodeAndJoinPrimitives(leaves, options.delimiter)}`,
    );
  }
}

function* encodeArrayLines(
  key: string | undefined,
  value: JsonCompatible[],
  depth: number,
  options: EncoderOptions,
): Generator<string> {
  if (value.length === 0) {
    yield indentedLine(depth, key === undefined ? "[]" : `${encodeKey(key)}: []`);
    return;
  }
  if (isArrayOfPrimitives(value)) {
    yield indentedLine(depth, encodeInlineArrayLine(value, key));
    return;
  }
  if (isArrayOfArrays(value) && value.every(isArrayOfPrimitives)) {
    yield* encodeArrayOfArraysAsListItemsLines(key, value, depth);
    return;
  }
  if (isArrayOfObjects(value)) {
    const fields = extractTabularFields(value);
    if (fields) yield* encodeArrayOfObjectsAsTabularLines(key, value, fields, depth, options);
    else yield* encodeMixedArrayAsListItemsLines(key, value, depth, options);
    return;
  }
  yield* encodeMixedArrayAsListItemsLines(key, value, depth, options);
}

function* encodeArrayOfArraysAsListItemsLines(
  key: string | undefined,
  values: JsonCompatible[][],
  depth: number,
): Generator<string> {
  yield indentedLine(depth, formatHeader(values.length, { key }));
  for (const arr of values) {
    yield indentedListItem(depth + 1, encodeInlineArrayLine(arr));
  }
}

function* encodeArrayOfObjectsAsTabularLines(
  key: string | undefined,
  rows: Array<Record<string, JsonCompatible>>,
  fields: ToonField[],
  depth: number,
  options: EncoderOptions,
): Generator<string> {
  yield indentedLine(depth, formatHeader(rows.length, { key, fields }));
  for (const row of rows) {
    yield indentedLine(
      depth + 1,
      encodeAndJoinPrimitives(collectRowLeaves(row, fields), options.delimiter),
    );
  }
}

function* encodeMixedArrayAsListItemsLines(
  key: string | undefined,
  items: JsonCompatible[],
  depth: number,
  options: EncoderOptions,
): Generator<string> {
  yield indentedLine(depth, formatHeader(items.length, { key }));
  for (const item of items) yield* encodeListItemValueLines(item, depth + 1, options);
}

function* encodeListItemValueLines(
  value: JsonCompatible,
  depth: number,
  options: EncoderOptions,
): Generator<string> {
  if (isPrimitive(value)) {
    yield indentedListItem(depth, encodePrimitive(value, options.delimiter));
    return;
  }
  if (Array.isArray(value)) {
    if (isArrayOfPrimitives(value)) {
      yield indentedListItem(depth, encodeInlineArrayLine(value));
      return;
    }
    yield indentedListItem(depth, formatHeader(value.length, {}));
    for (const item of value) yield* encodeListItemValueLines(item, depth + 1, options);
    return;
  }
  yield* encodeObjectAsListItemLines(value, depth, options);
}

function* encodeObjectAsListItemLines(
  obj: Record<string, JsonCompatible>,
  depth: number,
  options: EncoderOptions,
): Generator<string> {
  if (isEmptyObject(obj)) {
    yield indentedLine(depth, "-");
    return;
  }

  const entries = Object.entries(obj);
  const [firstKey, firstValue] = entries[0];
  const restEntries = entries.slice(1);
  const encodedKey = encodeKey(firstKey);

  if (Array.isArray(firstValue) && isArrayOfObjects(firstValue)) {
    const fields = extractTabularFields(firstValue);
    if (fields) {
      yield indentedListItem(depth, formatHeader(firstValue.length, { key: firstKey, fields }));
      for (const row of firstValue) {
        yield indentedLine(
          depth + 2,
          encodeAndJoinPrimitives(collectRowLeaves(row, fields), options.delimiter),
        );
      }
      yield* encodeRemainingObjectEntries(restEntries, depth, options);
      return;
    }
  }

  if (isObjectRecord(firstValue)) {
    const keyedFields = extractKeyedTabularFields(firstValue);
    if (keyedFields) {
      const keyedEntries = Object.entries(firstValue);
      yield indentedListItem(
        depth,
        formatHeader(keyedEntries.length, { key: firstKey, fields: keyedFields, keyed: true }),
      );
      yield* encodeKeyedEntryRowsLines(keyedEntries, keyedFields, depth + 2, options);
      yield* encodeRemainingObjectEntries(restEntries, depth, options);
      return;
    }
  }

  if (isPrimitive(firstValue)) {
    yield indentedListItem(
      depth,
      `${encodedKey}: ${encodePrimitive(firstValue, options.delimiter)}`,
    );
  } else if (Array.isArray(firstValue)) {
    if (firstValue.length === 0) {
      yield indentedListItem(depth, `${encodedKey}: []`);
    } else if (isArrayOfPrimitives(firstValue)) {
      yield indentedListItem(depth, `${encodedKey}${encodeInlineArrayLine(firstValue)}`);
    } else {
      yield indentedListItem(depth, `${encodedKey}${formatHeader(firstValue.length, {})}`);
      for (const item of firstValue) yield* encodeListItemValueLines(item, depth + 2, options);
    }
  } else {
    yield indentedListItem(depth, `${encodedKey}:`);
    if (!isEmptyObject(firstValue)) yield* encodeObjectLines(firstValue, depth + 2, options);
  }
  yield* encodeRemainingObjectEntries(restEntries, depth, options);
}

function* encodeRemainingObjectEntries(
  entries: Array<[string, JsonCompatible]>,
  listItemDepth: number,
  options: EncoderOptions,
): Generator<string> {
  if (entries.length === 0) return;
  yield* encodeObjectLines(Object.fromEntries(entries), listItemDepth + 1, options);
}

function extractKeyedTabularFields(value: Record<string, JsonCompatible>): ToonField[] | undefined {
  const entryValues = Object.values(value);
  if (entryValues.length < 2) return undefined;
  if (!entryValues.every(isNonEmptyObjectRecord)) return undefined;
  return extractTabularFields(entryValues);
}

function extractTabularFields(
  rows: Array<Record<string, JsonCompatible>>,
): ToonField[] | undefined {
  if (rows.length === 0) return undefined;
  const firstKeys = Object.keys(rows[0]);
  if (firstKeys.length === 0) return undefined;

  for (const row of rows) {
    if (Object.keys(row).length !== firstKeys.length) return undefined;
    for (const key of firstKeys) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) return undefined;
    }
  }

  const fieldNodes: ToonField[] = [];
  for (const key of firstKeys) {
    const fieldNode = classifyColumn(
      key,
      rows.map((row) => row[key]),
    );
    if (!fieldNode) return undefined;
    fieldNodes.push(fieldNode);
  }
  return fieldNodes;
}

function classifyColumn(name: string, values: JsonCompatible[]): ToonField | undefined {
  if (values.every(isPrimitive)) return { name };
  if (!values.every(isNonEmptyObjectRecord)) return undefined;
  const children = extractTabularFields(values);
  return children ? { name, children } : undefined;
}

function collectRowLeaves(
  row: Record<string, JsonCompatible>,
  fields: ToonField[],
): JsonCompatible[] {
  const leaves: JsonCompatible[] = [];
  collectLeafValues(row, fields, leaves);
  return leaves;
}

function collectLeafValues(
  row: Record<string, JsonCompatible>,
  fields: ToonField[],
  leaves: JsonCompatible[],
): void {
  for (const field of fields) {
    const value = row[field.name];
    if (field.children && isObjectRecord(value)) collectLeafValues(value, field.children, leaves);
    else leaves.push(value);
  }
}

function formatHeader(
  length: number,
  options: { key?: string; fields?: ToonField[]; keyed?: boolean },
): string {
  let header = "";
  if (options.key !== undefined) header += encodeKey(options.key);
  header += `[${length}${options.keyed ? ":" : ""}]`;
  if (options.fields) header += `{${formatFieldSegment(options.fields)}}`;
  return `${header}:`;
}

function formatFieldSegment(fields: ToonField[]): string {
  return fields
    .map(
      (field) =>
        encodeKey(field.name) + (field.children ? `{${formatFieldSegment(field.children)}}` : ""),
    )
    .join(",");
}

function encodeInlineArrayLine(values: JsonCompatible[], key?: string): string {
  const header = formatHeader(values.length, { key });
  return values.length === 0 ? header : `${header} ${encodeAndJoinPrimitives(values, ",")}`;
}

function encodeAndJoinPrimitives(values: JsonCompatible[], delimiter: ","): string {
  return values.map((value) => encodePrimitive(value, delimiter)).join(delimiter);
}

function encodePrimitive(value: JsonCompatible, delimiter: ","): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return encodeStringLiteral(value, delimiter);
  throw new TypeError("TOON primitive cell must be JSON-compatible");
}

function encodeStringLiteral(value: string, delimiter: ","): string {
  assertNoLoneSurrogate(value, "string value");
  if (isSafeUnquoted(value, delimiter)) return value;
  return `"${escapeString(value)}"`;
}

function encodeKey(key: string): string {
  assertNoLoneSurrogate(key, "object key");
  return /^[A-Z_][\w.]*$/i.test(key) ? key : `"${escapeString(key)}"`;
}

function escapeString(value: string): string {
  let escaped = "";
  for (const char of value) {
    switch (char) {
      case "\\":
        escaped += "\\\\";
        break;
      case '"':
        escaped += '\\"';
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case "\t":
        escaped += "\\t";
        break;
      default: {
        const code = char.charCodeAt(0);
        escaped += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : char;
      }
    }
  }
  return escaped;
}

function isSafeUnquoted(value: string, delimiter: ","): boolean {
  if (!value) return false;
  if (/^[ \t]|[ \t]$/.test(value)) return false;
  if (value === "true" || value === "false" || value === "null") return false;
  if (NUMERIC_LIKE_PATTERN.test(value)) return false;
  if (value.includes(":")) return false;
  if (value.includes('"') || value.includes("\\")) return false;
  if (/[[\]{}]/.test(value)) return false;
  if (hasControlCharacter(value)) return false;
  if (value.includes(delimiter)) return false;
  if (value.startsWith("-")) return false;
  if (value.startsWith("#")) return false;
  return true;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) < 0x20) return true;
  }
  return false;
}

function assertNoLoneSurrogate(value: string, context: string): void {
  if (!SURROGATE_PATTERN.test(value)) return;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    const isHighSurrogate = code <= 0xdbff;
    const next = value.charCodeAt(index + 1);
    if (isHighSurrogate && next >= 0xdc00 && next <= 0xdfff) {
      index++;
      continue;
    }
    throw new TypeError(
      `Cannot encode ${context} containing an unpaired surrogate U+${code.toString(16).toUpperCase()} at index ${index}`,
    );
  }
}

function isPrimitive(value: JsonCompatible): value is null | boolean | number | string {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isObjectRecord(value: JsonCompatible): value is Record<string, JsonCompatible> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmptyObject(value: Record<string, JsonCompatible>): boolean {
  return Object.keys(value).length === 0;
}

function isNonEmptyObjectRecord(value: JsonCompatible): value is Record<string, JsonCompatible> {
  return isObjectRecord(value) && !isEmptyObject(value);
}

function isArrayOfPrimitives(
  value: JsonCompatible[],
): value is Array<null | boolean | number | string> {
  return value.every(isPrimitive);
}

function isArrayOfArrays(value: JsonCompatible[]): value is JsonCompatible[][] {
  return value.every(Array.isArray);
}

function isArrayOfObjects(value: JsonCompatible[]): value is Array<Record<string, JsonCompatible>> {
  return value.every(isObjectRecord);
}

function indentedLine(depth: number, content: string): string {
  return " ".repeat(ENCODER_OPTIONS.indentSize * depth) + content;
}

function indentedListItem(depth: number, content: string): string {
  return indentedLine(depth, `- ${content}`);
}
