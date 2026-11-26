import fc from "fast-check";
import {
  sanitizeForMcpOutput,
  sanitizerOptionsFromConfig,
  sanitizeStructuredLogValue,
  sanitizeText,
} from "../../src/utils/secret-sanitizer";
import { FASTCHECK_SEED } from "../support/fast-check-seed";

// Lowercase prose with ordinary punctuation has no credential labels followed
// by ':'/'=', capitalized HTTP auth schemes, or marked-secret canary prefix.
// This input grammar establishes safety independently of sanitizer output.
const prose = fc.string({
  // cspell:disable-next-line -- accented characters are generator inputs.
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz áéíóúñ.,!?;\n\t-'()"),
  maxLength: 160,
});
const publicData = fc.record({
  description: prose,
  enabled: fc.boolean(),
  count: fc.integer(),
  metadata: fc.record({ notes: fc.array(prose, { maxLength: 5 }), value: prose }),
});
const propertyOptions = { numRuns: 300, seed: FASTCHECK_SEED };

describe("secret sanitizer preservation policy", () => {
  it("preserves ordinary prose when exact-secret configuration is empty", () => {
    fc.assert(
      fc.property(prose, (text) => {
        // Exercise omitted and explicitly empty secrets, including the public
        // config helper. Every call supplies its own environment, never the host.
        for (const options of [
          { env: {} },
          { env: {}, secrets: [] },
          { env: {}, secrets: new Set<string>() },
          { ...sanitizerOptionsFromConfig({}), env: {} },
        ]) {
          expect(sanitizeText(text, options)).toBe(text);
          expect(sanitizeForMcpOutput(text, options)).toBe(text);
          expect(sanitizeStructuredLogValue(text, options)).toBe(text);
        }
      }),
      propertyOptions,
    );
  });

  it("preserves complete ordinary JSON data in MCP output and logs", () => {
    fc.assert(
      fc.property(publicData, (payload) => {
        expect(sanitizeForMcpOutput(payload, { env: {} })).toEqual(payload);
        expect(sanitizeStructuredLogValue(payload, { env: {} })).toEqual(payload);
      }),
      propertyOptions,
    );
  });

  it("redacts configured material while preserving neighboring ordinary data", () => {
    fc.assert(
      fc.property(publicData, fc.nat(), (payload, suffix) => {
        // Digits and '~' distinguish this concrete credential from the prose
        // grammar; neither the safe data nor the secret can overlap by chance.
        const credential = `credential~${suffix}~private`;
        const options = { env: {}, secrets: [credential] };
        const text = `(${payload.description}) ${credential} (${payload.metadata.value})`;
        const expected = `(${payload.description}) [redacted] (${payload.metadata.value})`;
        expect(sanitizeText(text, options)).toBe(expected);
        for (const sanitize of [sanitizeForMcpOutput, sanitizeStructuredLogValue]) {
          expect(sanitize({ ...payload, detail: [text, credential] }, options)).toEqual({
            ...payload,
            detail: [expected, "[redacted]"],
          });
        }
      }),
      propertyOptions,
    );
  });

  it("keeps public environment values visible beside real configured secrets", () => {
    const options = {
      env: {
        PUBLIC_DESCRIPTION: "monthly storage report",
        B2_APPLICATION_KEY: "configured-value-1234",
      },
    };
    const input = {
      description: "monthly storage report",
      detail: "using configured-value-1234 for the report",
    };
    const expected = {
      description: "monthly storage report",
      detail: "using [redacted] for the report",
    };
    expect(sanitizeForMcpOutput(input, options)).toEqual(expected);
    expect(sanitizeStructuredLogValue(input, options)).toEqual(expected);
  });
});
