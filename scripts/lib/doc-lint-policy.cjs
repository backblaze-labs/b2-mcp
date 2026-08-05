const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { sanitizedEnv, secretNamePattern } = require("./sanitized-env.cjs");

const docLintAllowedSecretLikeEnvNames = new Set(["B2_MCP_DOC_LINT_LOCKDOWN"]);

function isSecretLikeEnvName(name) {
  return secretNamePattern.test(name) && !docLintAllowedSecretLikeEnvNames.has(name);
}

function secretLikeEnvNames(env) {
  return Object.keys(env).filter(isSecretLikeEnvName).sort();
}

function docLintNodeOptions(lockdownPath) {
  return `--import=${pathToFileURL(lockdownPath).href}`;
}

function buildDocLintEnv({ lockdownPath, sourceEnv = process.env }) {
  const env = sanitizedEnv(
    {
      B2_MCP_DOC_LINT_LOCKDOWN: "1",
      CI: sourceEnv.CI,
      NODE_OPTIONS: docLintNodeOptions(lockdownPath),
      NO_COLOR: "1",
    },
    {
      nonSecretEnvNames: ["B2_MCP_DOC_LINT_LOCKDOWN"],
      sourceEnv,
    },
  );

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === "") delete env[name];
  }

  return env;
}

function credentialFindingsFromGitConfigText(text) {
  const findings = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const lower = line.toLowerCase();
    if (lower.includes(".extraheader=") && lower.includes("authorization:")) {
      findings.push("local git config contains an authorization extraheader");
    }
    if (/https?:\/\/[^/\s]+@/i.test(line)) {
      findings.push("local git config contains a credentialed remote URL");
    }
    if (/(github_pat_|ghp_|x-access-token)/i.test(line)) {
      findings.push("local git config contains a GitHub token-like value");
    }
  }
  return [...new Set(findings)].sort();
}

function checkoutCredentialFindings(root) {
  const result = spawnSync("git", ["config", "--local", "--list", "--show-origin"], {
    cwd: root,
    encoding: "utf8",
    env: sanitizedEnv({}, { sourceEnv: process.env }),
  });

  if (result.error || result.status !== 0) return [];
  return credentialFindingsFromGitConfigText(String(result.stdout ?? ""));
}

module.exports = {
  buildDocLintEnv,
  checkoutCredentialFindings,
  credentialFindingsFromGitConfigText,
  docLintAllowedSecretLikeEnvNames,
  docLintNodeOptions,
  isSecretLikeEnvName,
  secretLikeEnvNames,
};
