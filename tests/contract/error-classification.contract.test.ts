import { readFileSync } from "fs";
import { join, relative } from "path";
import { listFiles, root } from "./support";
import { badRequest, badRequestError, codedError, parseB2Error } from "../../src/utils/errors";

/**
 * `parseB2Error` classifies an error that carries no code of its own as
 * `internal_error` / HTTP 500. That tail is correct for a genuinely unclassified
 * server fault, but it is the wrong answer for a *deliberate* refusal: handing a
 * caller `internal_error` tells the model the server malfunctioned when in fact
 * the server understood the request and said no.
 *
 * The same symptom was fixed three times at three individual call sites before
 * anything stopped the next one from appearing. These tests are that stop: every
 * deliberate refusal must be built with `codedError`/`badRequestError`, never
 * with a bare `new Error(...)` handed straight to `toolError`.
 */
describe("error classification policy", () => {
  const sourceFiles = listFiles(join(root, "src")).filter((file) => file.endsWith(".ts"));

  it("scans a non-trivial set of source files", () => {
    expect(sourceFiles.length).toBeGreaterThan(20);
  });

  it("never hands a codeless Error straight to toolError", () => {
    // Matches `toolError(new Error(` and `toolError(Error(`, across line breaks
    // — the exact shape that lands on the internal_error/500 tail.
    const codelessToolError = /toolError\(\s*(?:new\s+)?Error\s*\(/;

    const offenders = sourceFiles
      .filter((file) => codelessToolError.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file));

    expect(offenders).toEqual([]);
  });

  it("classifies coded refusals by their own status and code", () => {
    expect(parseB2Error(codedError(403, "forbidden", "nope"))).toMatchObject({
      status: 403,
      code: "forbidden",
      message: "nope",
    });
    expect(parseB2Error(badRequestError("bad input"))).toMatchObject({
      status: 400,
      code: "bad_request",
      message: "bad input",
    });
    expect(() => badRequest("bad input")).toThrow(
      expect.objectContaining({ status: 400, code: "bad_request" }),
    );
  });

  it("keeps coded refusals throwable and stack-bearing", () => {
    // They stay real Errors so `rejects.toThrow(...)` and stack traces still work
    // wherever a refusal propagates through normal throw/catch plumbing.
    const error = badRequestError("bad input");
    expect(error).toBeInstanceOf(Error);
    expect(error.stack).toEqual(expect.any(String));
  });

  it("still classifies a genuinely codeless error as an internal fault", () => {
    // The tail is deliberately reserved for unclassified server faults; the fix
    // is to stop routing refusals through it, not to soften it into a 400.
    expect(parseB2Error(new Error("kaboom"))).toMatchObject({
      status: 500,
      code: "internal_error",
    });
  });
});
