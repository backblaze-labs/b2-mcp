import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["evals/**/*.eval.test.ts"],
    passWithNoTests: false,
    testTimeout: 120_000,
  },
});
