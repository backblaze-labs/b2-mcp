import type * as SanitizerModule from "../../src/utils/secret-sanitizer";

let sanitizer: typeof SanitizerModule;

beforeEach(async () => {
  vi.resetModules();
  sanitizer = await import("../../src/utils/secret-sanitizer");
});

function arrayWithReportedLength(length: unknown): unknown[] {
  const target = Object.assign([], {
    applicationKey: "ordinary-private-value",
    publicNote: "public-value",
  });
  return new Proxy(target, {
    getOwnPropertyDescriptor(value, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      // Proxy invariants allow a different value for a writable data property,
      // even though an array's length property itself is non-configurable.
      return key === "length" && descriptor ? { ...descriptor, value: length } : descriptor;
    },
    get(value, key, receiver) {
      if (key === "length") throw new Error("Array length must be read from its descriptor");
      return Reflect.get(value, key, receiver);
    },
  });
}

describe("secret sanitizer array descriptor boundaries", () => {
  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["numeric text", "3"],
    ["above the array-length limit", 2 ** 32],
  ])("uses an inert length when the descriptor is %s", (_label, reportedLength) => {
    for (const sanitize of [sanitizer.sanitizeForMcpOutput, sanitizer.sanitizeStructuredLogValue]) {
      const safe = sanitize(arrayWithReportedLength(reportedLength), { env: {} }) as unknown[] & {
        applicationKey: string;
        publicNote: string;
      };
      expect(safe.length).toBe(0);
      expect(safe.applicationKey).toBe("[redacted]");
      expect(safe.publicNote).toBe("public-value");
    }
  });

  it("does not coerce an object-valued length descriptor", () => {
    const coerce = vi.fn(() => {
      throw new Error("Do not invoke untrusted length coercion");
    });
    const reportedLength = { [Symbol.toPrimitive]: coerce };
    const safe = sanitizer.sanitizeStructuredLogValue(arrayWithReportedLength(reportedLength), {
      env: {},
    }) as unknown[];
    expect(safe.length).toBe(0);
    expect(coerce).not.toHaveBeenCalled();
  });

  it.each([0, 4, 2 ** 32 - 1])("preserves the valid array length %s", (length) => {
    const safe = sanitizer.sanitizeStructuredLogValue(arrayWithReportedLength(length), {
      env: {},
    }) as unknown[];
    // Assert the scalar length, so failure formatting never expands sparse
    // arrays at the maximum valid JS array length.
    expect(safe.length).toBe(length);
  });

  it("uses stable Error fallbacks when hostile reflection removes core fields", () => {
    const secret = "ordinary-private-value";
    const original = Object.assign(new Error(secret), { detail: secret });
    const originalPrototype = Object.getOwnPropertyDescriptors(Error.prototype);
    const hostile = new Proxy(original, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "message") {
          // Only this input changes shape during reflection. No global Error
          // prototype or built-in operation is replaced to reach the fallback.
          Object.setPrototypeOf(target, null);
          for (const field of ["message", "name", "stack"]) Reflect.deleteProperty(target, field);
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(hostile).toBeInstanceOf(Error);

    const safe = sanitizer.sanitizeError(hostile, { env: {}, secrets: [secret] });

    expect(safe).toBeInstanceOf(Error);
    expect(safe.message).toBe("");
    expect(safe.name).toBe("Error");
    expect(safe).toHaveProperty("detail", "[redacted]");
    expect(Object.getPrototypeOf(original)).toBeNull();
    expect(Object.getOwnPropertyDescriptors(Error.prototype)).toEqual(originalPrototype);
  });
});
