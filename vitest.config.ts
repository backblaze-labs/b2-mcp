import { defineConfig, type TestProjectConfiguration } from "vitest/config";

function layerProject(
  name: string,
  include: string[],
  options: { testTimeout?: number; serial?: boolean } = {},
): TestProjectConfiguration {
  return {
    extends: true,
    test: {
      name,
      include,
      testTimeout: options.testTimeout ?? 30_000,
      ...(options.serial ? { fileParallelism: false } : {}),
    },
  };
}

const fixtureProjects =
  process.env.B2_VITEST_LAYER_ENABLE_FIXTURES === "true"
    ? [
        layerProject("runner-fixture-nonlive", [
          "tests/fixtures/run-vitest-layer-fixture.fixture.test.ts",
        ]),
        layerProject(
          "runner-fixture-live",
          ["tests/fixtures/run-vitest-layer-fixture.fixture.test.ts"],
          { serial: true },
        ),
      ]
    : [];

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text-summary", "json-summary", "cobertura"],
      include: ["src/**/*.ts"],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 85,
        lines: 85,
      },
    },
    projects: [
      layerProject("unit", ["tests/unit/**/*.unit.test.ts"]),
      layerProject("contract", ["tests/contract/**/*.contract.test.ts"]),
      layerProject("protocol-modern", ["tests/protocol/**/*.modern-protocol.test.ts"], {
        serial: true,
      }),
      layerProject("protocol-legacy", ["tests/protocol/**/*.legacy-protocol.test.ts"], {
        serial: true,
      }),
      layerProject("slow", ["tests/slow/**/*.slow.test.ts"], {
        serial: true,
        testTimeout: 120_000,
      }),
      layerProject("package", ["tests/package/**/*.package.test.ts"], {
        serial: true,
        testTimeout: 120_000,
      }),
      layerProject("integration-live", ["tests/live/**/*.integration.live.test.ts"], {
        serial: true,
        testTimeout: 120_000,
      }),
      layerProject("contract-live", ["tests/live/**/*.contract.live.test.ts"], {
        serial: true,
        testTimeout: 120_000,
      }),
      ...fixtureProjects,
    ],
  },
});
