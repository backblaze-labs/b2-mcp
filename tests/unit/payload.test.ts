import { assignDefined } from "../../src/utils/payload";

describe("assignDefined", () => {
  it("copies only defined keys into the target", () => {
    const target: Record<string, unknown> = { a: 1 };
    const args = { b: 2, c: undefined, d: "x" };
    assignDefined(target, args, ["b", "c", "d"]);
    expect(target).toEqual({ a: 1, b: 2, d: "x" }); // c (undefined) skipped
  });

  it("copies falsy-but-defined values (0, '', false, null)", () => {
    const target: Record<string, unknown> = {};
    const args = { zero: 0, empty: "", flag: false, nul: null };
    assignDefined(target, args, ["zero", "empty", "flag", "nul"]);
    expect(target).toEqual({ zero: 0, empty: "", flag: false, nul: null });
  });

  it("returns the same target reference and ignores unlisted keys", () => {
    const target: Record<string, unknown> = {};
    const args = { keep: 1, ignore: 2 };
    expect(assignDefined(target, args, ["keep"])).toBe(target);
    expect(target).toEqual({ keep: 1 });
  });
});
