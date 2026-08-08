import { readFileSync } from "fs";
import { join } from "path";
import { readJson, root } from "./support";

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
    expect(guide).toContain("not deployment-wide abuse controls");
    expect(guide).toContain("Production environment secrets");
    expect(guide).toContain("x-vercel-protection-bypass");
    expect(guide).toContain("https://vercel.com/docs/functions/limitations");
    expect(guide).toContain("https://vercel.com/docs/fluid-compute");
  });

  it("keeps Vercel TypeScript files in the typecheck-only project", () => {
    const tsconfig = readFileSync(join(root, "tsconfig.typecheck.json"), "utf8");

    expect(tsconfig).toContain('"api/**/*"');
    expect(tsconfig).toContain('"deploy/vercel/**/*"');
  });
});
