import { existsSync, readFileSync, statSync } from "fs";
import { dirname, extname, join, resolve } from "path";
import { listFiles, readJson, root } from "./support";

const providerGuides = [
  "vercel.md",
  "cloudflare-workers.md",
  "cloudflare-containers.md",
  "docker.md",
  "google-cloud-run.md",
  "aws.md",
  "azure-container-apps.md",
  "render.md",
  "railway.md",
  "fly-io.md",
] as const;

const allDeploymentDocs = ["DEPLOY.md", ...providerGuides.map((file) => `deployment/${file}`)];

function doc(relativePath: string): string {
  return readFileSync(join(root, "docs", relativePath), "utf8");
}

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

function b2EnvNames(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/\bB2_[A-Z0-9_]+\b/g)]
      .map((match) => match[0])
      .filter((name) => !name.endsWith("_")),
  );
}

describe("deployment documentation policy", () => {
  it("links every stable deployment guide from the index and README", () => {
    const deployIndex = doc("DEPLOY.md");
    const readme = readFileSync(join(root, "README.md"), "utf8");

    expect(deployIndex).toContain("Supported and continuously tested");
    expect(deployIndex).toContain("OCI-compatible");
    expect(deployIndex).toContain("Experimental compatibility");

    for (const fileName of ["security-and-credentials.md", ...providerGuides]) {
      const link = `docs/deployment/${fileName}`;
      expect(readme).toContain(link);
      expect(deployIndex).toContain(`deployment/${fileName}`);
    }
  });

  it("keeps provider guides complete enough for copy-paste operations", () => {
    const requiredSections = [
      "## Status",
      "## Prerequisites",
      "## Architecture",
      "## Setup",
      "## Secrets",
      "## Deployment",
      "## Domains And TLS",
      "## Authentication",
      "## Health Checks",
      "## Smoke Testing",
      "## Logs",
      "## Scaling",
      "## Rollback",
      "## Secret Rotation",
      "## Teardown",
      "## Limitations",
      "## Cost Controls",
      "## Verification Record",
      "## Official References",
    ];

    for (const fileName of providerGuides) {
      const text = doc(`deployment/${fileName}`);
      expect(text).toContain("docs/deployment/security-and-credentials.md");
      for (const section of requiredSections) {
        expect(text, `${fileName} is missing ${section}`).toContain(section);
      }
      expect(text).toMatch(/Do not\s+expose raw port\s+3000/i);
      expect(text).not.toMatch(/[^t] expose raw port 3000 publicly/i);
      expect(text).toContain("B2_ALLOW_LOCAL_FILES=false");
      expect(text).toContain("Last verified: 2026-08-14");
      expect(text).toContain("MCP revision: 2026-07-28");
    }
  });

  it("centralizes the shared production credential contract", () => {
    const security = doc("deployment/security-and-credentials.md");
    for (const required of [
      "The MCP client never sends B2 application keys through the LLM harness.",
      "B2_HTTP_CREDENTIAL_MODE=server",
      "Reject public X-B2-* credential headers",
      /never trust public\s+principal or identity headers/,
      "OAuth scopes and B2 capabilities are cumulative restrictions",
      "Production B2 credentials are never available to untrusted Preview",
      "B2_ALLOW_LOCAL_FILES=false",
      "B2_ALLOWED_HOSTS",
      "B2_DESTRUCTIVE_POLICY",
      "Never log B2 credentials, bearer tokens, presigned URLs",
      "GitHub Environment",
      "Process-local rate limits and caches are not global",
      "Threat Boundary",
    ]) {
      if (required instanceof RegExp) expect(security).toMatch(required);
      else expect(security).toContain(required);
    }
  });

  it("documents only known runtime or explicitly provider/test environment variables", () => {
    const sourceAndExamples = [
      ".env.example",
      "README.md",
      ...listFiles(join(root, "src")).filter((file) => file.endsWith(".ts")),
      ...listFiles(join(root, "scripts")).filter((file) => /\.(?:mjs|cjs|json)$/.test(file)),
      ...listFiles(join(root, "deploy")).filter((file) => /\.(?:ts|example|md|jsonc)$/.test(file)),
    ]
      .map((file) => readFileSync(file.startsWith(root) ? file : join(root, file), "utf8"))
      .join("\n");
    const known = b2EnvNames(sourceAndExamples);
    const explicitlyDocumented = new Set([
      "B2_MCP_VERSION",
      "B2_MCP_IMAGE",
      "B2_KEY_ID",
      "B2_KEY",
      "B2_SMOKE_BUCKET",
      "B2_MCP_EXPECTED_TOOL_PROFILE",
      "B2_MCP_SMOKE_CREDENTIAL_MODE",
      "B2_MCP_REQUIRE_SMOKE_BUCKET",
      "B2_MCP_ALLOW_ANY_TOOL_PROFILE",
      "B2_MCP_SMOKE_DEPLOYMENT_ENVIRONMENT",
      "B2_LIVE_TEST_ACCOUNT_ID",
      "B2_INTEGRATION_REQUIRE_CREDENTIALS",
      "B2_MCP_LIVE_RUN_PREFIX",
    ]);
    const documented = allDeploymentDocs
      .map(doc)
      .flatMap((text) => [...b2EnvNames(text)])
      .sort();
    const unknown = documented.filter(
      (name) => !known.has(name) && !explicitlyDocumented.has(name),
    );

    expect([...new Set(unknown)]).toEqual([]);
  });

  it("forbids credential values in documented URLs and examples", () => {
    const text = allDeploymentDocs.map(doc).join("\n");
    expect(text).not.toMatch(/https?:\/\/[^\s`)"]*[?&][^\s`)"]*(?:key|secret|token)=/i);
    expect(text).not.toMatch(
      /\b(?:B2_APPLICATION_KEY|B2_KEY|B2_OAUTH_INTROSPECTION_CLIENT_SECRET)\s*=\s*(?!your-|prod-|resource-|<|\.\.\.)[A-Za-z0-9_+=/-]{20,}/,
    );
  });

  it("keeps the Cloudflare Worker adapter thin and fetch-native", () => {
    const adapter = readFileSync(join(root, "deploy/cloudflare-worker/adapter.ts"), "utf8");
    const wrangler = readFileSync(join(root, "deploy/cloudflare-worker/wrangler.jsonc"), "utf8");
    const tsconfig = readFileSync(join(root, "tsconfig.typecheck.json"), "utf8");
    const pkg = readJson<{ scripts?: Record<string, string>; files?: string[] }>("package.json");

    expect(adapter).toContain("../../src/http-fetch-handler.js");
    expect(adapter).toContain("../../src/oauth-resource-server.js");
    expect(adapter).toContain("authenticateOAuthRequest");
    expect(adapter).not.toContain("@modelcontextprotocol/sdk");
    expect(adapter).not.toContain("agents/mcp/server");
    expect(adapter).not.toContain("McpAgent");
    expect(existsSync(join(root, "src/http-handler.ts"))).toBe(false);
    expect(wrangler).toContain('"compatibility_date": "2026-08-14"');
    expect(wrangler).toContain('"nodejs_compat"');
    expect(wrangler).toContain('"B2_ALLOW_LOCAL_FILES": "false"');
    expect(tsconfig).toContain('"deploy/cloudflare-worker/**/*"');
    expect(pkg.scripts?.["check:cloudflare-worker-bundle"]).toBe(
      "node scripts/check-cloudflare-worker-bundle.mjs",
    );
    expect(pkg.files).toContain("deploy/cloudflare-worker/wrangler.jsonc");
    expect(pkg.files).toContain("docs/deployment/*.md");

    const files = collectLocalImportGraph(["deploy/cloudflare-worker/worker.ts"]);
    const bytes = [...files].reduce((sum, file) => sum + statSync(file).size, 0);
    expect(files.size).toBeLessThanOrEqual(75);
    expect(bytes).toBeLessThanOrEqual(600_000);
  });
});
