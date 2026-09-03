import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { root } from "./support";

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function runDocExamplesWithOverrides(overrides: Record<string, string>) {
  const tempDir = mkdtempSync(join(tmpdir(), "b2-mcp-doc-examples-"));
  const overridesPath = join(tempDir, "overrides.json");
  writeFileSync(overridesPath, JSON.stringify(overrides), "utf8");
  try {
    return spawnSync(process.execPath, ["scripts/check-doc-examples.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        B2_MCP_DOC_EXAMPLE_TEXT_OVERRIDES: overridesPath,
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("documentation example validator policy", () => {
  it("rejects client JSON configs that run an unexpected npx package", () => {
    const readme = read("README.md").replace(
      '"args": ["-y", "@backblaze-labs/b2-mcp"],',
      '"args": ["-y", "@attacker/b2-mcp"],',
    );
    const expectedLine = lineOf(readme, '```json\n{\n  "mcpServers"');
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("@attacker/b2-mcp");
  });

  it("rejects pinned client JSON configs that drift to another package", () => {
    const readme = read("README.md").replace(
      '"args": ["-y", "@backblaze-labs/b2-mcp@0.2.0"]',
      '"args": ["-y", "@attacker/b2-mcp@0.2.0"]',
    );
    const expectedLine = lineOf(readme, '```json\n   {\n     "command": "npx",');
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("@attacker/b2-mcp@0.2.0");
  });

  it("rejects direct client commands that are not package binaries", () => {
    const readme = read("README.md").replace('"command": "b2-mcp"', '"command": "b2-mcp-old"');
    const expectedLine = lineOf(readme, '```json\n   {\n     "command": "b2-mcp-old"');
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("direct client command b2-mcp-old");
  });

  it("rejects executable @latest package examples in release docs", () => {
    const readme = read("README.md").replace(
      "npx -y @backblaze-labs/b2-mcp@0.2.0 --version",
      "npx -y @backblaze-labs/b2-mcp@latest --version",
    );
    const expectedLine = lineOf(readme, "npx -y @backblaze-labs/b2-mcp@latest --version");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("must not execute @latest");
  });

  it("rejects unpinned global npm installs in release docs", () => {
    const readme = read("README.md").replace(
      "npm install -g @backblaze-labs/b2-mcp@0.2.0",
      "npm install -g @backblaze-labs/b2-mcp",
    );
    const expectedLine = lineOf(readme, "npm install -g @backblaze-labs/b2-mcp");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("global npm install examples");
  });

  it("rejects global npm installs that drift to another package", () => {
    const readme = read("README.md").replace(
      "npm install -g @backblaze-labs/b2-mcp@0.2.0",
      "npm install -g @attacker/b2-mcp@0.2.0",
    );
    const expectedLine = lineOf(readme, "npm install -g @attacker/b2-mcp@0.2.0");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("global npm install examples must install");
  });

  it.each(["next", "^0.2.0", "0.x"])(
    "rejects mutable global npm install spec @%s in release docs",
    (version) => {
      const command = `npm install -g @backblaze-labs/b2-mcp@${version}`;
      const readme = read("README.md").replace(
        "npm install -g @backblaze-labs/b2-mcp@0.2.0",
        command,
      );
      const expectedLine = lineOf(readme, command);
      const result = runDocExamplesWithOverrides({ "README.md": readme });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`README.md:${expectedLine}`);
      expect(result.stderr).toContain("must pin an exact version");
    },
  );

  it("rejects broad MCP log wildcards without adjacent redaction guidance", () => {
    const redactionText =
      "Before sharing any log excerpt, redact B2 key IDs and secrets, Authorization\n" +
      "headers, bearer tokens, presigned URLs, webhook secrets, and any other local\n" +
      "credentials.\n\n";
    const readme = read("README.md")
      .replace(redactionText, "")
      .replace(
        "tail -n 20 -F ~/Library/Logs/Claude/mcp-server-backblaze-b2.log",
        "tail -n 20 -F ~/Library/Logs/Claude/mcp*.log",
      );
    const expectedLine = lineOf(readme, "tail -n 20 -F ~/Library/Logs/Claude/mcp*.log");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("broad MCP log wildcard examples");
  });

  it.each([
    ["B2_HTTP_CREDENTIAL_MODE", "headers"],
    ["B2_DESTRUCTIVE_POLICY", "allow"],
    ["B2_REGISTER_ALL_TOOLS", "true"],
    ["B2_ALLOW_LOCAL_FILES", "true"],
    ["B2_SECRET_SINK", "inline"],
    ["B2_ALLOW_INLINE_SECRETS", "true"],
  ])("rejects unsafe %s values in deployment env examples", (name, unsafeValue) => {
    const envExample = read("deploy/vercel/vercel.env.example").replace(
      new RegExp(`^${name}=.*$`, "m"),
      `${name}=${unsafeValue}`,
    );
    const result = runDocExamplesWithOverrides({
      "deploy/vercel/vercel.env.example": envExample,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("deploy/vercel/vercel.env.example:1");
    expect(result.stderr).toContain(`${name} must be`);
  });

  it("rejects unsafe Docker-style env flags in documented shell examples", () => {
    const readme = read("README.md").replace(
      "-e B2_HTTP_CREDENTIAL_MODE=server",
      "-e B2_HTTP_CREDENTIAL_MODE=headers",
    );
    const expectedLine = lineOf(readme, "-e B2_HTTP_CREDENTIAL_MODE=headers");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("B2_HTTP_CREDENTIAL_MODE must be server");
  });

  it("rejects closing Markdown fences that carry an info string", () => {
    const readme = replaceLast(read("README.md"), "\n```\n", "\n```bash\n");
    const expectedLine = lineOf(readme, "```bash\npnpm run build");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("has an unclosed Markdown code fence");
  });

  it("rejects unsupported positional transports in Docker examples", () => {
    const readme = read("README.md").replace('"$B2_MCP_IMAGE" stdio', '"$B2_MCP_IMAGE" htp');
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("README.md:");
    expect(result.stderr).toContain("references unsupported positional transport htp");
  });

  it("rejects missing pnpm shorthand scripts in documented commands", () => {
    const readme = read("README.md").replace("pnpm test", "pnpm missing-script");
    const expectedLine = lineOf(readme, "pnpm missing-script");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("references missing package script missing-script");
  });
});

function lineOf(input: string, search: string): number {
  const index = input.indexOf(search);
  expect(index).toBeGreaterThanOrEqual(0);
  return input.slice(0, index).split(/\r?\n/).length;
}

function replaceLast(input: string, search: string, replacement: string): string {
  const index = input.lastIndexOf(search);
  expect(index).toBeGreaterThanOrEqual(0);
  return `${input.slice(0, index)}${replacement}${input.slice(index + search.length)}`;
}
