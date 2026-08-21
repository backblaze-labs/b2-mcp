const fixtureEnabled = () => process.env.B2_VITEST_LAYER_ENABLE_FIXTURES === "true";

export const vitestLayerProjects = {
  unit: {
    include: ["tests/unit/**/*.unit.test.ts"],
    live: false,
    public: true,
    coverage: true,
  },
  contract: {
    include: ["tests/contract/**/*.contract.test.ts"],
    live: false,
    public: true,
    coverage: true,
  },
  "protocol-modern": {
    include: ["tests/protocol/**/*.modern-protocol.test.ts"],
    live: false,
    public: true,
    coverage: true,
    serial: true,
  },
  "protocol-legacy": {
    include: ["tests/protocol/**/*.legacy-protocol.test.ts"],
    live: false,
    public: true,
    coverage: true,
    serial: true,
  },
  "runtime-security": {
    include: ["tests/runtime-security/**/*.runtime-security.test.ts"],
    live: false,
    public: true,
    coverage: true,
    serial: true,
  },
  slow: {
    include: ["tests/slow/**/*.slow.test.ts"],
    live: false,
    public: true,
    coverage: true,
    serial: true,
    testTimeout: 120_000,
  },
  package: {
    include: ["tests/package/**/*.package.test.ts"],
    live: false,
    public: true,
    coverage: true,
    serial: true,
    testTimeout: 120_000,
  },
  "integration-live": {
    include: ["tests/live/**/*.integration.live.test.ts"],
    live: true,
    public: true,
    coverage: false,
    serial: true,
    testTimeout: 120_000,
  },
  "contract-live": {
    include: ["tests/live/**/*.contract.live.test.ts"],
    live: true,
    public: true,
    coverage: false,
    serial: true,
    testTimeout: 120_000,
  },
  "runner-fixture-nonlive": {
    include: ["tests/fixtures/run-vitest-layer-fixture.fixture.test.ts"],
    live: false,
    public: false,
    fixture: true,
    coverage: false,
  },
  "runner-fixture-live": {
    include: ["tests/fixtures/run-vitest-layer-fixture.fixture.test.ts"],
    live: true,
    public: false,
    fixture: true,
    coverage: false,
    serial: true,
  },
};

const projectEntries = Object.entries(vitestLayerProjects);

export const publicLayerNames = projectEntries
  .filter(([, definition]) => definition.public)
  .map(([name]) => name);

export const fixtureLayerNames = projectEntries
  .filter(([, definition]) => definition.fixture)
  .map(([name]) => name);

export const coverageLayerNames = projectEntries
  .filter(([, definition]) => definition.public && definition.coverage)
  .map(([name]) => name);

export function layerProjectNamesForConfig() {
  return projectEntries
    .filter(([, definition]) => definition.public || (definition.fixture && fixtureEnabled()))
    .map(([name]) => name);
}

function normalizeTestPath(testPath) {
  const normalized = testPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const testsSegment = "/tests/";
  const testsIndex = normalized.lastIndexOf(testsSegment);
  return testsIndex >= 0 ? normalized.slice(testsIndex + 1) : normalized;
}

function matchesInclude(pattern, testPath) {
  const normalized = normalizeTestPath(testPath);
  const wildcard = "**/*";
  if (!pattern.includes(wildcard)) return normalized === pattern;

  const [prefix, suffix] = pattern.split(wildcard);
  return normalized.startsWith(prefix) && normalized.endsWith(suffix);
}

export function projectNameForTestPath(testPath) {
  return projectEntries.find(([, definition]) =>
    definition.include.some((pattern) => matchesInclude(pattern, testPath)),
  )?.[0];
}
