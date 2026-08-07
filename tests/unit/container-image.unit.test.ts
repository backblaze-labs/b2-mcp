import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "../..");

describe("container image policy", () => {
  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
  const dockerignore = readFileSync(join(root, ".dockerignore"), "utf8");
  const nvmrc = readFileSync(join(root, ".nvmrc"), "utf8").trim();
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    packageManager: string;
  };
  const publishScript = readFileSync(join(root, "scripts/publish-container-image.mjs"), "utf8");

  function ignored(candidate: string): boolean {
    const patterns = dockerignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    return patterns.some((pattern) => {
      if (pattern === candidate) return true;
      if (pattern.endsWith("*")) return candidate.startsWith(pattern.slice(0, -1));
      if (pattern.startsWith("*")) return candidate.endsWith(pattern.slice(1));
      return false;
    });
  }

  it("builds a multi-stage production image on the pinned Node runtime", () => {
    const fromLines = dockerfile.match(/^FROM .+$/gm) ?? [];
    expect(fromLines).toHaveLength(4);
    expect(fromLines[0]).toContain(`node:${nvmrc}-bookworm-slim@sha256:`);
    expect(fromLines[0]).toContain(" AS base");
    expect(dockerfile).toContain("FROM dependencies AS build");
    expect(fromLines[3]).toContain(`node:${nvmrc}-bookworm-slim@sha256:`);
    expect(fromLines[3]).toContain(" AS runtime");
    expect(dockerfile).toMatch(/resolved and reviewed \d{4}-\d{2}-\d{2}/);
    expect(dockerfile).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(dockerfile).toContain("pnpm run build");
    expect(dockerfile).toContain("pnpm prune --prod");
    expect(dockerfile).toContain("COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./");
    expect(dockerfile).toContain('ENTRYPOINT ["node", "dist/index.js"]');
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
    for (const ignored of [
      ".git",
      ".env",
      ".env*",
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
      expect(dockerignore).toContain(ignored);
    }
    expect(ignored(".env.production")).toBe(true);
    expect(ignored(".env.staging")).toBe(true);
    expect(ignored(".envrc")).toBe(true);
    expect(ignored("prod.pem")).toBe(true);
    expect(ignored("registry.key")).toBe(true);
  });

  it("publishes signed multi-platform images without overwriting version tags", () => {
    expect(publishScript).toContain('["linux/amd64", "linux/arm64"]');
    expect(publishScript).toContain("docker");
    expect(publishScript).toContain("buildx");
    expect(publishScript).toContain("imagetools");
    expect(publishScript).toContain("org.opencontainers.image.revision");
    expect(publishScript).toContain("--provenance=true");
    expect(publishScript).toContain("--sbom=true");
    expect(publishScript).toContain("verifyAnonymousManifestPull");
    expect(publishScript).toContain("verifyTrustedExistingDigest");
    expect(publishScript).toContain("verify-attestation");
    expect(publishScript).toContain("DOCKER_CONFIG");
    expect(publishScript).toContain("cosign");
    expect(publishScript.match(/signDigest\(/g)).toHaveLength(2);
    expect(publishScript).not.toContain(":latest");
  });

  it("documents the intentional runtime doc set divergence", () => {
    expect(dockerfile).toContain("not mirror the npm packlist fixtures");
  });
});
