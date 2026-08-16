#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vercelDir = path.join(root, ".vercel");
const credentialPolicy = JSON.parse(
  readFileSync(path.join(root, "scripts", "b2-credential-env.json"), "utf8"),
);

const exactSecretNames = new Set(
  [
    ...(credentialPolicy.exact ?? []),
    ...(credentialPolicy.logSensitiveExact ?? []),
    "B2_OAUTH_INTROSPECTION_BEARER_TOKEN",
    "B2_OAUTH_INTROSPECTION_CLIENT_SECRET",
    "OAUTH_CLIENT_SECRET",
    "VERCEL_TOKEN",
  ].map((name) => name.toUpperCase()),
);
const secretNamePatterns = [
  ...(credentialPolicy.patterns ?? []).map((pattern) => new RegExp(pattern, "i")),
  /^B2_OAUTH_.*(?:SECRET|TOKEN)$/i,
  /^OAUTH_.*(?:SECRET|TOKEN)$/i,
  /^VERCEL_.*(?:BYPASS|SECRET|TOKEN)$/i,
];

function isSecretEnvName(name) {
  const upper = name.toUpperCase();
  return exactSecretNames.has(upper) || secretNamePatterns.some((pattern) => pattern.test(name));
}

const presentSecretNames = Object.entries(process.env)
  .filter(([name, value]) => isSecretEnvName(name) && typeof value === "string" && value !== "")
  .map(([name]) => name)
  .sort();

if (presentSecretNames.length > 0) {
  for (const name of presentSecretNames) {
    console.error(`::error::vercel-local-build: secret-bearing env var is set: ${name}`);
  }
  process.exit(1);
}

rmSync(path.join(vercelDir, "output"), { recursive: true, force: true });
mkdirSync(vercelDir, { recursive: true });

writeFileSync(
  path.join(vercelDir, "project.json"),
  `${JSON.stringify(
    {
      orgId: "team_b2_mcp_ci_local_build",
      projectId: "prj_b2_mcp_ci_local_build",
      settings: {
        framework: null,
        rootDirectory: null,
        installCommand: "corepack enable && pnpm install --frozen-lockfile",
        buildCommand: null,
        devCommand: null,
        outputDirectory: null,
        createdAt: 1785542400000,
      },
    },
    null,
    2,
  )}\n`,
);

console.log("vercel-local-build: wrote local project settings without secrets");
