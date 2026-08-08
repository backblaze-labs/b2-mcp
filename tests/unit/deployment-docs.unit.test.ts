import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const root = join(__dirname, "../..");

const providerGuides = [
  "security-and-credentials.md",
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
];

const requiredProviderSections = [
  "## Prerequisites",
  "## Architecture",
  "## Exact setup",
  "## Secrets",
  "## Deployment",
  "## Custom domains and TLS",
  "## Authentication",
  "## Health checks",
  "## Smoke testing",
  "## Logs",
  "## Scaling and sessions",
  "## Rollback",
  "## Secret rotation",
  "## Teardown",
  "## Limitations",
  "## Cost controls",
  "## Troubleshooting",
  "## References",
];

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function listFiles(dir: string): string[] {
  const absolute = join(root, dir);
  return readdirSync(absolute)
    .sort()
    .flatMap((entry) => {
      const relative = join(dir, entry);
      const stat = statSync(join(root, relative));
      return stat.isDirectory() ? listFiles(relative) : [relative];
    });
}

function sourceRuntimeEnvNames(): Set<string> {
  const names = new Set<string>();
  const envRegex = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g;
  for (const file of listFiles("src").filter((path) => path.endsWith(".ts"))) {
    const text = read(file);
    for (const match of text.matchAll(envRegex)) names.add(match[1] ?? match[2]);
  }
  return names;
}

describe("deployment documentation", () => {
  it("keeps the deployment index linked to every stable provider guide", () => {
    const deploy = read("docs/DEPLOY.md");
    const readme = read("README.md");

    for (const guide of providerGuides) {
      const link = `docs/deployment/${guide}`;
      const deployLink = `deployment/${guide}`;
      expect(deploy).toContain(deployLink);
      expect(readme).toContain(link);
    }
  });

  it("keeps provider guides on the shared security contract and required sections", () => {
    for (const guide of providerGuides.filter((name) => name !== "security-and-credentials.md")) {
      const text = read(`docs/deployment/${guide}`);
      expect(text).toContain("security-and-credentials.md");
      expect(text).toMatch(/Support level: (supported|OCI-compatible|experimental)/);
      for (const section of requiredProviderSections) expect(text).toContain(section);
    }
  });

  it("documents B2 env vars only when runtime-owned or provider-specific", () => {
    const docs = [
      "README.md",
      "docs/DEPLOY.md",
      ...providerGuides.map((guide) => `docs/deployment/${guide}`),
    ];
    const documented = new Set<string>();
    for (const doc of docs) {
      for (const match of read(doc).matchAll(/\bB2_[A-Z0-9_]+\b/g)) documented.add(match[0]);
    }

    const runtime = sourceRuntimeEnvNames();
    for (const name of [
      "B2_ALLOWED_HOSTS",
      "B2_ALLOWED_ORIGINS",
      "B2_ALLOW_LOCAL_FILES",
      "B2_APPLICATION_KEY",
      "B2_APPLICATION_KEY_ID",
      "B2_APP_KEY",
      "B2_APP_KEY_ID",
      "B2_DESTRUCTIVE_POLICY",
      "B2_HTTP_CREDENTIAL_MODE",
      "B2_MASTER_KEY",
      "B2_MASTER_KEY_ID",
      "B2_MAX_SESSIONS",
      "B2_MAX_SESSIONS_PER_KEY",
      "B2_MCP_OUTPUT_FORMAT",
      "B2_MCP_RATE_LIMIT_BURST",
      "B2_MCP_RATE_LIMIT_RPS",
      "B2_MCP_TRANSPORT",
      "B2_PRINCIPAL_CREDENTIAL_MAP",
      "B2_REGION",
    ]) {
      runtime.add(name);
    }
    const allowedPatterns = [
      /^B2_CREDENTIAL_[A-Z0-9_]+_(?:APP_KEY|APPLICATION_KEY|MASTER_KEY)(?:_ID)?$/,
      /^B2_MCP_OAUTH_[A-Z0-9_]+$/,
    ];
    const providerSpecific = new Set([
      "B2_MCP_IMAGE",
      "B2_MCP_TRUSTED_EDGE_AUTH",
      "B2_MCP_VERSION",
    ]);
    const unknown = [...documented]
      .filter(
        (name) =>
          !name.endsWith("_") &&
          !runtime.has(name) &&
          !providerSpecific.has(name) &&
          !allowedPatterns.some((pattern) => pattern.test(name)),
      )
      .sort();

    expect(unknown).toEqual([]);
  });

  it("does not document credentials in URLs or query strings", () => {
    const text = [
      read("docs/DEPLOY.md"),
      ...providerGuides.map((guide) => read(`docs/deployment/${guide}`)),
    ].join("\n");

    expect(text).not.toMatch(/https?:\/\/[^\s)`]+(?:B2_APPLICATION_KEY|B2_KEY|Authorization=)/i);
    expect(text).not.toMatch(/https?:\/\/[^\s)`]+X-Amz-(?:Credential|Signature)=/i);
  });

  it("keeps the native Worker adapter as a thin shared-handler boundary", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const worker = read("deploy/cloudflare-worker/src/index.ts");
    const wrangler = read("deploy/cloudflare-worker/wrangler.jsonc");

    expect(pkg.scripts["build:deploy:cloudflare-worker"]).toBe(
      "tsc -p deploy/cloudflare-worker/tsconfig.json",
    );
    expect(worker).toContain("../../../src/http-handler.js");
    expect(worker).not.toContain("registerBucketTools");
    expect(worker).not.toContain("@modelcontextprotocol/sdk");
    expect(wrangler).toContain('"nodejs_compat"');
    expect(wrangler).toContain('"compatibility_date": "2026-08-08"');
  });
});
