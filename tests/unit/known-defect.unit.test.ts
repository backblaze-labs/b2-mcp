/** Behavior of the known-defect helper (tests/support/known-defect.ts). */
import { expectDefect, guardKnownDefect, KnownDefectError } from "../support/known-defect";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("knownDefect helper", () => {
  it("accepts the designated assertion failure", async () => {
    const run = guardKnownDefect("designated", async () => {
      await expectDefect(() => expect(1, "defect check").toBe(2));
    });
    await expect(run()).resolves.toBeUndefined();
  });

  it("fails the run on a different assertion failure outside expectDefect", async () => {
    const run = guardKnownDefect("prerequisite", async () => {
      expect("prerequisite broke", "prerequisite").toBe("prerequisite held");
      await expectDefect(() => expect(1).toBe(2));
    });
    await expect(run()).rejects.toThrow(/prerequisite/);
    await expect(run()).rejects.not.toBeInstanceOf(KnownDefectError);
  });

  it("fails the run on an unexpected non-assertion error inside expectDefect", async () => {
    const run = guardKnownDefect("thrown", async () => {
      await expectDefect(() => {
        throw new TypeError("setup broke");
      });
    });
    await expect(run()).rejects.toThrow(/setup broke/);
  });

  it("accepts a non-assertion failure only when match says it is the defect", async () => {
    class DefectError extends Error {}
    const run = guardKnownDefect("matched", async () => {
      await expectDefect(
        () => {
          throw new DefectError("the defect");
        },
        { match: (error) => error instanceof DefectError },
      );
    });
    await expect(run()).resolves.toBeUndefined();
  });

  it("fails the run on an unexpected pass", async () => {
    const run = guardKnownDefect("fixed", async () => {
      await expectDefect(() => expect(2).toBe(2));
    });
    await expect(run()).rejects.toThrow(/Unexpected pass/);
  });

  it("fails the run when the body never reaches the defect assertion", async () => {
    const run = guardKnownDefect("no defect check", async () => undefined);
    await expect(run()).rejects.toThrow(/Unexpected pass/);
  });

  it("rethrows the real assertion failure in the on-demand run", async () => {
    vi.stubEnv("B2_RUN_KNOWN_DEFECTS", "1");
    const failure = await expectDefect(() => expect(1, "real message").toBe(2)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(KnownDefectError);
    expect((failure as Error).message).toMatch(/real message/);
  });
});
