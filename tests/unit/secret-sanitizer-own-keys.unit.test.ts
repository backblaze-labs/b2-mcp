import {
  sanitizeError,
  sanitizeForMcpOutput,
  sanitizeStructuredLogValue,
} from "../../src/utils/secret-sanitizer";

const secret = "credential-value-123";
const metadata = () => ({ note: "public description", applicationKey: secret });
const sanitizedMetadata = { note: "public description", applicationKey: "[redacted]" };

function withOwnMetadata<T extends object>(value: T): T {
  return Object.defineProperty(value, "__proto__", {
    value: metadata(),
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

describe.each([
  ["MCP output", sanitizeForMcpOutput],
  ["structured logs", sanitizeStructuredLogValue],
] as const)("own data keys in %s", (_label, sanitize) => {
  it("preserves JSON keys as sanitized own data without assigning a new prototype", () => {
    // JSON permits __proto__ as an ordinary own key; an object-literal prototype
    // setter would not reproduce that wire input.
    const input = JSON.parse(
      '{"__proto__":{"note":"public description","applicationKey":"credential-value-123"},"constructor":{"note":"public constructor"},"prototype":{"note":"public prototype"},"ordinary":"public"}',
    );
    const safe = sanitize(input, { env: {} }) as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(safe, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(safe)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(safe))).toEqual(
      JSON.parse(
        '{"__proto__":{"note":"public description","applicationKey":"[redacted]"},"constructor":{"note":"public constructor"},"prototype":{"note":"public prototype"},"ordinary":"public"}',
      ),
    );
    expect(JSON.stringify(safe)).not.toContain(secret);
  });

  it.each([null, "public metadata"])("preserves a primitive prototype-named value: %s", (value) => {
    const input = JSON.parse(JSON.stringify({ ["__proto__"]: value, ordinary: "public" }));
    const safe = sanitize(input, { env: {} }) as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(safe, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(safe)).toBe(Object.prototype);
    expect(JSON.stringify(safe)).toBe(JSON.stringify(input));
  });

  it("preserves array metadata without replacing the array prototype", () => {
    const input = withOwnMetadata(["public item"]);
    const safe = sanitize(input, { env: {} }) as unknown[];

    expect(Object.prototype.hasOwnProperty.call(safe, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(safe)).toBe(Array.prototype);
    expect(safe[0]).toBe("public item");
    expect(Reflect.get(safe, "__proto__")).toEqual(sanitizedMetadata);
    expect(Reflect.get(input, "__proto__")).toEqual(metadata());
  });
});

describe.each([
  ["structured log errors", sanitizeStructuredLogValue],
  ["explicit error sanitization", sanitizeError],
] as const)("own data keys in %s", (_label, sanitize) => {
  it("keeps an Error instance while preserving sanitized enumerable metadata", () => {
    const input = withOwnMetadata(new Error("public failure"));
    const safe = sanitize(input, { env: {} });

    expect(safe).toBeInstanceOf(Error);
    expect(Object.prototype.hasOwnProperty.call(safe, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(safe)).toBe(Error.prototype);
    expect(Reflect.get(safe as object, "__proto__")).toEqual(sanitizedMetadata);
    expect((safe as Error).message).toBe("public failure");
    expect(Reflect.get(input, "__proto__")).toEqual(metadata());
  });
});
