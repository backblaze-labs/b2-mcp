import { existsSync, readFileSync, statSync } from "fs";
import { dirname, extname, join, resolve } from "path";
import { readJson, root } from "./support";

const VERCEL_FUNCTION_ENTRYPOINTS = [
  "api/mcp.ts",
  "api/health.ts",
  "api/oauth-protected-resource.ts",
  "api/oauth-authorization-server.ts",
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
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?["']([^"']+)["']|import\(["']([^"']+)["']\)/g;
  function visit(relativePath: string): void {
    const absolutePath = resolve(root, relativePath);
    if (seen.has(absolutePath)) return;
    seen.add(absolutePath);
    const source = readFileSync(absolutePath, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const resolved = resolveLocalImport(absolutePath, match[1] ?? match[2]);
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
  });

  it("publishes the expected Vercel routes and Node runtime policy", () => {
    const vercel = readJson<{
      fluid?: boolean;
      regions?: string[];
      functions?: Record<string, { runtime?: string; maxDuration?: number }>;
      rewrites?: { source: string; destination: string }[];
    }>("vercel.json");

    expect(vercel.fluid).toBe(true);
    expect(vercel.regions).toEqual(["iad1"]);
    expect(vercel.functions?.["api/*.ts"]).toMatchObject({
      runtime: "nodejs22.x",
      maxDuration: 60,
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
    expect(envExample).toContain("B2_OAUTH_ALLOWED_SUBJECTS=");
  });

  it("keeps Vercel TypeScript files in the typecheck-only project", () => {
    const tsconfig = readFileSync(join(root, "tsconfig.typecheck.json"), "utf8");

    expect(tsconfig).toContain('"api/**/*"');
    expect(tsconfig).toContain('"deploy/vercel/**/*"');
  });

  it("keeps the Vercel function source graph within the reviewed budget", () => {
    const files = collectLocalImportGraph(VERCEL_FUNCTION_ENTRYPOINTS);
    const bytes = [...files].reduce((sum, file) => sum + statSync(file).size, 0);

    expect(files.size).toBeLessThanOrEqual(VERCEL_FUNCTION_SOURCE_FILES_BUDGET);
    expect(bytes).toBeLessThanOrEqual(VERCEL_FUNCTION_SOURCE_BYTES_BUDGET);
  });

  it("runs Vercel adapter parity and bundle-budget gates", () => {
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

    expect(modernParity).toContain('connectVercelClient("modern")');
    expect(modernParity).toContain("server/discover");
    expect(legacyParity).toContain('connectVercelClient("legacy")');
    expect(legacyParity).toContain("stateless adapter");
    expect(pkg.scripts?.["test:protocol"]).toContain("test:protocol:modern");
    expect(pkg.scripts?.["test:protocol"]).toContain("test:protocol:legacy");
    expect(pkg.scripts?.["check:vercel-bundle"]).toBe("node scripts/check-vercel-bundle.mjs");
    expect(workflow).toContain("pnpm run check:vercel-bundle");
    expect(workflow).toContain("reports/vercel-bundle/");
    expect(bundleCheck).toContain("VERCEL_FUNCTION_BUNDLE_BUDGET_BYTES");
    expect(bundleCheck).toContain("reports/package-budget/metrics.json");
  });
});
