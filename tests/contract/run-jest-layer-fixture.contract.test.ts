describe("run-jest-layer fixture", () => {
  it("executes a minimal assertion for runner contract tests", () => {
    if (process.env.B2_JEST_LAYER_FIXTURE_FAIL_WITH_SECRET) {
      throw new Error(`fixture secret: ${process.env.B2_APPLICATION_KEY ?? "missing"}`);
    }

    expect(true).toBe(true);
  });
});
