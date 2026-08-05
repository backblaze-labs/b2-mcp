import { createRequire } from "module";

const nodeRequire = createRequire(__filename);
const { sanitizedEnv } = nodeRequire("../../scripts/lib/sanitized-env.cjs") as {
  sanitizedEnv: (
    extra?: Record<string, string>,
    options?: { nonSecretEnvNames?: string[]; sourceEnv?: Record<string, string> },
  ) => Record<string, string>;
};

describe("sanitized child-process env", () => {
  it("strips B2-prefixed values by default", () => {
    expect(sanitizedEnv({ B2_REGISTER_ALL_TOOLS: "true" }, { sourceEnv: {} })).not.toHaveProperty(
      "B2_REGISTER_ALL_TOOLS",
    );
  });

  it("allows caller-scoped non-secret exceptions", () => {
    expect(
      sanitizedEnv(
        { B2_REGISTER_ALL_TOOLS: "true" },
        { sourceEnv: {}, nonSecretEnvNames: ["B2_REGISTER_ALL_TOOLS"] },
      ).B2_REGISTER_ALL_TOOLS,
    ).toBe("true");
  });
});
