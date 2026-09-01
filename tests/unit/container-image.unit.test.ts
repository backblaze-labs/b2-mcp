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
  const smokeScript = readFileSync(join(root, "scripts/smoke-container-image.mjs"), "utf8");
  const publishWorkflow = readFileSync(join(root, ".github/workflows/publish.yml"), "utf8");

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
      "coverage",
      "reports",
      "docs/internal",
    ]) {
      expect(dockerignore).toContain(pattern);
    }
    // `dist` is intentionally NOT ignored at the root: the customer-hosted
    // deploy build (deploy/customer-hosted/Dockerfile, root build context)
    // COPYs the prebuilt dist. The root image builds dist from src and never
    // COPYs host dist, so leaving it in-context is harmless for that image.
    expect(dockerignore).not.toContain("\ndist\n");
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
    expect(publishScript).toContain("requireBuildKitAttestations");
    expect(publishScript).toContain("vnd.docker.reference.type");
    expect(publishScript).toContain("in-toto.io/predicate-type");
    expect(publishScript).toContain("https://spdx.dev/Document");
    expect(publishScript).toContain("https://slsa.dev/provenance/");
    expect(publishScript).not.toContain("verify-attestation");
    expect(publishScript).toContain("DOCKER_CONFIG");
    expect(publishScript).toContain("cosign");
    expect(publishScript).toContain("signDigest");
    expect(publishScript).toContain('SIGNATURE_REPOSITORY_SUFFIX = "-signatures"');
    expect(publishScript).toContain("COSIGN_REPOSITORY");
    expect(publishScript).toContain("verifyAnonymousSignature");
    expect(publishScript).toContain("signature-repository");
    expect(publishWorkflow).toContain(
      "COSIGN_REPOSITORY: ghcr.io/${{ github.repository }}-signatures",
    );
    expect(publishScript).toContain("refs/heads/main");
    expect(publishScript).not.toContain("refs/tags/v.*|refs/heads/main");
    expect(publishScript.indexOf("signDigest(registryImage, digest, signatureRepo);")).toBeLessThan(
      publishScript.indexOf("verifyAnonymousManifestPull(versionRef);"),
    );
    expect(publishScript).not.toContain(":latest");
  });

  it("stamps the runtime release channel into stable images", () => {
    // Dockerfile stamps dist/release-version.json for a stable RELEASE_VERSION so
    // productVersion() reports the published channel; prereleases stay on dev.
    expect(dockerfile).toContain('ARG RELEASE_VERSION=""');
    expect(dockerfile).toContain("dist/release-version.json");
    expect(dockerfile).toContain("releaseChannel:'published'");
    // Publish and smoke propagate the version so the image is not built as dev.
    expect(publishScript).toContain("RELEASE_VERSION=${version}");
    expect(publishScript).toContain("...releaseBuildArgs");
    expect(smokeScript).toContain("--release-version");
    expect(smokeScript).toContain("smokeReleaseChannel");
    expect(smokeScript).toContain("RELEASE_CHANNEL");
    // The release smoke passes the stable version through to assert the channel.
    expect(publishWorkflow).toContain("--release-version");
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
