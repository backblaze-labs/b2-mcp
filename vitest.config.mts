import { defineConfig, type TestProjectConfiguration } from "vitest/config";
import {
  layerProjectNamesForConfig,
  vitestLayerProjects,
} from "./scripts/vitest-layer-registry.mjs";

type LayerProjectDefinition = {
  include: string[];
  testTimeout?: number;
  serial?: boolean;
};

function layerProject(name: string, definition: LayerProjectDefinition): TestProjectConfiguration {
  return {
    extends: true,
    test: {
      name,
      include: definition.include,
      testTimeout: definition.testTimeout ?? 30_000,
      ...(definition.serial ? { fileParallelism: false } : {}),
    },
  };
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text-summary", "html", "json-summary", "lcov", "cobertura"],
      include: ["src/**/*.ts"],
      exclude: ["dist/**", "tests/**", "**/*.d.ts", "**/*.test.ts", "**/generated/**"],
      // Floors sit a deliberate buffer below the achieved merged coverage
      // (statements 94.81 / branches 89.15 / functions 97.61 / lines 96.91 as of
      // this change) so normal per-layer execution and v8 measurement variance,
      // or an unrelated PR that drops a branch or two, does not wedge the global
      // merge/deploy gate. Each floor stays at or above the previous value so the
      // ratchet never weakens; raise them only when a durable gain is measured.
      thresholds: {
        statements: 94.5,
        branches: 89,
        functions: 97.5,
        lines: 96.7,
      },
    },
    projects: layerProjectNamesForConfig().map((name) =>
      layerProject(name, vitestLayerProjects[name]),
    ),
  },
});
