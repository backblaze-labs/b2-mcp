import { decode } from "@toon-format/toon";
import fc from "fast-check";
import type { JsonCompatible } from "../../src/utils/result-serializer";
import { encodeToon } from "../../src/utils/toon-encoder";
import { FASTCHECK_SEED } from "../support/fast-check-seed";

// Property-based / fuzz coverage for the repository-owned TOON encoder
// (`src/utils/toon-encoder.ts`), complementing the example-based suite in
// `toon-encoder.unit.test.ts`. The canonical `@toon-format/toon` decoder is the
// oracle: for any JSON-compatible value the encoder must produce text the
// canonical decoder reads back to the same value, so no structural detail is
// silently dropped, reordered, or type-confused (a number emitted so it decodes
// as a string, or vice versa).
//
// Edge cases surfaced while building this suite (issue #399 acceptance):
// - Round-trip held across the committed 2000 runs (1000 + 500 + 500 below) plus
//   5000+ ad-hoc runs during development, and every hand-picked corner (empty
//   containers, single-space and whitespace-only string values, numeric-like
//   strings such as "42"/"-0"/"1e3", boolean/null-like strings, empty and unsafe
//   object keys, `-0`, MAX_SAFE_INTEGER, emoji graphemes, deeply nested
//   tabular/keyed/list-item shapes). No divergence was found — the encoder is
//   robust, so this suite stands as a regression guard rather than a bug
//   reproduction.
//
// Runs are pinned to a deterministic seed (see `../support/fast-check-seed`) so
// each commit's pass/fail is reproducible.

// Full-grapheme strings never contain lone surrogates (which the encoder rejects
// by design), plus a palette of TOON-significant tokens that would break a naive
// encoder: delimiters, structural brackets, quote/escape characters, control
// characters, and literals that must be quoted to avoid decoding as a scalar.
const toonSignificant = fc.constantFrom(
  "",
  " ",
  "  ",
  "\t",
  "\n",
  "true",
  "false",
  "null",
  "42",
  "-0",
  "1e3",
  "-1.5",
  "a,b",
  "x:y",
  "[a]",
  "{b}",
  "- item",
  "#hash",
  " leading",
  "trailing ",
  'quote"quote',
  "back\\slash",
);
const leafString = fc.oneof(fc.string({ unit: "grapheme" }), toonSignificant);

const objectKey = fc.oneof(
  fc.string({ unit: "grapheme", minLength: 1 }),
  fc.constantFrom("safe_key.1", "bad,key", " spaced ", "a{b}c", "true", "-", "", "value"),
);

const primitive = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  leafString,
);

const { tree } = fc.letrec<{ tree: JsonCompatible; arr: JsonCompatible; obj: JsonCompatible }>(
  (tie) => ({
    tree: fc.oneof(
      { depthSize: "small", maxDepth: 4, withCrossShrink: true },
      primitive,
      tie("arr"),
      tie("obj"),
    ),
    arr: fc.array(tie("tree"), { maxLength: 6 }),
    // `dictionary` yields unique keys, so we never depend on encoder behavior for
    // duplicate keys (which JSON itself cannot represent).
    obj: fc.dictionary(objectKey, tie("tree"), { maxKeys: 6 }),
  }),
);
const jsonValue = tree as fc.Arbitrary<JsonCompatible>;

// The encoder is a JSON-compatible serializer, so the reference value is the
// JSON round-trip of the input: this canonicalizes `-0` to `0` and drops any
// representation-only distinctions exactly as both the encoder and the decoder
// do, isolating the property to structural/scalar fidelity.
function jsonCanonical(value: JsonCompatible): JsonCompatible {
  return JSON.parse(JSON.stringify(value)) as JsonCompatible;
}

describe("TOON encoder property suite", () => {
  it("round-trips every JSON-compatible value through the canonical decoder", () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        const decoded = decode(encodeToon(value));
        expect(decoded).toStrictEqual(jsonCanonical(value));
      }),
      { numRuns: 1000, seed: FASTCHECK_SEED },
    );
  });

  it("preserves scalar types across the round-trip (no number/string confusion)", () => {
    // Objects of scalars are the tabular/keyed hot path where type confusion is
    // most likely; assert value-for-value type identity, not just deep equality.
    const scalarRecord = fc.dictionary(objectKey, primitive, { minKeys: 1, maxKeys: 8 });
    fc.assert(
      fc.property(scalarRecord, (record) => {
        const decoded = decode(encodeToon(record)) as Record<string, JsonCompatible>;
        const expected = jsonCanonical(record) as Record<string, JsonCompatible>;
        for (const key of Object.keys(expected)) {
          expect(typeof decoded[key]).toBe(typeof expected[key]);
          expect(decoded[key]).toStrictEqual(expected[key]);
        }
      }),
      { numRuns: 500, seed: FASTCHECK_SEED },
    );
  });

  it("never emits an unpaired surrogate silently — it throws instead", () => {
    // Binary-unit strings can carry lone surrogates. The encoder's contract is to
    // reject them with a TypeError, never to emit corrupt/truncated output.
    const withPossibleSurrogate = fc.record({
      value: fc.string({ unit: "binary" }),
    });
    fc.assert(
      fc.property(withPossibleSurrogate, (record) => {
        const hasLoneSurrogate =
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
            record.value,
          );
        if (hasLoneSurrogate) {
          expect(() => encodeToon(record)).toThrow(TypeError);
        } else {
          expect(() => encodeToon(record)).not.toThrow();
        }
      }),
      { numRuns: 500, seed: FASTCHECK_SEED },
    );
  });
});
