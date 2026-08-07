#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const REQUIRED_PLATFORMS = ["linux/amd64", "linux/arm64"];
const RETRYABLE_OUTPUT =
  /(?:429|500|502|503|504|denied: retry|EOF|ECONNRESET|ETIMEDOUT|rate limit|timeout|temporary|temporarily|unavailable)/i;

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
      encoding: options.input ? "utf8" : undefined,
      input: options.input,
      stdio: options.capture ? "pipe" : options.input ? ["pipe", "inherit", "inherit"] : "inherit",
    });
    if (result.status === 0) return result;
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (attempt < attempts && RETRYABLE_OUTPUT.test(output)) {
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

function inspectImage(ref, { optional = false } = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = spawnSync(
      "docker",
      ["buildx", "imagetools", "inspect", ref, "--format", "{{json .}}"],
      { encoding: "utf8" },
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

  run("docker", ["login", "ghcr.io", "-u", githubActor, "--password-stdin"], {
    input: ghcrToken,
    attempts: 3,
  });

  const existingVersion = inspectImage(versionRef, { optional: true });
  const existingRelease = inspectImage(releaseRef, { optional: true });

  if (existingVersion) {
    requireExpectedManifest(existingVersion, versionRef, checkoutSha);
    const digest = manifestDigest(existingVersion);
    if (existingRelease && manifestDigest(existingRelease) !== digest) {
      throw new Error(`${releaseRef} already exists with a different digest`);
    }
    createTagIfMissing(releaseRef, `${registryImage}@${digest}`);
    signDigest(registryImage, digest);
    writeOutputs({ digest, imageRef: `${registryImage}@${digest}`, summaryRef: versionRef });
    console.log(`${versionRef} already exists for ${checkoutSha}; treated as idempotent`);
    return;
  }

  if (existingRelease) {
    requireExpectedManifest(existingRelease, releaseRef, checkoutSha);
    const digest = manifestDigest(existingRelease);
    createTagIfMissing(versionRef, `${registryImage}@${digest}`);
    signDigest(registryImage, digest);
    writeOutputs({ digest, imageRef: `${registryImage}@${digest}`, summaryRef: versionRef });
    console.log(`${releaseRef} already exists for ${checkoutSha}; restored missing version tag`);
    return;
  }

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
      "--annotation",
      `index:org.opencontainers.image.source=${githubServerUrl}/${githubRepository}`,
      "--annotation",
      `index:org.opencontainers.image.revision=${checkoutSha}`,
      "--annotation",
      `index:org.opencontainers.image.version=${version}`,
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
  signDigest(registryImage, digest);
  writeOutputs({ digest, imageRef: `${registryImage}@${digest}`, summaryRef: versionRef });
}

try {
  publish();
} catch (err) {
  process.stderr.write(`container-publish: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
