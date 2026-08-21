#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { parseJsoncObject } = require("./lib/local-import-graph.cjs");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredPublicPaths = [
  "/mcp",
  "/health",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
];
const findings = [];

validateVercelContract();
validateCloudflareWorkerContract();
validateDeploymentDocsContract();

if (findings.length > 0) {
  console.error("Deployment contract validation failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("deployment-contracts: deployment routes and policy contracts are valid");

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function validateVercelContract() {
  const vercel = readJson("vercel.json");
  const rewriteSources = new Set(
    Array.isArray(vercel.rewrites)
      ? vercel.rewrites.map((rewrite) => rewrite?.source).filter(Boolean)
      : [],
  );
  for (const path of requiredPublicPaths) {
    if (!rewriteSources.has(path)) findings.push(`vercel.json:1 missing rewrite source ${path}`);
  }
  for (const command of ["typecheck", "build"]) {
    if (!vercel.buildCommand?.includes(`pnpm run ${command}`)) {
      findings.push(`vercel.json:1 buildCommand must include pnpm run ${command}`);
    }
  }
}

function validateCloudflareWorkerContract() {
  const wrangler = parseJsoncObject(read("deploy/cloudflare-worker/wrangler.jsonc"));
  if (wrangler.compatibility_flags?.includes("nodejs_compat") !== true) {
    findings.push("deploy/cloudflare-worker/wrangler.jsonc:1 must enable nodejs_compat");
  }

  const workerAdapter = read("deploy/cloudflare-worker/adapter.ts");
  for (const path of [...requiredPublicPaths, "/api/mcp"]) {
    if (!workerAdapter.includes(`"${path}"`)) {
      findings.push(`deploy/cloudflare-worker/adapter.ts:1 missing route path ${path}`);
    }
  }
}

function validateDeploymentDocsContract() {
  requireDocTerms("deploy/vercel/README.md", [
    "POST /mcp",
    "GET /health",
    "GET /.well-known/oauth-protected-resource",
    "GET /.well-known/oauth-protected-resource/mcp",
    "GET /.well-known/oauth-authorization-server",
    "B2_MCP_PUBLIC_URL",
    "server",
    "phase1-default",
  ]);
  requireDocTerms("docs/deployment/vercel.md", [
    "/mcp",
    "/health",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "B2_HTTP_CREDENTIAL_MODE=server",
    "B2_MCP_PUBLIC_URL=https://mcp.example.com/mcp",
  ]);
  requireDocTerms("docs/deployment/cloudflare-workers.md", [
    "/mcp",
    "/health",
    "/.well-known/oauth-protected-resource/mcp",
    "B2_ALLOW_LOCAL_FILES=false",
    "B2_HTTP_CREDENTIAL_MODE=server",
    "phase1-default",
  ]);

  const readme = read("README.md");
  for (const envName of [
    "B2_APPLICATION_KEY_ID",
    "B2_APPLICATION_KEY",
    "B2_HTTP_CREDENTIAL_MODE",
    "B2_ALLOWED_HOSTS",
  ]) {
    if (!readme.includes(envName)) {
      findings.push(`README.md:1 missing documented deployment env ${envName}`);
    }
  }
}

function requireDocTerms(file, terms) {
  const text = read(file);
  for (const term of terms) {
    if (!text.includes(term)) {
      findings.push(`${file}:1 missing high-risk deployment contract term ${term}`);
    }
  }
}
