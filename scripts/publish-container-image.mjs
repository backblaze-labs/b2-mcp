#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REQUIRED_PLATFORMS = ["linux/amd64", "linux/arm64"];
const BUILDKIT_ATTESTATION_TYPE = "attestation-manifest";
const SPDX_PREDICATE_TYPE = "https://spdx.dev/Document";
const SLSA_PREDICATE_PREFIX = "https://slsa.dev/provenance/";
const RETRYABLE_OUTPUT =
  /(?:429|500|502|503|504|denied: retry|EOF|ECONNRESET|ETIMEDOUT|rate limit|timeout|temporary|temporarily|unavailable)/i;

// This script needs Docker/Cosign stdio and env handling that retry-utils.cjs
// does not expose for arbitrary non-npm commands, so the wrapper stays local.
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(command, args, options = {}) {
  const attempts = options.attempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(command, args, {
      encoding: options.input || options.capture ? "utf8" : undefined,
      env: options.env,
      input: options.input,
      stdio: options.capture ? "pipe" : options.input ? ["pipe", "inherit", "inherit"] : "inherit",
    });
    if (result.status === 0) return result;
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const shouldRetry =
      attempt < attempts && (options.retryAllFailures === true || RETRYABLE_OUTPUT.test(output));
    if (shouldRetry) {
      console.warn(
        `container-publish: retrying ${command} ${args.join(" ")} after transient failure (${attempt}/${attempts})`,
      );
      sleep(1_000 * attempt);
      continue;
    }
    if (options.capture) {
      process.stderr.write(output);
    }
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
  throw new Error(`${command} ${args.join(" ")} failed without a result`);
}

function inspectImage(ref, { optional = false, env } = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = spawnSync(
      "docker",
      ["buildx", "imagetools", "inspect", ref, "--format", "{{json .}}"],
      { encoding: "utf8", env },
    );
    if (result.status === 0) return JSON.parse(result.stdout);
    const output = `${result.stdout}\n${result.stderr}`;
    if (optional && /(?:not found|manifest unknown|404)/i.test(output)) return null;
    if (attempt < 3 && RETRYABLE_OUTPUT.test(output)) {
      console.warn(`container-publish: retrying image inspect for ${ref} (${attempt}/3)`);
      sleep(1_000 * attempt);
      continue;
    }
    throw new Error(`Could not inspect ${ref}: ${output}`);
  }
  return null;
}

function inspectRawManifest(ref) {
  const result = run("docker", ["buildx", "imagetools", "inspect", ref, "--raw"], {
    attempts: 3,
    capture: true,
  });
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `Could not parse raw manifest for ${ref}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function manifestDigest(info) {
  const digest = info?.manifest?.digest;
  if (typeof digest !== "string" || !digest.startsWith("sha256:")) {
    throw new Error("published image manifest digest is missing");
  }
  return digest;
}

function manifestRevision(info) {
  const annotations = info?.manifest?.annotations ?? {};
  return annotations["org.opencontainers.image.revision"];
}

function manifestPlatforms(info) {
  const manifests = info?.manifest?.manifests ?? [];
  return manifests
    .map((entry) => entry.platform)
    .filter((platform) => platform?.os && platform?.architecture && platform.os !== "unknown")
    .map((platform) => `${platform.os}/${platform.architecture}`);
}

function requiredPlatformManifests(info, ref) {
  const manifests = info?.manifest?.manifests ?? [];
  return REQUIRED_PLATFORMS.map((required) => {
    const manifest = manifests.find((entry) => {
      const platform = entry.platform;
      return platform?.os && platform?.architecture
        ? `${platform.os}/${platform.architecture}` === required
        : false;
    });
    if (typeof manifest?.digest !== "string" || !manifest.digest.startsWith("sha256:")) {
      throw new Error(`${ref} is missing platform ${required}`);
    }
    return { platform: required, digest: manifest.digest };
  });
}

function requireExpectedManifest(info, ref, checkoutSha) {
  const revision = manifestRevision(info);
  if (revision !== checkoutSha) {
    throw new Error(
      `${ref} already exists with revision ${revision ?? "missing"}, not ${checkoutSha}`,
    );
  }
  const platforms = manifestPlatforms(info);
  for (const required of REQUIRED_PLATFORMS) {
    if (!platforms.includes(required)) {
      throw new Error(`${ref} is missing platform ${required}`);
    }
  }
}

function requireBuildKitAttestations(info, ref, registryImage) {
  const manifests = info?.manifest?.manifests ?? [];
  const attestationsBySubject = new Map();
  for (const entry of manifests) {
    const annotations = entry.annotations ?? {};
    if (annotations["vnd.docker.reference.type"] !== BUILDKIT_ATTESTATION_TYPE) continue;
    const subjectDigest = annotations["vnd.docker.reference.digest"];
    if (
      typeof subjectDigest === "string" &&
      subjectDigest.startsWith("sha256:") &&
      typeof entry.digest === "string" &&
      entry.digest.startsWith("sha256:")
    ) {
      attestationsBySubject.set(subjectDigest, entry.digest);
    }
  }

  for (const { platform, digest } of requiredPlatformManifests(info, ref)) {
    const attestationDigest = attestationsBySubject.get(digest);
    if (!attestationDigest) {
      throw new Error(`${ref} is missing a BuildKit attestation manifest for ${platform}`);
    }

    const rawAttestation = inspectRawManifest(`${registryImage}@${attestationDigest}`);
    const predicateTypes = new Set(
      (rawAttestation.layers ?? [])
        .map((layer) => layer.annotations?.["in-toto.io/predicate-type"])
        .filter((predicateType) => typeof predicateType === "string"),
    );
    if (
      ![...predicateTypes].some((predicateType) => predicateType.startsWith(SLSA_PREDICATE_PREFIX))
    ) {
      throw new Error(`${ref} BuildKit attestation for ${platform} is missing SLSA provenance`);
    }
    if (!predicateTypes.has(SPDX_PREDICATE_TYPE)) {
      throw new Error(`${ref} BuildKit attestation for ${platform} is missing an SPDX SBOM`);
    }
  }
}

function readDockerBaseImage() {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  if (/^FROM\s+node:[^@\s]+(?:\s|$)/m.test(dockerfile)) {
    throw new Error("Dockerfile Node base images must be pinned by sha256 digest");
  }
  const matches = [
    ...dockerfile.matchAll(/^FROM\s+(node:[^\s@]+)@(sha256:[a-f0-9]{64})\s+AS\s+\w+/gm),
  ];
  if (matches.length === 0) {
    throw new Error("Dockerfile does not contain a digest-pinned Node base image");
  }
  const [name, digest] = [matches[0][1], matches[0][2]];
  for (const match of matches) {
    if (match[1] !== name || match[2] !== digest) {
      throw new Error("Dockerfile Node base image digests must match across stages");
    }
  }
  return { name, digest, ref: `${name}@${digest}` };
}

function writeOutputs({ digest, imageRef, summaryRef }) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, `image-digest=${digest}\n`);
    appendFileSync(outputPath, `image-ref=${imageRef}\n`);
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, "\n## Container image\n\n");
    appendFileSync(summaryPath, `- Image: \`${summaryRef}\`\n`);
    appendFileSync(summaryPath, `- Digest: \`${digest}\`\n`);
    appendFileSync(summaryPath, `- Platforms: \`${REQUIRED_PLATFORMS.join("`, `")}\`\n`);
  }
}

function createTagIfMissing(tagRef, sourceDigestRef) {
  if (inspectImage(tagRef, { optional: true })) return;
  run("docker", ["buildx", "imagetools", "create", "--tag", tagRef, sourceDigestRef]);
}

function signDigest(registryImage, digest) {
  run("cosign", ["sign", "--yes", `${registryImage}@${digest}`], {
    attempts: 3,
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trustArgs(githubServerUrl, githubRepository) {
  const workflow = `${escapeRegex(githubServerUrl.replace(/\/$/, ""))}/${escapeRegex(githubRepository)}/\\.github/workflows/publish\\.yml`;
  const identity = `^${workflow}@refs/heads/main$`;
  return [
    "--certificate-identity-regexp",
    identity,
    "--certificate-oidc-issuer",
    "https://token.actions.githubusercontent.com",
  ];
}

function verifyTrustedExistingDigest(registryImage, digest, githubServerUrl, githubRepository) {
  const ref = `${registryImage}@${digest}`;
  const args = trustArgs(githubServerUrl, githubRepository);
  run("cosign", ["verify", ...args, ref], {
    attempts: 3,
  });
}

function verifyAnonymousManifestPull(ref) {
  const dockerConfig = mkdtempSync(join(tmpdir(), "b2-mcp-ghcr-anonymous-"));
  try {
    inspectImage(ref, {
      env: { ...process.env, DOCKER_CONFIG: dockerConfig },
    });
  } catch (err) {
    throw new Error(
      `Anonymous GHCR manifest pull failed for ${ref}. Make the ghcr.io package public in GitHub Packages, then rerun the publish workflow. ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    rmSync(dockerConfig, { recursive: true, force: true });
  }
}

function finishExistingImage({
  primaryInfo,
  primaryRef,
  secondaryInfo,
  secondaryRef,
  checkoutSha,
  registryImage,
  githubServerUrl,
  githubRepository,
  summaryRef,
  message,
}) {
  if (!primaryInfo) return false;
  requireExpectedManifest(primaryInfo, primaryRef, checkoutSha);
  const digest = manifestDigest(primaryInfo);
  if (secondaryInfo && manifestDigest(secondaryInfo) !== digest) {
    throw new Error(`${secondaryRef} already exists with a different digest`);
  }
  verifyTrustedExistingDigest(registryImage, digest, githubServerUrl, githubRepository);
  requireBuildKitAttestations(primaryInfo, primaryRef, registryImage);
  createTagIfMissing(secondaryRef, `${registryImage}@${digest}`);
  verifyAnonymousManifestPull(summaryRef);
  writeOutputs({ digest, imageRef: `${registryImage}@${digest}`, summaryRef });
  console.log(message);
  return true;
}

function publish() {
  const checkoutSha = requiredEnv("CHECKOUT_SHA");
  const publishTag = requiredEnv("PUBLISH_TAG");
  const registryImage = requiredEnv("REGISTRY_IMAGE").toLowerCase();
  const ghcrToken = requiredEnv("GHCR_TOKEN");
  const githubActor = requiredEnv("GITHUB_ACTOR");
  const githubServerUrl = requiredEnv("GITHUB_SERVER_URL");
  const githubRepository = requiredEnv("GITHUB_REPOSITORY");
  const version = publishTag.replace(/^v/, "");
  const versionRef = `${registryImage}:${version}`;
  const releaseRef = `${registryImage}:${publishTag}`;
  const baseImage = readDockerBaseImage();

  run("docker", ["login", "ghcr.io", "-u", githubActor, "--password-stdin"], {
    input: ghcrToken,
    attempts: 3,
  });

  const existingVersion = inspectImage(versionRef, { optional: true });
  const existingRelease = inspectImage(releaseRef, { optional: true });

  if (
    finishExistingImage({
      primaryInfo: existingVersion,
      primaryRef: versionRef,
      secondaryInfo: existingRelease,
      secondaryRef: releaseRef,
      checkoutSha,
      registryImage,
      githubServerUrl,
      githubRepository,
      summaryRef: versionRef,
      message: `${versionRef} already exists for ${checkoutSha}; treated as idempotent`,
    })
  )
    return;

  if (
    finishExistingImage({
      primaryInfo: existingRelease,
      primaryRef: releaseRef,
      secondaryInfo: existingVersion,
      secondaryRef: versionRef,
      checkoutSha,
      registryImage,
      githubServerUrl,
      githubRepository,
      summaryRef: versionRef,
      message: `${releaseRef} already exists for ${checkoutSha}; restored missing version tag`,
    })
  )
    return;

  run(
    "docker",
    [
      "buildx",
      "build",
      "--platform",
      REQUIRED_PLATFORMS.join(","),
      "--provenance=true",
      "--sbom=true",
      "--label",
      `org.opencontainers.image.source=${githubServerUrl}/${githubRepository}`,
      "--label",
      `org.opencontainers.image.revision=${checkoutSha}`,
      "--label",
      `org.opencontainers.image.version=${version}`,
      "--label",
      `org.opencontainers.image.base.name=${baseImage.name}`,
      "--label",
      `org.opencontainers.image.base.digest=${baseImage.digest}`,
      "--annotation",
      `index:org.opencontainers.image.source=${githubServerUrl}/${githubRepository}`,
      "--annotation",
      `index:org.opencontainers.image.revision=${checkoutSha}`,
      "--annotation",
      `index:org.opencontainers.image.version=${version}`,
      "--annotation",
      `index:org.opencontainers.image.base.name=${baseImage.name}`,
      "--annotation",
      `index:org.opencontainers.image.base.digest=${baseImage.digest}`,
      "--tag",
      versionRef,
      "--tag",
      releaseRef,
      "--push",
      ".",
    ],
    { attempts: 3 },
  );

  const publishedVersion = inspectImage(versionRef);
  const publishedRelease = inspectImage(releaseRef);
  requireExpectedManifest(publishedVersion, versionRef, checkoutSha);
  requireExpectedManifest(publishedRelease, releaseRef, checkoutSha);
  const digest = manifestDigest(publishedVersion);
  if (manifestDigest(publishedRelease) !== digest) {
    throw new Error(`${versionRef} and ${releaseRef} resolved to different digests`);
  }
  requireBuildKitAttestations(publishedVersion, versionRef, registryImage);
  signDigest(registryImage, digest);
  verifyAnonymousManifestPull(versionRef);
  writeOutputs({ digest, imageRef: `${registryImage}@${digest}`, summaryRef: versionRef });
}

try {
  publish();
} catch (err) {
  process.stderr.write(`container-publish: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
