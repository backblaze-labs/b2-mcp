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
      thresholds: {
        statements: 94.3,
        branches: 88,
        functions: 97.2,
        lines: 96.6,
      },
    },
    projects: layerProjectNamesForConfig().map((name) =>
      layerProject(name, vitestLayerProjects[name]),
    ),
  },
});
