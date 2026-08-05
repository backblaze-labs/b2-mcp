const fixtureIt = process.env.B2_VITEST_LAYER_FIXTURE_SKIP_ALL === "true" ? it.skip : it;

describe("run-vitest-layer fixture", () => {
  fixtureIt("executes a minimal assertion for runner contract tests", () => {
    const secretEnvName = process.env.B2_VITEST_LAYER_FIXTURE_SECRET_ENV;
    if (secretEnvName)
      throw new Error(`fixture secret: ${process.env[secretEnvName] ?? "missing"}`);

    if (process.env.B2_VITEST_LAYER_FIXTURE_FAIL_WITH_SECRET) {
      throw new Error(`fixture secret: ${process.env.B2_APPLICATION_KEY ?? "missing"}`);
    }

    expect(true).toBe(true);
  });
});
