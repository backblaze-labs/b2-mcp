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

function sectionBetween(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
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
      "B2_FILE_ROOT",
      "B2_HEALTHCHECK_ALLOW_PRIVATE",
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
      /^B2_MCP_ACCESS_[A-Z0-9_]+$/,
      /^B2_MCP_OAUTH_[A-Z0-9_]+$/,
    ];
    const providerSpecific = new Set([
      "B2_MCP_IMAGE",
      "B2_MCP_AUTH_FRONT_DOOR",
      "B2_MCP_KEY_ID_SECRET_ARN",
      "B2_MCP_KEY_SECRET_ARN",
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
    const auth = read("deploy/cloudflare-worker/src/auth.ts");
    const wrangler = read("deploy/cloudflare-worker/wrangler.jsonc");

    expect(pkg.scripts["build:deploy:cloudflare-worker"]).toContain(
      "tsc -p deploy/cloudflare-worker/tsconfig.json",
    );
    expect(pkg.scripts["build:deploy:cloudflare-worker"]).toContain("wrangler deploy");
    expect(pkg.scripts["build:deploy:cloudflare-worker"]).toContain(
      "scripts/check-worker-bundle-budget.mjs",
    );
    expect(worker).toContain("../../../src/http-handler.js");
    expect(worker).toContain("verifiedAuthInfoForRequest");
    expect(worker).not.toContain("process.env");
    expect(auth).toContain("cf-access-jwt-assertion");
    expect(worker).not.toContain("registerBucketTools");
    expect(worker).not.toContain("@modelcontextprotocol/sdk");
    expect(read("docs/deployment/cloudflare-workers.md")).toContain("source-checkout-only");
    expect(read("docs/deployment/cloudflare-workers.md")).toContain("B2_MAX_SESSIONS");
    expect(read("docs/deployment/cloudflare-workers.md")).toContain(
      "`resource` claim does not substitute",
    );
    expect(wrangler).toContain('"nodejs_compat"');
    expect(wrangler).toContain('"nodejs_compat_do_not_populate_process_env"');
    expect(wrangler).toMatch(/"compatibility_date": "\d{4}-\d{2}-\d{2}"/);
    expect(wrangler).not.toContain("B2_MCP_OAUTH_REQUIRED_SCOPES");
    expect(wrangler).not.toContain("B2_MCP_TRUSTED_EDGE_AUTH");
    expect(wrangler).not.toContain("B2_MCP_ACCESS_AUDIENCE");
  });

  it("keeps deployment guides covered by the public contract register", () => {
    const contracts = read("docs/PUBLIC_CONTRACTS.md");

    expect(contracts).toContain("deployment/*.md");
    expect(contracts).toContain("Provider-specific deployment recipes");
  });

  it("keeps the AWS exact setup runnable enough to create ECS resources", () => {
    const aws = read("docs/deployment/aws.md");
    const exactSetup = sectionBetween(aws, "## Exact setup", "## Secrets");

    expect(exactSetup).toContain("aws ecs create-cluster");
    expect(exactSetup).toContain("NAT gateway");
    expect(exactSetup).toContain("assignPublicIp=DISABLED");
    expect(exactSetup).toContain("aws ecs register-task-definition");
    expect(exactSetup).toContain("aws ecs create-service");
    expect(exactSetup).toContain("B2_MCP_IMAGE");
    expect(exactSetup).toContain("B2_APPLICATION_KEY");
    expect(exactSetup).toContain("B2_MCP_KEY_ID_SECRET_ARN");
    expect(exactSetup).toContain("B2_MCP_KEY_SECRET_ARN");
    expect(exactSetup).not.toContain("secret:b2-mcp/application-key-id");
    expect(exactSetup).not.toContain('secret:b2-mcp/application-key"');
  });

  it("backs the Cloudflare Containers guide with a route-disabled template", () => {
    const guide = read("docs/deployment/cloudflare-containers.md");
    const exactSetup = sectionBetween(guide, "## Exact setup", "## Secrets");
    const deployment = sectionBetween(guide, "## Deployment", "## Custom domains and TLS");
    const wrangler = read("deploy/cloudflare-containers/wrangler.jsonc");
    const worker = read("deploy/cloudflare-containers/src/index.js");

    expect(exactSetup).toContain("deploy/cloudflare-containers/src/index.js");
    expect(exactSetup).toContain("deploy/cloudflare-containers/wrangler.jsonc");
    expect(exactSetup).toContain("wrangler containers push");
    expect(exactSetup).toContain("B2_APPLICATION_KEY_ID");
    expect(deployment).toContain("B2_MCP_AUTH_FRONT_DOOR=configured");
    expect(deployment).toContain("returns");
    expect(deployment).toContain("503");
    expect(wrangler).toContain('"workers_dev": false');
    expect(wrangler).toContain('"containers"');
    expect(wrangler).toContain('"durable_objects"');
    expect(wrangler).toContain('"migrations"');
    expect(wrangler).toContain('"name": "MCP_CONTAINER"');
    expect(worker).toContain("class B2McpContainer extends Container");
    expect(worker).toContain("getContainer(env.MCP_CONTAINER");
    expect(worker).toContain("startAndWaitForPorts");
    expect(worker).toContain("STRIPPED_PUBLIC_HEADERS");
  });

  it("keeps Cloud Run private to reviewed invokers", () => {
    const deployment = sectionBetween(
      read("docs/deployment/google-cloud-run.md"),
      "## Deployment",
      "## Custom domains and TLS",
    );

    expect(deployment).toContain("--no-allow-unauthenticated");
    expect(deployment).toContain("remove-iam-policy-binding");
    expect(deployment).toContain("--member allUsers");
    expect(deployment).toContain("add-iam-policy-binding");
    expect(deployment).toContain("serviceAccount:REPLACE_WITH_FRONT_DOOR_SERVICE_ACCOUNT");
    expect(deployment).toContain("roles/run.invoker");
  });

  it("keeps hosted experimental recipes private until caller auth exists", () => {
    const azureDeployment = sectionBetween(
      read("docs/deployment/azure-container-apps.md"),
      "## Deployment",
      "## Custom domains and TLS",
    );
    const renderExactSetup = sectionBetween(
      read("docs/deployment/render.md"),
      "## Exact setup",
      "## Secrets",
    );
    const railwayExactSetup = sectionBetween(
      read("docs/deployment/railway.md"),
      "## Exact setup",
      "## Secrets",
    );
    const flyExactSetup = sectionBetween(
      read("docs/deployment/fly-io.md"),
      "## Exact setup",
      "## Secrets",
    );

    expect(azureDeployment).toContain("--ingress internal");
    expect(azureDeployment).toContain("--secrets b2-application-key-id");
    expect(azureDeployment).toContain("secretref:b2-application-key-id");
    expect(azureDeployment).not.toContain("--ingress external");
    expect(renderExactSetup).toContain("Service type: Private Service");
    expect(renderExactSetup).toContain("Do not create or attach a public");
    expect(railwayExactSetup).toContain("Do not generate a public Railway domain");
    expect(flyExactSetup).toContain("without public");
    expect(flyExactSetup).not.toContain("[[services]]");
    expect(flyExactSetup).not.toContain("[http_service]");
  });

  it("labels base commits as runtime baselines instead of verification commits", () => {
    const docs = ["docs/DEPLOY.md", ...providerGuides.map((guide) => `docs/deployment/${guide}`)];

    for (const doc of docs) {
      const text = read(doc);
      expect(text).not.toContain("Repository baseline: `6819d74`");
      if (text.includes("6819d74")) expect(text).toContain("Base/runtime baseline");
    }
  });
});
