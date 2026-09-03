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

  it("rejects mutable client JSON package versions", () => {
    const readme = read("README.md").replace(
      '"args": ["-y", "@backblaze-labs/b2-mcp@0.2.0"]',
      '"args": ["-y", "@backblaze-labs/b2-mcp@^0.2.0"]',
    );
    const expectedLine = lineOf(readme, '```json\n   {\n     "command": "npx",');
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("client config package version must be exact semver");
  });

  it("rejects the pinned client JSON config when its version is removed", () => {
    const readme = read("README.md").replace(
      '"args": ["-y", "@backblaze-labs/b2-mcp@0.2.0"]',
      '"args": ["-y", "@backblaze-labs/b2-mcp"]',
    );
    const expectedLine = lineOf(readme, '```json\n   {\n     "command": "npx",');
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("must pin an exact package version");
  });

  it("rejects the global binary fence when it is not a package binary", () => {
    const readme = read("README.md").replace('"command": "b2-mcp"', '"command": "b2-mcp-old"');
    const expectedLine = lineOf(readme, '```json\n   {\n     "command": "b2-mcp-old"');
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("global binary client command b2-mcp-old");
  });

  it.each(["node", "/tmp/b2-mcp-old"])(
    "rejects the global binary fence drifting to %s",
    (command) => {
      const readme = read("README.md").replace(
        '"command": "b2-mcp"',
        `"command": ${JSON.stringify(command)}`,
      );
      const expectedLine = lineOf(
        readme,
        `\`\`\`json\n   {\n     "command": ${JSON.stringify(command)}`,
      );
      const result = runDocExamplesWithOverrides({ "README.md": readme });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`README.md:${expectedLine}`);
      expect(result.stderr).toContain(`global binary client command ${command}`);
    },
  );

  it("rejects the global binary fence when its launch command is removed", () => {
    const readme = read("README.md").replace('"command": "b2-mcp"', '"note": "b2-mcp"');
    const expectedLine = lineOf(readme, '```json\n   {\n     "note": "b2-mcp"');
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("strict client config fence must declare a launch command");
  });

  it("rejects the pinned client fence when its launch command is removed", () => {
    const readme = read("README.md").replace(
      '"command": "npx",\n     "args": ["-y", "@backblaze-labs/b2-mcp@0.2.0"]',
      '"note": "removed"',
    );
    const expectedLine = lineOf(readme, '```json\n   {\n     "note": "removed"');
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("strict client config fence must declare a launch command");
  });

  it.each(["b2-mcp", "node"])(
    "rejects the pinned client fence launching via %s instead of a package manager",
    (command) => {
      const readme = read("README.md").replace(
        '"command": "npx",\n     "args": ["-y", "@backblaze-labs/b2-mcp@0.2.0"]',
        `"command": ${JSON.stringify(command)}`,
      );
      const expectedLine = lineOf(
        readme,
        `\`\`\`json\n   {\n     "command": ${JSON.stringify(command)}`,
      );
      const result = runDocExamplesWithOverrides({ "README.md": readme });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`README.md:${expectedLine}`);
      expect(result.stderr).toContain(
        `pinned client config must launch via npx/npm/pnpm to pin a version, got ${command}`,
      );
    },
  );

  it("rejects an npx launcher with an extra option before a drifting package", () => {
    const readme = read("README.md").replace(
      "npx -y @backblaze-labs/b2-mcp@0.2.0 --version",
      "npx --yes --offline @attacker/b2-mcp@0.2.0 --version",
    );
    const expectedLine = lineOf(readme, "npx --yes --offline @attacker/b2-mcp@0.2.0 --version");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("references package @attacker/b2-mcp@0.2.0");
  });

  it("rejects a global npm install with the global flag before the subcommand", () => {
    const readme = read("README.md").replace(
      "npm install -g @backblaze-labs/b2-mcp@0.2.0",
      "npm --global install @attacker/b2-mcp@0.2.0",
    );
    const expectedLine = lineOf(readme, "npm --global install @attacker/b2-mcp@0.2.0");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("global npm install examples must install");
  });

  it("rejects an npx launcher whose separated option value precedes a drift", () => {
    const readme = read("README.md").replace(
      "npx -y @backblaze-labs/b2-mcp@0.2.0 --version",
      "npx --cache /tmp @attacker/b2-mcp@0.2.0 --version",
    );
    const expectedLine = lineOf(readme, "npx --cache /tmp @attacker/b2-mcp@0.2.0 --version");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("references package @attacker/b2-mcp@0.2.0");
  });

  it("rejects a global npm add alias that drifts to another package", () => {
    const readme = read("README.md").replace(
      "npm install -g @backblaze-labs/b2-mcp@0.2.0",
      "npm add -g @attacker/b2-mcp@latest",
    );
    const expectedLine = lineOf(readme, "npm add -g @attacker/b2-mcp@latest");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("global npm install examples must install");
  });

  it.each(["--location=global", "--location global"])(
    "rejects a global npm install using %s",
    (locationFlag) => {
      const command = `npm install ${locationFlag} @attacker/b2-mcp@latest`;
      const readme = read("README.md").replace(
        "npm install -g @backblaze-labs/b2-mcp@0.2.0",
        command,
      );
      const expectedLine = lineOf(readme, command);
      const result = runDocExamplesWithOverrides({ "README.md": readme });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`README.md:${expectedLine}`);
      expect(result.stderr).toContain("global npm install examples must install");
    },
  );

  it("rejects a global npm install with a value option before the subcommand", () => {
    const command = "npm --loglevel warn install -g @attacker/b2-mcp@0.2.0";
    const readme = read("README.md").replace(
      "npm install -g @backblaze-labs/b2-mcp@0.2.0",
      command,
    );
    const expectedLine = lineOf(readme, command);
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("global npm install examples must install");
  });

  it("rejects a global npm install using an install abbreviation", () => {
    const command = "npm in -g @attacker/b2-mcp@0.2.0";
    const readme = read("README.md").replace(
      "npm install -g @backblaze-labs/b2-mcp@0.2.0",
      command,
    );
    const expectedLine = lineOf(readme, command);
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("global npm install examples must install");
  });

  it("rejects a global npm install using --global=true", () => {
    const command = "npm install --global=true @attacker/b2-mcp@0.2.0";
    const readme = read("README.md").replace(
      "npm install -g @backblaze-labs/b2-mcp@0.2.0",
      command,
    );
    const expectedLine = lineOf(readme, command);
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("global npm install examples must install");
  });

  it("rejects a repeated npx --package that drifts to another package", () => {
    const command =
      "npx --package=@backblaze-labs/b2-mcp@0.2.0 --package=@attacker/b2-mcp@0.2.0 b2-mcp --version";
    const readme = read("README.md").replace(
      "npx -y @backblaze-labs/b2-mcp@0.2.0 --version",
      command,
    );
    const expectedLine = lineOf(readme, command);
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("references package @attacker/b2-mcp@0.2.0");
  });

  it("rejects a mutable npm exec with a value option before the subcommand", () => {
    const command = "npm --loglevel warn exec @backblaze-labs/b2-mcp@latest";
    const readme = read("README.md").replace(
      "npm install -g @backblaze-labs/b2-mcp@0.2.0",
      command,
    );
    const expectedLine = lineOf(readme, command);
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("must not execute mutable-versioned package examples");
  });

  it("rejects an npx --yes long-form launcher that drifts to another package", () => {
    const readme = read("README.md").replace(
      "npx -y @backblaze-labs/b2-mcp@0.2.0 --version",
      "npx --yes @attacker/b2-mcp@0.2.0 --version",
    );
    const expectedLine = lineOf(readme, "npx --yes @attacker/b2-mcp@0.2.0 --version");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("references package @attacker/b2-mcp@0.2.0");
  });

  it("rejects an unscoped npx launcher that drifts from the scoped package", () => {
    const readme = read("README.md").replace(
      "npx -y @backblaze-labs/b2-mcp@0.2.0 --version",
      "npx -y b2-mcp@0.2.0 --version",
    );
    const expectedLine = lineOf(readme, "npx -y b2-mcp@0.2.0 --version");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("references package b2-mcp@0.2.0");
  });

  it("rejects a global npm install with a valid operand plus an extra URL operand", () => {
    const command = "npm install -g @backblaze-labs/b2-mcp@0.2.0 https://example.invalid/other.tgz";
    const readme = read("README.md").replace(
      "npm install -g @backblaze-labs/b2-mcp@0.2.0",
      command,
    );
    const expectedLine = lineOf(readme, command);
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("global npm install examples must install");
  });

  it.each(["latest", "next", "^0.2.0", "0.x"])(
    "rejects executable mutable spec @%s in release docs",
    (version) => {
      const command = `npx -y @backblaze-labs/b2-mcp@${version} --version`;
      const readme = read("README.md").replace(
        "npx -y @backblaze-labs/b2-mcp@0.2.0 --version",
        command,
      );
      const expectedLine = lineOf(readme, command);
      const result = runDocExamplesWithOverrides({ "README.md": readme });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`README.md:${expectedLine}`);
      expect(result.stderr).toContain("must not execute mutable-versioned package examples");
    },
  );

  it("rejects a backslash-continued executable mutable spec across lines", () => {
    const readme = read("README.md").replace(
      "npx -y @backblaze-labs/b2-mcp@0.2.0 --version",
      "npx -y \\\n@backblaze-labs/b2-mcp@latest --version",
    );
    const expectedLine = lineOf(readme, "npx -y \\");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("must not execute mutable-versioned package examples");
  });

  it("rejects a backslash-continued npx package-name drift across lines", () => {
    const readme = read("README.md").replace(
      "npx -y @backblaze-labs/b2-mcp@0.2.0 --version",
      "npx -y \\\n@attacker/b2-mcp@0.2.0 --version",
    );
    const expectedLine = lineOf(readme, "npx -y \\");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("references package @attacker/b2-mcp@0.2.0");
  });

  it("rejects a backslash-continued global npm install that drifts to another package", () => {
    const readme = read("README.md").replace(
      "npm install -g @backblaze-labs/b2-mcp@0.2.0",
      "npm install -g \\\n@attacker/b2-mcp@0.2.0",
    );
    const expectedLine = lineOf(readme, "npm install -g \\");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("global npm install examples must install");
  });

  it("rejects executable @latest after global npm install on the same line", () => {
    const command =
      "npm install -g @backblaze-labs/b2-mcp@0.2.0 && npx -y @backblaze-labs/b2-mcp@latest --version";
    const readme = read("README.md").replace(
      "npm install -g @backblaze-labs/b2-mcp@0.2.0",
      command,
    );
    const expectedLine = lineOf(readme, command);
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("must not execute mutable-versioned package examples");
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

  it("rejects a global npm install with no parseable package operand", () => {
    const readme = read("README.md").replace(
      "npm install -g @backblaze-labs/b2-mcp@0.2.0",
      "npm install -g",
    );
    const expectedLine = lineOf(readme, "npm install -g");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("must install a pinned");
  });

  it("rejects a valid global install chained before one with no operand", () => {
    const command = "npm install -g @backblaze-labs/b2-mcp@0.2.0 && npm install -g";
    const readme = read("README.md").replace(
      "npm install -g @backblaze-labs/b2-mcp@0.2.0",
      command,
    );
    const expectedLine = lineOf(readme, command);
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("must install a pinned");
  });

  it("rejects unscoped global npm install package operands", () => {
    const readme = read("README.md").replace(
      "npm install -g @backblaze-labs/b2-mcp@0.2.0",
      "npm install -g b2-mcp@0.2.0",
    );
    const expectedLine = lineOf(readme, "npm install -g b2-mcp@0.2.0");
    const result = runDocExamplesWithOverrides({ "README.md": readme });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`README.md:${expectedLine}`);
    expect(result.stderr).toContain("global npm install examples must install");
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

  it("rejects a chained second global npm install that drifts to another package", () => {
    // Regression: the validator only inspected the first `npm install` segment,
    // so a second `&&`-chained global install of another package slipped past.
    const readme = read("README.md").replace(
      "npm install -g @backblaze-labs/b2-mcp@0.2.0",
      "npm install -g @backblaze-labs/b2-mcp@0.2.0 && npm install -g @attacker/b2-mcp@0.2.0",
    );
    const expectedLine = lineOf(
      readme,
      "npm install -g @backblaze-labs/b2-mcp@0.2.0 && npm install -g @attacker/b2-mcp@0.2.0",
    );
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

  it.each(["mcp*.log", "mcp-server-*.log"])(
    "rejects broad MCP log wildcard %s without adjacent redaction guidance",
    (pattern) => {
      const redactionText =
        "Before sharing any log excerpt, redact B2 key IDs and secrets, Authorization\n" +
        "headers, bearer tokens, presigned URLs, webhook secrets, and any other local\n" +
        "credentials.\n\n";
      const readme = read("README.md")
        .replace(redactionText, "")
        .replace(
          "tail -n 20 -F ~/Library/Logs/Claude/mcp-server-backblaze-b2.log",
          `tail -n 20 -F ~/Library/Logs/Claude/${pattern}`,
        );
      const expectedLine = lineOf(readme, `tail -n 20 -F ~/Library/Logs/Claude/${pattern}`);
      const result = runDocExamplesWithOverrides({ "README.md": readme });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`README.md:${expectedLine}`);
      expect(result.stderr).toContain("broad MCP log wildcard examples");
    },
  );

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
