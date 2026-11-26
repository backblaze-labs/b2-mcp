import type * as SanitizerModule from "../../src/utils/secret-sanitizer";

let sanitizer: typeof SanitizerModule;

beforeEach(async () => {
  vi.resetModules();
  sanitizer = await import("../../src/utils/secret-sanitizer");
});

describe("existing redaction marker preservation", () => {
  it("preserves intact markers while redacting configured secrets outside them", () => {
    const options = { env: {}, secrets: ["redacted"] };
    const input = "outside redacted [redacted][redacted]";
    const expected = "outside [redacted] [redacted][redacted]";
    expect(sanitizer.sanitizeText(input, options)).toBe(expected);
    expect(sanitizer.sanitizeText(expected, options)).toBe(expected);
  });

  it("keeps request-error markers intact across exact and generic text passes", () => {
    const secrets = ["private-request-value", "redacted"];
    const expected = "before [redacted] after [redacted][redacted]";
    expect(
      sanitizer.safeErrorText("before private-request-value after [redacted][redacted]", secrets),
    ).toBe(expected);
    expect(sanitizer.safeErrorText(expected, secrets)).toBe(expected);
  });

  it("keeps request secrets available for fragments exposed by a cross-boundary replacement", () => {
    const secrets = ["head[", "redacted]"];
    // The first pass replaces head[ and leaves a marker fragment outside the
    // new marker. The existing generic pass must still redact that fragment.
    expect(sanitizer.redactExactTextSecrets("head[redacted]", secrets)).toBe("[redacted]redacted]");
    expect(sanitizer.safeErrorText("head[redacted]", secrets)).toBe("[redacted][redacted]");
  });

  it.each(["exact", "error"] as const)(
    "preserves repeated marker characters in %s redaction",
    (mode) => {
      const redact = mode === "exact" ? sanitizer.redactExactTextSecrets : sanitizer.safeErrorText;
      expect(redact("e [redacted][redacted] e", ["e"])).toBe(
        "[redacted] [redacted][redacted] [redacted]",
      );
    },
  );

  it.each(["exact", "error"] as const)(
    "merges overlapping outside secrets in %s redaction",
    (mode) => {
      const redact = mode === "exact" ? sanitizer.redactExactTextSecrets : sanitizer.safeErrorText;
      expect(
        redact("before prefix-secret-suffix after [redacted]", [
          "prefix-secret",
          "secret-suffix",
          "redacted",
        ]),
      ).toBe("before [redacted] after [redacted]");
    },
  );

  it.each([
    ["end", "[redacted]tail", "]tail", "[redacted[redacted]"],
    ["start", "head[redacted]", "head[", "[redacted]redacted]"],
    ["whole marker", "left[redacted]right", "left[redacted]right", "[redacted]"],
    ["adjacent markers", "[redacted][redacted]", "][", "[redacted[redacted]redacted]"],
  ])("still redacts a real secret crossing the %s boundary", (_label, text, secret, expected) => {
    const safe = sanitizer.redactExactTextSecrets(text, [secret]);
    expect(safe).toBe(expected);
    expect(safe).not.toContain(secret);
  });

  it("preserves already-redacted labeled values with a marker-substring secret", () => {
    const text = "applicationKey=[redacted] password=[redacted]";
    expect(sanitizer.sanitizeText(text, { env: {}, secrets: ["redacted"] })).toBe(text);
  });
});
