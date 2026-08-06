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

  it("blocks egress, listener, and child-process APIs in the lint process", () => {
    const env = buildDocLintEnv({
      lockdownPath,
      sourceEnv: { PATH: process.env.PATH },
    });
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        [
          "(async () => {",
          'const https = require("node:https");',
          'const http = require("node:http");',
          'const net = require("node:net");',
          'const tls = require("node:tls");',
          'const dns = require("node:dns");',
          'const dnsPromises = require("node:dns/promises");',
          'const inspector = require("node:inspector");',
          'const child = require("node:child_process");',
          "const blocked = [];",
          "async function expectBlocked(label, fn) {",
          "  try {",
          "    const value = fn();",
          '    if (value && typeof value.then === "function") await value;',
          "    console.error(`${label} was not blocked`);",
          "  } catch (err) {",
          "    const message = err && err.message ? err.message : String(err);",
          '    if (message.includes("doc-lint lockdown blocked")) {',
          "      blocked.push(label);",
          "      console.error(`${label}: ${message}`);",
          "      return;",
          "    }",
          "    console.error(`${label} failed without lockdown: ${message}`);",
          "  }",
          "}",
          'await expectBlocked("https.request", () => https.request("https://example.invalid"));',
          'await expectBlocked("net.Socket.connect", () => {',
          "  const socket = new net.Socket();",
          '  socket.on("error", () => {});',
          "  try {",
          '    return socket.connect({ host: "127.0.0.1", port: 9 });',
          "  } finally {",
          "    socket.destroy();",
          "  }",
          "});",
          'await expectBlocked("tls.TLSSocket", () => new tls.TLSSocket());',
          'await expectBlocked("http.ClientRequest", () => new http.ClientRequest("http://127.0.0.1:9"));',
          'await expectBlocked("http.Agent.createConnection", () =>',
          '  new http.Agent().createConnection({ host: "127.0.0.1", port: 9 }),',
          ");",
          'await expectBlocked("dns.promises.resolve4", () => dns.promises.resolve4("example.invalid"));',
          'await expectBlocked("dns/promises.resolve4", () => dnsPromises.resolve4("example.invalid"));',
          'await expectBlocked("inspector.open", () => inspector.open(0, "0.0.0.0"));',
          'await expectBlocked("child_process.spawnSync", () => child.spawnSync("node", ["-v"]));',
          "process.exit(blocked.length === 9 ? 0 : 1);",
          "})().catch((err) => { console.error(err); process.exit(1); });",
        ].join("\n"),
      ],
      { cwd: root, encoding: "utf8", env, timeout: 5000 },
    );

    expect(result.status).toBe(0);
    expect(outputOf(result)).toContain(
      "https.request: doc-lint lockdown blocked https.request network egress",
    );
    expect(outputOf(result)).toContain(
      "net.Socket.connect: doc-lint lockdown blocked net.Socket.connect network egress",
    );
    expect(outputOf(result)).toContain(
      "tls.TLSSocket: doc-lint lockdown blocked tls.TLSSocket network egress",
    );
    expect(outputOf(result)).toContain(
      "http.ClientRequest: doc-lint lockdown blocked http.ClientRequest network egress",
    );
    expect(outputOf(result)).toContain(
      "http.Agent.createConnection: doc-lint lockdown blocked http.Agent.createConnection network egress",
    );
    expect(outputOf(result)).toContain("dns.promises.resolve4: doc-lint lockdown blocked");
    expect(outputOf(result)).toContain("dns/promises.resolve4: doc-lint lockdown blocked");
    expect(outputOf(result)).toContain(
      "inspector.open: doc-lint lockdown blocked inspector.open listener",
    );
    expect(outputOf(result)).toContain(
      "child_process.spawnSync: doc-lint lockdown blocked child_process.spawnSync",
    );
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
    expect(pkg.scripts["lint:links"]).toBe("node scripts/check-doc-links.mjs");
  });

  it("keeps eslint.config.js limited to parser plus doc-comment plugins", () => {
    type FlatConfig = {
      files?: string[];
      plugins?: Record<string, unknown>;
      languageOptions?: { parser?: unknown };
      rules?: Record<string, unknown>;
    };
    const config = nodeRequire(join(root, "eslint.config.js")) as FlatConfig[];
    const tseslint = nodeRequire("typescript-eslint") as { parser: unknown };
    const docConfig = config.find((entry) => entry.files?.includes("src/**/*.ts"));

    expect(docConfig).toBeDefined();
    expect(docConfig?.languageOptions?.parser).toBe(tseslint.parser);
    expect(Object.keys(docConfig?.plugins ?? {}).sort()).toEqual(["jsdoc", "tsdoc"]);
    expect(
      Object.keys(docConfig?.rules ?? {}).some((ruleName) =>
        ruleName.startsWith("@typescript-eslint/"),
      ),
    ).toBe(false);
  });
});
