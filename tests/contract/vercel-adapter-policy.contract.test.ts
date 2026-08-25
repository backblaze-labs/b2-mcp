import { existsSync, readFileSync, statSync } from "fs";
import { dirname, extname, join, resolve } from "path";
import { readJson, root } from "./support";

const VERCEL_FUNCTION_ENTRYPOINTS = [
  "api/mcp.js",
  "api/health.js",
  "api/oauth-protected-resource.js",
  "api/oauth-authorization-server.js",
];
const VERCEL_FUNCTION_SOURCE_BYTES_BUDGET = 485_000;
const VERCEL_FUNCTION_SOURCE_FILES_BUDGET = 55;

function resolveLocalImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = extname(base)
    ? [base.replace(/\.js$/, ".ts"), base]
    : [".ts", ".js", ".json"].map((extension) => `${base}${extension}`);
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

function collectLocalImportGraph(entrypoints: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const importPattern =
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?["']([^"']+)["']|import\(["']([^"']+)["']\)|require\(["']([^"']+)["']\)/g;
  function visit(relativePath: string): void {
    const absolutePath = resolve(root, relativePath);
    if (seen.has(absolutePath)) return;
    seen.add(absolutePath);
    const source = readFileSync(absolutePath, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const resolved = resolveLocalImport(absolutePath, match[1] ?? match[2] ?? match[3]);
      if (resolved) visit(resolved.slice(root.length + 1));
    }
  }
  for (const entrypoint of entrypoints) visit(entrypoint);
  return seen;
}

describe("Vercel adapter policy", () => {
  it("does not add a second MCP transport dependency", () => {
    const pkg = readJson<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>("package.json");
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

    expect(allDeps).not.toHaveProperty("mcp-handler");
    expect(allDeps).not.toHaveProperty("@modelcontextprotocol/sdk");
    expect(pkg.devDependencies?.vercel).toBe("59.3.0");
    expect(pkg.devDependencies?.["@vercel/node"]).toBe("5.10.2");
  });

  it("publishes the expected Vercel routes and Node runtime policy", () => {
    const vercel = readJson<{
      fluid?: boolean;
      regions?: string[];
      installCommand?: string;
      buildCommand?: string;
      builds?: {
        src?: string;
        use?: string;
        config?: { runtime?: string; maxDuration?: number };
      }[];
      rewrites?: { source: string; destination: string }[];
    }>("vercel.json");

    expect(vercel.fluid).toBe(true);
    expect(vercel.regions).toEqual(["iad1"]);
    expect(vercel.installCommand).toBe("corepack enable && pnpm install --frozen-lockfile");
    expect(vercel.buildCommand).toBe("pnpm run typecheck && pnpm run build");
    expect(vercel.builds).toContainEqual({
      src: "api/*.js",
      use: "@vercel/node",
      config: { runtime: "nodejs24.x", maxDuration: 60 },
    });
    expect(vercel.rewrites).toEqual(
      expect.arrayContaining([
        { source: "/mcp", destination: "/api/mcp" },
        { source: "/health", destination: "/api/health" },
        {
          source: "/.well-known/oauth-protected-resource",
          destination: "/api/oauth-protected-resource",
        },
        {
          source: "/.well-known/oauth-protected-resource/mcp",
          destination: "/api/oauth-protected-resource",
        },
      ]),
    );
  });

  it("documents Vercel-specific trust boundaries and limits", () => {
    const guide = readFileSync(join(root, "deploy/vercel/README.md"), "utf8");

    expect(guide).toContain("not a Next.js app");
    expect(guide).toContain("not deployment-wide ceilings");
    expect(guide).toContain("not deployment-wide abuse");
    expect(guide).toContain("single-tenant");
    expect(guide).toContain("B2_OAUTH_ALLOWED_SUBJECTS");
    expect(guide).toContain("Production environment secrets");
    expect(guide).toContain("x-vercel-protection-bypass");
    expect(guide).toContain("https://vercel.com/docs/functions/limitations");
    expect(guide).toContain("https://vercel.com/docs/fluid-compute");
  });

  it("prompts Vercel server-mode deployments for an OAuth subject allowlist", () => {
    const guide = readFileSync(join(root, "deploy/vercel/README.md"), "utf8");
    const envExample = readFileSync(join(root, "deploy/vercel/vercel.env.example"), "utf8");

    expect(guide).toContain("B2_OAUTH_ALLOWED_SUBJECTS");
    expect(guide).toContain("B2_VERCEL_ALLOW_SHARED_SERVER_CREDENTIAL");
    expect(guide).toContain("B2_VERCEL_ADMIT_ALL_ISSUER_SUBJECTS");
    expect(guide).toContain("B2_VERCEL_ALLOWED_OAUTH_CLIENT_IDS");
    expect(guide).toContain("subjectless Okta profile");
    expect(envExample).toContain("B2_OAUTH_ALLOWED_SUBJECTS=");
    expect(envExample).toContain("B2_VERCEL_ADMIT_ALL_ISSUER_SUBJECTS=true");
    expect(envExample).toContain("B2_VERCEL_ALLOWED_OAUTH_CLIENT_IDS=");
  });

  it("keeps Vercel runtime sources in reviewed TypeScript projects", () => {
    const tsconfig = readFileSync(join(root, "tsconfig.typecheck.json"), "utf8");
    const vercelTsconfig = readFileSync(join(root, "tsconfig.vercel-runtime.json"), "utf8");

    expect(tsconfig).toContain('"deploy/vercel/**/*"');
    expect(vercelTsconfig).toContain('"src/**/*"');
    expect(vercelTsconfig).toContain('"deploy/vercel/**/*.ts"');
  });

  it("keeps the Vercel function source graph within the reviewed budget", () => {
    const files = collectLocalImportGraph(VERCEL_FUNCTION_ENTRYPOINTS);
    const bytes = [...files].reduce((sum, file) => sum + statSync(file).size, 0);

    expect(files.size).toBeLessThanOrEqual(VERCEL_FUNCTION_SOURCE_FILES_BUDGET);
    expect(bytes).toBeLessThanOrEqual(VERCEL_FUNCTION_SOURCE_BYTES_BUDGET);
  });

  it("runs Vercel adapter parity, budget, and build-output gates", () => {
    const pkg = readJson<{ scripts?: Record<string, string> }>("package.json");
    const workflow = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");
    const modernParity = readFileSync(
      join(root, "tests/protocol/vercel.modern-protocol.test.ts"),
      "utf8",
    );
    const legacyParity = readFileSync(
      join(root, "tests/protocol/vercel.legacy-protocol.test.ts"),
      "utf8",
    );
    const bundleCheck = readFileSync(join(root, "scripts/check-vercel-bundle.mjs"), "utf8");
    const outputScan = readFileSync(join(root, "scripts/check-vercel-build-output.mjs"), "utf8");
    const buildPolicy = readFileSync(join(root, "scripts/vercel-build-policy.mjs"), "utf8");

    expect(modernParity).toContain('connectVercelClient("modern")');
    expect(modernParity).toContain("server/discover");
    expect(legacyParity).toContain('connectVercelClient("legacy")');
    expect(legacyParity).toContain("stateless adapter");
    expect(pkg.scripts?.["test:protocol"]).toContain("test:protocol:modern");
    expect(pkg.scripts?.["test:protocol"]).toContain("test:protocol:legacy");
    expect(pkg.scripts?.["check:vercel-bundle"]).toBe("node scripts/check-vercel-bundle.mjs");
    expect(pkg.scripts?.["prepare:vercel-local-build"]).toBe(
      "node scripts/prepare-vercel-local-build.mjs",
    );
    expect(pkg.scripts?.["vercel-build"]).toBe("node scripts/run-vercel-project-build.mjs");
    expect(pkg.scripts?.["build:vercel-local"]).toBe("node scripts/run-vercel-local-build.mjs");
    expect(pkg.scripts?.["check:vercel-build-output"]).toBe(
      "node scripts/check-vercel-build-output.mjs",
    );
    expect(workflow).toContain("pnpm run check:vercel-bundle");
    expect(workflow).toContain("pnpm run build:vercel-local");
    expect(workflow).not.toContain("pnpm dlx vercel");
    expect(workflow).toContain("pnpm run check:vercel-build-output");
    expect(workflow).toContain("reports/vercel-bundle/");
    expect(workflow).toContain("reports/vercel-build-output/");
    expect(workflow).not.toContain(".vercel/output/functions/**/.vc-config.json");
    expect(bundleCheck).toContain("VERCEL_FUNCTION_BUNDLE_BUDGET_BYTES");
    expect(bundleCheck).toContain("VERCEL_CLI_VERSION");
    expect(bundleCheck).toContain("VERCEL_NODE_BUILDER_VERSION");
    expect(bundleCheck).toContain("VERCEL_FUNCTION_RUNTIME");
    expect(bundleCheck).toContain("reports/package-budget/metrics.json");
    expect(bundleCheck).toContain("@vercel/node");
    expect(outputScan).toContain("VERCEL_REQUIRED_FUNCTION_CONFIGS");
    expect(outputScan).toContain("VERCEL_REQUIRED_ROUTES");
    expect(buildPolicy).toContain('VERCEL_FUNCTION_RUNTIME = "nodejs24.x"');
  });
});
