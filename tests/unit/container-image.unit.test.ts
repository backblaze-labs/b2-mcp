import { spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";

const root = join(__dirname, "../..");
const publishScriptPath = join(root, "scripts/publish-container-image.mjs");
const registryImage = "ghcr.io/backblaze-labs/b2-mcp";
const signatureRepo = `${registryImage}-signatures`;
const checkoutSha = "0123456789abcdef0123456789abcdef01234567";
const publishTag = "v0.1.3";
const imageDigest = `sha256:${"a".repeat(64)}`;

type FakeCall = {
  args: string[];
  env: Record<string, string>;
};

type FakeState = {
  built?: boolean;
  existing?: boolean;
  failAnonymousSignature?: boolean;
  legacyOnly?: boolean;
  migrated?: boolean;
  signed?: boolean;
  transientAnonymousSignatureFailures?: number;
  transientSiblingVerifyFailures?: number;
  cosignCalls?: FakeCall[];
  dockerCalls?: FakeCall[];
};

const credentialEnvNames = [
  "GHCR_TOKEN",
  "GITHUB_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "DOCKER_AUTH_CONFIG",
  "NPM_TOKEN",
];

function commandPath(binDir: string, name: string): string {
  return join(binDir, process.platform === "win32" ? `${name}.cmd` : name);
}

function writeFakeCommand(binDir: string, name: string, script: string): void {
  const scriptPath = join(binDir, `${name}.js`);
  writeFileSync(scriptPath, script);
  if (process.platform === "win32") {
    writeFileSync(
      commandPath(binDir, name),
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
    );
  } else {
    writeFileSync(
      commandPath(binDir, name),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`,
    );
    chmodSync(commandPath(binDir, name), 0o755);
  }
}

function fakeDockerScript(statePath: string): string {
  return `
const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
const imageDigest = ${JSON.stringify(imageDigest)};
const checkoutSha = process.env.CHECKOUT_SHA;
const platformAmd64 = "sha256:${"b".repeat(64)}";
const platformArm64 = "sha256:${"c".repeat(64)}";
const attestationAmd64 = "sha256:${"d".repeat(64)}";
const attestationArm64 = "sha256:${"e".repeat(64)}";
const envKeys = [
  "COSIGN_REPOSITORY",
  "DOCKER_CONFIG",
  "HOME",
  "XDG_CACHE_HOME",
  "PATH",
  "GHCR_TOKEN",
  "GITHUB_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "DOCKER_AUTH_CONFIG",
  "NPM_TOKEN",
];
function readState() {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}
function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}
function pickedEnv() {
  return Object.fromEntries(envKeys.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
}
function imageInfo() {
  return {
    manifest: {
      digest: imageDigest,
      annotations: {
        "org.opencontainers.image.revision": checkoutSha,
      },
      manifests: [
        { digest: platformAmd64, platform: { os: "linux", architecture: "amd64" } },
        { digest: platformArm64, platform: { os: "linux", architecture: "arm64" } },
        {
          digest: attestationAmd64,
          annotations: {
            "vnd.docker.reference.type": "attestation-manifest",
            "vnd.docker.reference.digest": platformAmd64,
          },
        },
        {
          digest: attestationArm64,
          annotations: {
            "vnd.docker.reference.type": "attestation-manifest",
            "vnd.docker.reference.digest": platformArm64,
          },
        },
      ],
    },
  };
}
const args = process.argv.slice(2);
const state = readState();
state.dockerCalls = state.dockerCalls || [];
state.dockerCalls.push({ args, env: pickedEnv() });
saveState(state);
if (args[0] === "login") process.exit(0);
if (args[0] === "buildx" && args[1] === "build") {
  state.built = true;
  saveState(state);
  process.exit(0);
}
if (args[0] === "buildx" && args[1] === "imagetools" && args[2] === "inspect") {
  if (args.includes("--raw")) {
    console.log(JSON.stringify({
      layers: [
        { annotations: { "in-toto.io/predicate-type": "https://slsa.dev/provenance/v1" } },
        { annotations: { "in-toto.io/predicate-type": "https://spdx.dev/Document" } },
      ],
    }));
    process.exit(0);
  }
  const ref = args[3];
  const isReleaseTag = ref.endsWith(":0.1.3") || ref.endsWith(":v0.1.3");
  if (isReleaseTag && !state.built && !state.existing) {
    console.error("manifest unknown");
    process.exit(1);
  }
  console.log(JSON.stringify(imageInfo()));
  process.exit(0);
}
if (args[0] === "buildx" && args[1] === "imagetools" && args[2] === "create") {
  state.createdTags = state.createdTags || [];
  state.createdTags.push(args);
  saveState(state);
  process.exit(0);
}
console.error("unexpected docker " + args.join(" "));
process.exit(1);
`;
}

function fakeCosignScript(statePath: string): string {
  return `
const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
const signatureRepo = ${JSON.stringify(signatureRepo)};
const envKeys = [
  "COSIGN_REPOSITORY",
  "DOCKER_CONFIG",
  "HOME",
  "XDG_CACHE_HOME",
  "PATH",
  "GHCR_TOKEN",
  "GITHUB_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "DOCKER_AUTH_CONFIG",
  "NPM_TOKEN",
];
function readState() {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}
function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}
function pickedEnv() {
  return Object.fromEntries(envKeys.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
}
const args = process.argv.slice(2);
const state = readState();
state.cosignCalls = state.cosignCalls || [];
state.cosignCalls.push({ args, env: pickedEnv() });
const isAnonymous =
  args[0] === "verify" &&
  Boolean(process.env.DOCKER_CONFIG) &&
  !process.env.GHCR_TOKEN &&
  !process.env.GITHUB_TOKEN &&
  !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
if (args[0] === "sign") {
  state.signed = true;
  state.migrated = true;
  saveState(state);
  process.exit(0);
}
if (args[0] === "verify") {
  if (
    state.transientAnonymousSignatureFailures > 0 &&
    isAnonymous &&
    process.env.COSIGN_REPOSITORY === signatureRepo
  ) {
    state.transientAnonymousSignatureFailures -= 1;
    saveState(state);
    console.error("429 Too Many Requests");
    process.exit(1);
  }
  if (
    state.transientSiblingVerifyFailures > 0 &&
    !isAnonymous &&
    process.env.COSIGN_REPOSITORY === signatureRepo
  ) {
    state.transientSiblingVerifyFailures -= 1;
    saveState(state);
    console.error("429 Too Many Requests");
    process.exit(1);
  }
  if (state.failAnonymousSignature && isAnonymous) {
    saveState(state);
    console.error("denied: requested access to the resource is denied");
    process.exit(1);
  }
  if (state.legacyOnly && process.env.COSIGN_REPOSITORY === signatureRepo && !state.migrated) {
    saveState(state);
    console.error("no matching signatures");
    process.exit(1);
  }
  saveState(state);
  process.exit(0);
}
saveState(state);
console.error("unexpected cosign " + args.join(" "));
process.exit(1);
`;
}

function runPublishWithFakes(
  initialState: FakeState = {},
  envOverrides: Record<string, string> = {},
): { result: ReturnType<typeof spawnSync>; state: FakeState } {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "b2-mcp-container-publish-"));
  try {
    const binDir = join(fixtureRoot, "bin");
    const statePath = join(fixtureRoot, "state.json");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(statePath, JSON.stringify(initialState, null, 2));
    writeFakeCommand(binDir, "docker", fakeDockerScript(statePath));
    writeFakeCommand(binDir, "cosign", fakeCosignScript(statePath));

    const env = {
      ...process.env,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com",
      COSIGN_REPOSITORY: signatureRepo,
      DOCKER_AUTH_CONFIG: "registry-auth",
      GHCR_TOKEN: "ghcr-token",
      GITHUB_ACTOR: "goanpeca",
      GITHUB_REPOSITORY: "backblaze-labs/b2-mcp",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_TOKEN: "github-token",
      NPM_TOKEN: "npm-token",
      CHECKOUT_SHA: checkoutSha,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      PUBLISH_TAG: publishTag,
      REGISTRY_IMAGE: registryImage,
      ...envOverrides,
    };

    const result = spawnSync(process.execPath, [publishScriptPath], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    const state = JSON.parse(readFileSync(statePath, "utf8")) as FakeState;
    return { result, state };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function anonymousCalls(calls: FakeCall[] = []): FakeCall[] {
  return calls.filter((call) => call.env.DOCKER_CONFIG && !call.env.GHCR_TOKEN);
}

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
    expect(publishWorkflow).toContain(
      "COSIGN_REPOSITORY: ghcr.io/${{ github.repository }}-signatures",
    );
    expect(publishScript).toContain("refs/heads/main");
    expect(publishScript).not.toContain("refs/tags/v.*|refs/heads/main");
    expect(publishScript).not.toContain(":latest");
  });

  it("rejects a cosign repository outside the required sibling package", () => {
    const { result, state } = runPublishWithFakes({}, { COSIGN_REPOSITORY: registryImage });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`COSIGN_REPOSITORY must be ${signatureRepo}`);
    expect(state.dockerCalls ?? []).toHaveLength(0);
    expect(state.cosignCalls ?? []).toHaveLength(0);
  });

  it("signs and verifies new releases through the sibling signature repository", () => {
    const { result, state } = runPublishWithFakes();

    expect(result.status).toBe(0);
    const cosignCalls = state.cosignCalls ?? [];
    expect(cosignCalls).toContainEqual(
      expect.objectContaining({
        // Legacy referrers mode keeps signatures on the `sha256-<digest>.sig`
        // tag scheme that the sibling signature repo and anonymous verify need.
        args: [
          "sign",
          "--yes",
          "--registry-referrers-mode",
          "legacy",
          `${registryImage}@${imageDigest}`,
        ],
        env: expect.objectContaining({ COSIGN_REPOSITORY: signatureRepo }),
      }),
    );
    expect(cosignCalls).toContainEqual(
      expect.objectContaining({
        args: expect.arrayContaining(["verify", `${registryImage}@${imageDigest}`]),
        env: expect.objectContaining({ COSIGN_REPOSITORY: signatureRepo }),
      }),
    );

    const [anonymousSignature] = anonymousCalls(cosignCalls);
    expect(anonymousSignature).toBeDefined();
    expect(anonymousSignature.env.COSIGN_REPOSITORY).toBe(signatureRepo);
    expect(anonymousSignature.env.DOCKER_CONFIG).toContain("b2-mcp-ghcr-anonymous-");
    for (const name of credentialEnvNames) {
      expect(anonymousSignature.env).not.toHaveProperty(name);
    }

    const [anonymousManifest] = anonymousCalls(state.dockerCalls);
    expect(anonymousManifest).toBeDefined();
    expect(anonymousManifest.env.DOCKER_CONFIG).toContain("b2-mcp-ghcr-anonymous-");
    for (const name of credentialEnvNames) {
      expect(anonymousManifest.env).not.toHaveProperty(name);
    }
  });

  it("migrates idempotent reruns from legacy image-package signatures", () => {
    const { result, state } = runPublishWithFakes({ existing: true, legacyOnly: true });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("legacy image-package cosign signature");
    const cosignCalls = state.cosignCalls ?? [];
    expect(
      cosignCalls.some(
        (call) => call.args[0] === "verify" && call.env.COSIGN_REPOSITORY === signatureRepo,
      ),
    ).toBe(true);
    expect(
      cosignCalls.some((call) => call.args[0] === "verify" && !call.env.COSIGN_REPOSITORY),
    ).toBe(true);
    expect(
      cosignCalls.some(
        (call) => call.args[0] === "sign" && call.env.COSIGN_REPOSITORY === signatureRepo,
      ),
    ).toBe(true);
    expect(state.signed).toBe(true);
  });

  it("retries transient trusted sibling signature verification failures", () => {
    const { result, state } = runPublishWithFakes({
      existing: true,
      transientSiblingVerifyFailures: 1,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("retrying cosign verify");
    expect(state.transientSiblingVerifyFailures).toBe(0);
    expect(
      (state.cosignCalls ?? []).filter(
        (call) =>
          call.args[0] === "verify" &&
          !call.env.DOCKER_CONFIG &&
          call.env.COSIGN_REPOSITORY === signatureRepo,
      ),
    ).toHaveLength(2);
  });

  it("retries transient anonymous signature verification failures", () => {
    const { result, state } = runPublishWithFakes({ transientAnonymousSignatureFailures: 1 });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("retrying cosign verify");
    expect(state.transientAnonymousSignatureFailures).toBe(0);
    expect(
      anonymousCalls(state.cosignCalls).filter(
        (call) => call.args[0] === "verify" && call.env.COSIGN_REPOSITORY === signatureRepo,
      ),
    ).toHaveLength(2);
  });

  it("fails when sibling signatures are not anonymously readable", () => {
    const { result, state } = runPublishWithFakes({ failAnonymousSignature: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Anonymous GHCR signature verification failed");
    expect(result.stderr).toContain("Make the ghcr.io signature package public");
    expect(state.built).toBe(true);
    expect(state.signed).toBe(true);
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
