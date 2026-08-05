import { readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { createRequire } from "module";

const root = join(__dirname, "../..");
const nodeRequire = createRequire(__filename);
const { buildDocLintEnv, credentialFindingsFromGitConfigText, secretLikeEnvNames } = nodeRequire(
  "../../scripts/lib/doc-lint-policy.cjs",
) as {
  buildDocLintEnv: (options: {
    lockdownPath: string;
    sourceEnv?: Record<string, string | undefined>;
  }) => Record<string, string>;
  credentialFindingsFromGitConfigText: (text: string) => string[];
  secretLikeEnvNames: (env: Record<string, string | undefined>) => string[];
};

const lockdownPath = join(root, "scripts", "doc-lint-lockdown.mjs");
const sentinel = "B2_MCP_DOC_LINT_SENTINEL";

function outputOf(result: ReturnType<typeof spawnSync>): string {
  return `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`;
}

describe("doc lint runner", () => {
  it("strips secret-like environment variables before loading ESLint plugins", () => {
    const env = buildDocLintEnv({
      lockdownPath,
      sourceEnv: {
        AWS_SECRET_ACCESS_KEY: sentinel,
        B2_APPLICATION_KEY: sentinel,
        GH_TOKEN: sentinel,
        GITHUB_ACTIONS: "true",
        GITHUB_TOKEN: sentinel,
        NODE_AUTH_TOKEN: sentinel,
        NODE_OPTIONS: "--require ./leak.js",
        NPM_TOKEN: sentinel,
        PATH: process.env.PATH,
      },
    });

    expect(secretLikeEnvNames(env)).toEqual([]);
    expect(env.B2_MCP_DOC_LINT_LOCKDOWN).toBe("1");
    expect(env.NODE_OPTIONS).toContain("doc-lint-lockdown.mjs");
    expect(JSON.stringify(env)).not.toContain(sentinel);
    expect(env.NODE_OPTIONS).not.toContain("leak.js");
    expect(env).not.toHaveProperty("GITHUB_ACTIONS");
  });

  it("blocks network and child-process APIs in the lint process", () => {
    const env = buildDocLintEnv({
      lockdownPath,
      sourceEnv: { PATH: process.env.PATH },
    });
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        [
          'const https = require("node:https");',
          'const child = require("node:child_process");',
          "let blocked = 0;",
          'for (const fn of [() => https.request("https://example.invalid"), () => child.spawnSync("node", ["-v"])]) {',
          "  try { fn(); } catch (err) { blocked++; console.error(err.message); }",
          "}",
          "process.exit(blocked === 2 ? 0 : 1);",
        ].join("\n"),
      ],
      { cwd: root, encoding: "utf8", env },
    );

    expect(result.status).toBe(0);
    expect(outputOf(result)).toContain("doc-lint lockdown blocked https.request network egress");
    expect(outputOf(result)).toContain("doc-lint lockdown blocked child_process.spawnSync");
  });

  it("detects checkout credentials that actions/checkout can persist", () => {
    expect(
      credentialFindingsFromGitConfigText(
        [
          "file:.git/config\tremote.origin.url=https://github.com/backblaze-labs/b2-mcp.git",
          "file:.git/config\thttp.https://github.com/.extraheader=AUTHORIZATION: basic abc",
          "file:.git/config\tremote.bad.url=https://x-access-token:ghp_example@github.com/o/r.git",
        ].join("\n"),
      ),
    ).toEqual([
      "local git config contains a GitHub token-like value",
      "local git config contains a credentialed remote URL",
      "local git config contains an authorization extraheader",
    ]);

    expect(
      credentialFindingsFromGitConfigText(
        "file:.git/config\tremote.origin.url=https://github.com/backblaze-labs/b2-mcp.git",
      ),
    ).toEqual([]);
  });

  it("keeps package scripts on the locked-down docs lint wrapper", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts["lint:docs"]).toBe("node scripts/run-doc-lint.mjs");
    expect(pkg.scripts["lint:docs:fix"]).toBe("node scripts/run-doc-lint.mjs --fix");
  });

  it("keeps eslint.config.js limited to parser plus doc-comment plugins", () => {
    const config = readFileSync(join(root, "eslint.config.js"), "utf8");

    expect(config).toContain("parser: tseslint.parser");
    expect(config).toContain("eslint-plugin-jsdoc");
    expect(config).toContain("eslint-plugin-tsdoc");
    expect(config).not.toContain("disabledTypeScriptRules");
    expect(config).not.toContain('"@typescript-eslint": tseslint.plugin');
  });
});
