import { readFileSync } from "fs";
import { join } from "path";
import { helpText } from "../../src/cli";
import { B2_OAUTH_SCOPES } from "../../src/oauth-resource-server";
import { readJson, root } from "./support";

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function envNames(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/\bB2_[A-Z0-9_]+\b/g)]
        .map((match) => match[0])
        .filter((name) => name !== "B2_OAUTH_SCOPES")
        .sort(),
    ),
  ];
}

function markdownFiles(): string[] {
  return [
    "README.md",
    "CONTRIBUTING.md",
    "RELEASE.md",
    "SECURITY.md",
    "docs/AUTHENTICATION.md",
    "docs/ARCHITECTURE.md",
    "docs/CLIENTS.md",
    "docs/DEPLOY.md",
    "docs/PUBLIC_CONTRACTS.md",
    "docs/TESTING.md",
    "docs/TOOL_CONTRACT.md",
    "docs/TOOL_PROFILES.md",
    "docs/V1_SCOPE.md",
    "docs/deployment/security-and-credentials.md",
  ];
}

describe("public support and authentication claims", () => {
  const readme = read("README.md");
  const clients = read("docs/CLIENTS.md");
  const authentication = read("docs/AUTHENTICATION.md");
  const release = read("RELEASE.md");
  const security = read("SECURITY.md");
  const publicContracts = read("docs/PUBLIC_CONTRACTS.md");
  const packageJson = readJson<{
    bin: Record<string, string>;
    files: string[];
    name: string;
  }>("package.json");

  it("keeps package and binary naming claims canonical", () => {
    expect(packageJson.name).toBe("@backblaze-labs/b2-mcp");
    expect(packageJson.bin).toEqual({
      "b2-mcp": "dist/index.js",
      "b2-mcp-server": "dist/index.js",
    });
    expect(packageJson.files).toContain("docs/AUTHENTICATION.md");
    expect(publicContracts).toContain("[`AUTHENTICATION.md`](AUTHENTICATION.md)");

    const publicMarkdown = markdownFiles().map(read).join("\n");
    expect(publicMarkdown).not.toContain("@backblaze/b2-mcp-server");
    expect(readme).toContain("The canonical package name is `@backblaze-labs/b2-mcp`");
    expect(readme).toContain("binary is `b2-mcp`");
    expect(clients).toContain("The canonical npm package binary is `b2-mcp`");
    expect(release).toContain("The canonical installable binary is `b2-mcp`");
  });

  it("does not present the unpublished npm package as an active quick start", () => {
    for (const line of [readme, clients, release]
      .join("\n")
      .split(/\r?\n/)
      .filter((candidate) => candidate.includes("npx @backblaze-labs/b2-mcp"))) {
      expect(line).toMatch(/do not use|does not advertise|Do not advertise/);
    }
  });

  it("keeps the checked-in CLI reference aligned with source help", () => {
    const referenceLines = helpText()
      .split("\n")
      .filter((line) => line.startsWith("Usage:") || line.trimStart().startsWith("--"))
      .map((line) => line.trimEnd());

    for (const line of referenceLines) {
      expect(readme).toContain(line);
    }
  });

  it("documents local environment variables from the checked-in example", () => {
    const localEnv = read(".env.example");
    const referenceDocs = [
      readme,
      authentication,
      read("docs/DEPLOY.md"),
      read("docs/deployment/security-and-credentials.md"),
    ].join("\n");
    const missing = envNames(localEnv).filter((name) => {
      if (name.startsWith("B2_CREDENTIAL_")) return !referenceDocs.includes("B2_CREDENTIAL_<REF>");
      return !referenceDocs.includes(name);
    });

    expect(missing).toEqual([]);
  });

  it("documents every OAuth environment variable read by the resource server", () => {
    const sourceEnv = envNames(read("src/oauth-resource-server.ts")).filter(
      (name) =>
        name.startsWith("B2_OAUTH_") ||
        name === "B2_MCP_PUBLIC_URL" ||
        name === "B2_MCP_SERVICE_DOCUMENTATION_URL",
    );
    const missing = sourceEnv.filter((name) => !authentication.includes(name));

    expect(missing).toEqual([]);
  });

  it("documents the implemented OAuth boundary and supported scopes", () => {
    for (const required of [
      "MCP OAuth Resource Server",
      "Protected Resource Metadata",
      "Client ID Metadata Documents",
      "Dynamic Client Registration",
      "B2_OAUTH_RESOURCE",
      "B2_OAUTH_AUDIENCE",
      "B2_OAUTH_ISSUER",
      "insufficient-scope challenge",
      "verified MCP `authInfo`",
      "resource-server layer",
    ]) {
      expect(authentication).toContain(required);
    }
    for (const scope of B2_OAUTH_SCOPES) {
      expect(authentication).toContain(scope);
    }
  });

  it("documents secret, destructive-action, overwrite, and omitted-protocol claims", () => {
    for (const required of [
      "non-secret unavailable compatibility stubs",
      "Issue #186 will revise this invariant",
      "Presigned S3 URLs are different",
      "`B2_DESTRUCTIVE_POLICY=confirm` is defense in depth, not authorization",
      "Replacing an unversioned object",
      "Roots, Sampling, MCP Logging, Dynamic Client Registration, HTTP+SSE",
    ]) {
      expect(authentication).toContain(required);
    }
  });

  it("keeps support policy split between SECURITY and RELEASE", () => {
    expect(security).toContain("The latest minor release line on `main` is supported");
    expect(security).toContain("GitHub Security Advisories");
    expect(security).toContain("security@backblaze.com");
    expect(release).toContain("## Package And Release Support Policy");
    expect(release).toContain("Only the latest minor release line on `main` receives fixes");
    expect(release).toContain("protected tag-driven workflow");
  });
});
