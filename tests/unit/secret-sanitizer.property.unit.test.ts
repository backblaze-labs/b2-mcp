import fc from "fast-check";
import {
  sanitizeError,
  sanitizeForMcpOutput,
  sanitizeStructuredLogValue,
} from "../../src/utils/secret-sanitizer";

// Property-based / fuzz coverage for the secret redaction helpers
// (`src/utils/secret-sanitizer.ts`). The central security property is
// completeness: a configured secret value must not survive redaction in ANY
// position — deeply nested object, array element, header-shaped value, error
// message, or error field — while non-secret identifiers (key IDs, bucket IDs)
// stay visible in MCP output so tools can return them.
//
// Edge cases surfaced while building this suite (issue #399 acceptance): none
// escaped. Every generated placement of a canary secret was redacted in both MCP
// and log modes across nested/array/header/error positions; the completeness
// property held across 1000+ inputs. The suite stands as a regression guard.

// Configured secrets must clear `secretCandidate` (length >= 8, non-blank), so
// the canary is prefixed and hex-suffixed. The literal prefix makes accidental
// collision with generated noise astronomically unlikely, and the shape can
// never match the bearer/basic/canary/labeled text patterns that redact
// unconditionally — so a surviving occurrence is a genuine completeness failure,
// not a coincidental match by another rule.
const hexArb = fc.string({
  unit: fc.constantFrom(..."0123456789abcdef".split("")),
  minLength: 12,
  maxLength: 40,
});
const secretArb = hexArb.map((hex) => `CANARY_SECRET_${hex}`);

// Non-secret identifier values: alphanumeric/`_`/`-` only, so they contain no
// `:`/`=` label separators and cannot match a labeled-secret or bearer pattern.
const identifierChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".split(
  "",
);
const identifierArb = fc.string({
  unit: fc.constantFrom(...identifierChars),
  minLength: 1,
  maxLength: 40,
});

const noiseKey = fc.oneof(
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 }),
  fc.constantFrom("id", "name", "bucketId", "customHeaders", "value", "detail", "items"),
);

// A structure that is GUARANTEED to embed `secret` at some leaf: the only base
// case is the secret itself, and every recursive branch nests back toward it, so
// the secret always reaches a value position (never merely a key).
function structureContaining(secret: string): fc.Arbitrary<unknown> {
  const { node } = fc.letrec<{ node: unknown; obj: unknown; arr: unknown; headers: unknown }>(
    (tie) => ({
      node: fc.oneof(
        { depthSize: "small", maxDepth: 4, withCrossShrink: true },
        fc.constant(secret),
        tie("obj"),
        tie("arr"),
        tie("headers"),
      ),
      obj: fc.dictionary(noiseKey, tie("node"), { maxKeys: 4 }),
      arr: fc.array(tie("node"), { minLength: 1, maxLength: 4 }),
      // A custom-headers-shaped node, one of the positions the issue calls out.
      headers: fc.record({
        customHeaders: fc.array(
          fc.record({ name: fc.string({ maxLength: 8 }), value: tie("node") }),
          { minLength: 1, maxLength: 3 },
        ),
      }),
    }),
  );
  return node;
}

// Guard against the vanishingly rare case where generated noise reproduces the
// secret as an object KEY (keys are structural and not redacted). Without this a
// coincidental key collision could read as a false completeness failure.
function secretAppearsAsKey(value: unknown, secret: string): boolean {
  if (Array.isArray(value)) return value.some((item) => secretAppearsAsKey(item, secret));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, child]) => key.includes(secret) || secretAppearsAsKey(child, secret),
    );
  }
  return false;
}

describe("secret sanitizer property suite", () => {
  it("redacts a configured secret in every nested/array/header position (MCP + log)", () => {
    const secretInStructure = secretArb.chain((secret) =>
      structureContaining(secret).map((structure) => ({ secret, structure })),
    );
    fc.assert(
      fc.property(secretInStructure, ({ secret, structure }) => {
        fc.pre(!secretAppearsAsKey(structure, secret));
        const options = { secrets: [secret] };
        const mcp = JSON.stringify(sanitizeForMcpOutput(structure, options));
        const log = JSON.stringify(sanitizeStructuredLogValue(structure, options));
        expect(mcp.includes(secret)).toBe(false);
        expect(log.includes(secret)).toBe(false);
      }),
      { numRuns: 400 },
    );
  });

  it("redacts a configured secret embedded in an error message, stack, and fields", () => {
    fc.assert(
      fc.property(secretArb, (secret) => {
        const error = new Error(`boom while using ${secret} downstream`);
        (error as unknown as Record<string, unknown>).detail = {
          nested: [secret, { token: secret }],
        };
        (error as unknown as Record<string, unknown>).cause = new Error(secret);

        const sanitized = sanitizeError(error, { secrets: [secret] }) as Error & {
          detail?: unknown;
          cause?: unknown;
        };
        const serialized = JSON.stringify({
          message: sanitized.message,
          name: sanitized.name,
          stack: sanitized.stack ?? "",
          detail: sanitized.detail,
          cause:
            sanitized.cause instanceof Error
              ? { message: sanitized.cause.message, stack: sanitized.cause.stack ?? "" }
              : sanitized.cause,
        });
        expect(serialized.includes(secret)).toBe(false);
        // The structured-log Error path must scrub the same material.
        const logged = JSON.stringify(sanitizeStructuredLogValue(error, { secrets: [secret] }));
        expect(logged.includes(secret)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("preserves non-secret identifiers in MCP output", () => {
    fc.assert(
      fc.property(identifierArb, (identifier) => {
        const payload = {
          keyId: identifier,
          bucketId: identifier,
          nested: { applicationKeyId: identifier, items: [identifier] },
        };
        const sanitized = sanitizeForMcpOutput(payload, {}) as typeof payload;
        expect(sanitized.keyId).toBe(identifier);
        expect(sanitized.bucketId).toBe(identifier);
        expect(sanitized.nested.applicationKeyId).toBe(identifier);
        expect(sanitized.nested.items[0]).toBe(identifier);
      }),
      { numRuns: 300 },
    );
  });
});
