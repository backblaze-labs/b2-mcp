/** Tests for parseIntEnv — the shared env-var integer parser with fallback. */

import { parseIntEnv } from "../../src/utils/config";

describe("parseIntEnv", () => {
  it("returns the fallback when the value is undefined", () => {
    expect(parseIntEnv(undefined, 42)).toBe(42);
  });

  it("returns the fallback when the value is not a number", () => {
    expect(parseIntEnv("abc", 7)).toBe(7);
    expect(parseIntEnv("", 7)).toBe(7);
  });

  it("parses a valid integer string", () => {
    expect(parseIntEnv("128", 7)).toBe(128);
  });

  it("parses leading-numeric strings like parseInt does", () => {
    expect(parseIntEnv("100MB", 7)).toBe(100);
  });
});
