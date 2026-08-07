import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "../..");

describe("container image policy", () => {
  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
  const dockerignore = readFileSync(join(root, ".dockerignore"), "utf8");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const deploy = readFileSync(join(root, "docs/DEPLOY.md"), "utf8");
  const nvmrc = readFileSync(join(root, ".nvmrc"), "utf8").trim();
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    packageManager: string;
  };
  const publishScript = readFileSync(join(root, "scripts/publish-container-image.mjs"), "utf8");

  function isIgnored(candidate: string): boolean {
    const patterns = dockerignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    let ignored = false;
    for (const pattern of patterns) {
      const negated = pattern.startsWith("!");
      const rawPattern = negated ? pattern.slice(1) : pattern;
      const matches =
        rawPattern === candidate ||
        (rawPattern.endsWith("*") && candidate.startsWith(rawPattern.slice(0, -1))) ||
        (rawPattern.startsWith("*") && candidate.endsWith(rawPattern.slice(1)));
      if (matches) ignored = !negated;
    }
    return ignored;
  }

  it("builds a multi-stage production image on the pinned Node runtime", () => {
    const fromLines = dockerfile.match(/^FROM .+$/gm) ?? [];
    const nodeBaseLines = fromLines.filter((line) => line.includes(" node:"));
    expect(nodeBaseLines).not.toHaveLength(0);
    for (const line of nodeBaseLines) {
      expect(line).toContain(`node:${nvmrc}-bookworm-slim@sha256:`);
    }
    expect(dockerfile).not.toMatch(/^FROM\s+node:[^@\s]+(?:\s|$)/m);
    expect(dockerfile).toMatch(/resolved and reviewed \d{4}-\d{2}-\d{2}/);
    expect(dockerfile).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(dockerfile).toContain("pnpm prune --prod");
    expect(dockerfile).toContain("COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./");
  });

  it("derives pnpm from package.json packageManager", () => {
    expect(packageJson.packageManager).toMatch(/^pnpm@/);
    expect(dockerfile).toContain('require("./package.json")');
    expect(dockerfile).toContain('corepack", ["prepare", packageManager, "--activate"]');
    expect(dockerfile).not.toContain(packageJson.packageManager);
  });

  it("defaults containers to HTTP while preserving CLI transport selection", () => {
    expect(dockerfile).toContain("ENV B2_MCP_TRANSPORT=http");
    expect(dockerfile).toContain("ENV PORT=3000");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("path:'/health'");
    expect(dockerfile).not.toContain("B2_APPLICATION_KEY=");
    expect(dockerfile).not.toContain("B2_APPLICATION_KEY_ID=");
  });

  it("keeps local artifacts and secrets out of the Docker build context", () => {
    for (const pattern of [
      ".git",
      ".env",
      ".env*",
      "!.env.example",
      ".envrc",
      ".npmrc",
      "*.pem",
      "*.key",
      "node_modules",
      "dist",
      "coverage",
      "reports",
      "docs/internal",
    ]) {
      expect(dockerignore).toContain(pattern);
    }
    expect(isIgnored(".env.production")).toBe(true);
    expect(isIgnored(".env.prod")).toBe(true);
    expect(isIgnored(".env.staging")).toBe(true);
    expect(isIgnored(".envrc")).toBe(true);
    expect(isIgnored(".env.example")).toBe(false);
    expect(isIgnored("prod.pem")).toBe(true);
    expect(isIgnored("registry.key")).toBe(true);
  });

  it("publishes signed multi-platform images without overwriting version tags", () => {
    expect(publishScript).toContain('["linux/amd64", "linux/arm64"]');
    expect(publishScript).toContain("docker");
    expect(publishScript).toContain("buildx");
    expect(publishScript).toContain("imagetools");
    expect(publishScript).toContain("org.opencontainers.image.revision");
    expect(publishScript).toContain("--provenance=true");
    expect(publishScript).toContain("--sbom=true");
    expect(publishScript).toContain("readDockerBaseImage");
    expect(publishScript).toContain("org.opencontainers.image.base.digest");
    expect(publishScript).toContain("verifyAnonymousManifestPull");
    expect(publishScript).toContain("verifyTrustedExistingDigest");
    expect(publishScript).toContain("verify-attestation");
    expect(publishScript).toContain("DOCKER_CONFIG");
    expect(publishScript).toContain("cosign");
    expect(publishScript).toContain("signDigest");
    expect(publishScript.indexOf("signDigest(registryImage, digest);")).toBeLessThan(
      publishScript.indexOf("verifyAnonymousManifestPull(versionRef);"),
    );
    expect(publishScript).not.toContain(":latest");
  });

  it("documents container healthcheck constraints for non-HTTP modes", () => {
    expect(readme).toContain("--no-healthcheck");
    expect(deploy).toContain("--no-healthcheck");
    expect(deploy).toContain("`PORT`, not only `--port`");
  });

  it("documents the intentional runtime doc set divergence", () => {
    expect(dockerfile).toContain("not mirror the npm packlist fixtures");
  });
});
