#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vercelBuildForbiddenEnvNames } from "./b2-credential-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vercelDir = path.join(root, ".vercel");
const FIXED_LOCAL_PROJECT_CREATED_AT = 1785542400000;

const presentSecretNames = vercelBuildForbiddenEnvNames(process.env).filter(
  (name) => typeof process.env[name] === "string" && process.env[name] !== "",
);

if (presentSecretNames.length > 0) {
  for (const name of presentSecretNames) {
    console.error(`::error::vercel-local-build: forbidden env var is set: ${name}`);
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
        // Fixed placeholder keeps the synthetic local project deterministic.
        createdAt: FIXED_LOCAL_PROJECT_CREATED_AT,
      },
    },
    null,
    2,
  )}\n`,
);

console.log("vercel-local-build: wrote local project settings without secrets");
