import { readdirSync, readFileSync } from "fs";
import { join, posix } from "path";
import { helpText } from "../../src/cli";
import { B2_OAUTH_SCOPES, OAUTH_ENVIRONMENT_VARIABLES } from "../../src/oauth-resource-server";
import { readJson, root } from "./support";

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function envNames(text: string): string[] {
  return [...new Set([...text.matchAll(/\bB2_[A-Z0-9_]+\b/g)].map((match) => match[0]).sort())];
}

function walkFiles(relativeDir: string, predicate: (relativePath: string) => boolean): string[] {
  return readdirSync(join(root, relativeDir), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(relativeDir, entry.name);
    if (entry.isDirectory()) return walkFiles(relativePath, predicate);
    return predicate(relativePath) ? [relativePath] : [];
  });
}

function markdownFiles(): string[] {
  return [
    "README.md",
    "CONTRIBUTING.md",
    "RELEASE.md",
    "SECURITY.md",
    ...walkFiles("docs", (relativePath) => relativePath.endsWith(".md")),
  ].sort();
}

function sourceFiles(): string[] {
  return walkFiles("src", (relativePath) => relativePath.endsWith(".ts")).sort();
}

function designDocRows(indexText: string): Array<{ documentPath: string; owner: string }> {
  const rows = [];
  for (const line of indexText.split(/\r?\n/)) {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2) continue;
    const linkTarget = cells[0].match(/\]\(([^)]+)\)/)?.[1];
    if (!linkTarget) continue;
    rows.push({
      documentPath: posix.normalize(posix.join("docs/design-docs", linkTarget)),
      owner: cells[1],
    });
  }
  return rows;
}

function codeownerEntries(codeownersText: string): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  for (const rawLine of codeownersText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    entries.set(pattern, owners);
  }
  return entries;
}

function runtimeEnvNamesFromSource(): string[] {
  const names = new Set<string>(Object.values(OAUTH_ENVIRONMENT_VARIABLES));
  const dynamicCredentialNames = [
    "B2_APPLICATION_KEY_ID",
    "B2_APPLICATION_KEY",
    "B2_APP_KEY_ID",
    "B2_APP_KEY",
    "B2_MASTER_KEY_ID",
    "B2_MASTER_KEY",
  ];
  for (const name of dynamicCredentialNames) names.add(name);

  const directReadPatterns = [
    /\b(?:process\.)?env\.(B2_[A-Z0-9_]+)\b/g,
    /\b(?:process\.)?env\[['"](B2_[A-Z0-9_]+)['"]\]/g,
    /\b(?:intEnv|envInt|csvEnv)\(['"](B2_[A-Z0-9_]+)['"]/g,
    /\b[A-Z0-9_]+_ENV\s*=\s*['"](B2_[A-Z0-9_]+)['"]/g,
  ];

  for (const file of sourceFiles()) {
    const source = read(file);
    for (const pattern of directReadPatterns) {
      for (const match of source.matchAll(pattern)) {
        const name = match[1];
        if (name) names.add(name);
      }
    }
  }

  const internalNames = new Set([
    // Constant of supported OAuth scopes, not an environment variable.
    "B2_OAUTH_SCOPES",
    // Secret sanitizer canary pattern, not operator configuration.
    "B2_MCP_CANARY_SECRET_",
  ]);

  return [...names].filter((name) => !internalNames.has(name)).sort();
}

describe("public support and authentication claims", () => {
  const readme = read("README.md");
  const clients = read("docs/product-specs/clients.md");
  const contributing = read("CONTRIBUTING.md");
  const authentication = read("docs/AUTHENTICATION.md");
  const release = read("RELEASE.md");
  const security = read("SECURITY.md");
  const docsReadme = read("docs/README.md");
  const designDocsIndex = read("docs/design-docs/index.md");
  const codeowners = read(".github/CODEOWNERS");
  const publicMarkdown = markdownFiles().map(read).join("\n");
  const packageJson = readJson<{
    bin: Record<string, string>;
    files: string[];
    name: string;
    scripts: Record<string, string>;
  }>("package.json");

  it("keeps package and binary naming claims canonical", () => {
    expect(packageJson.name).toBe("@backblaze-labs/b2-mcp");
    expect(packageJson.bin).toEqual({
      "b2-mcp": "dist/index.js",
      "b2-mcp-server": "dist/index.js",
    });
    expect(packageJson.files).toContain("docs/AUTHENTICATION.md");
    expect(docsReadme).toContain("[`AUTHENTICATION.md`](AUTHENTICATION.md)");
    expect(designDocsIndex).toContain("[`tool-contract.md`](tool-contract.md)");

    expect(publicMarkdown).not.toContain("@backblaze/b2-mcp-server");
    expect(readme).toContain("The canonical package name is `@backblaze-labs/b2-mcp`");
    expect(readme).toContain("binary is `b2-mcp`");
    expect(clients).toContain("The canonical npm package binary is `b2-mcp`");
    expect(release).toContain("The canonical installable binary is `b2-mcp`");
  });

  it("requires explicit QK CODEOWNERS for security-governance docs", () => {
    const qkOwnedDocs = designDocRows(designDocsIndex)
      .filter(({ owner }) => /(?:Sophie|QK|Security)/i.test(owner))
      .map(({ documentPath }) => documentPath);
    const requiredDocs = [...new Set(["docs/SECURITY.md", ...qkOwnedDocs])];
    const entries = codeownerEntries(codeowners);

    for (const documentPath of requiredDocs) {
      expect(entries.get(documentPath), `${documentPath} needs explicit QK ownership`).toContain(
        "@sophiecarreras",
      );
    }
  });

  it("presents npx as the documented quick start for the package", () => {
    expect([readme, clients].join("\n")).not.toContain("as of 2026-08-18");
    expect(readme).toContain('"command": "npx"');
    expect(readme).toContain("npx -y @backblaze-labs/b2-mcp");
    expect(clients).toContain('"command": "npx"');
    expect(clients).toContain("@backblaze-labs/b2-mcp");
  });

  it("keeps CONTRIBUTING pnpm run references backed by package scripts", () => {
    const citedScripts = [
      ...new Set([...contributing.matchAll(/`pnpm run ([a-z0-9:.-]+)`/g)].map((match) => match[1])),
    ].sort();
    const missing = citedScripts.filter((script) => !packageJson.scripts[script]);

    expect(citedScripts.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
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
      read("docs/references/deployment/security-and-credentials.md"),
    ].join("\n");
    const missing = envNames(localEnv).filter((name) => {
      if (name.startsWith("B2_CREDENTIAL_")) return !referenceDocs.includes("B2_CREDENTIAL_<REF>");
      return !referenceDocs.includes(name);
    });

    expect(missing).toEqual([]);
  });

  it("documents every runtime B2 environment variable read by src", () => {
    const referenceDocs = [
      readme,
      authentication,
      read("docs/DEPLOY.md"),
      read("docs/references/deployment/security-and-credentials.md"),
    ].join("\n");
    const missing = runtimeEnvNamesFromSource().filter((name) => {
      if (name.startsWith("B2_CREDENTIAL_")) return !referenceDocs.includes("B2_CREDENTIAL_<REF>");
      return !referenceDocs.includes(name);
    });

    expect(missing).toEqual([]);
  });

  it("documents every OAuth environment variable read by the resource server", () => {
    const documentedEnv = envNames(authentication);
    const sourceEnv = [...new Set(Object.values(OAUTH_ENVIRONMENT_VARIABLES))].sort();
    const missing = sourceEnv.filter((name) => !documentedEnv.includes(name));

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
      "run only when a reviewed out-of-band secret sink",
      "no provider-side recovery path",
      "Presigned S3 URLs are different",
      "`B2_DESTRUCTIVE_POLICY=confirm` is defense in depth, not authorization",
      "Replacing an unversioned object",
      "Roots, Sampling, MCP Logging, Dynamic Client Registration, HTTP+SSE",
    ]) {
      expect(authentication).toContain(required);
    }
    expect(authentication).toContain("inline mode");
    for (const required of [
      "b2_create_key",
      "b2_create_group_member",
      "b2_reserve_trial_create_account",
    ]) {
      expect(security).toContain(required);
    }
    expect(readme).toContain("Under stdio's default `confirm` policy");
    expect(readme).toContain("HTTP defaults to `block`");
    expect(publicMarkdown).not.toContain("SDK Partner binding deferred");
    expect(publicMarkdown).not.toMatch(
      /\| `(?:b2_create_group_member|b2_reserve_trial_create_account)`\s+\|\s+`defer`/,
    );
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
