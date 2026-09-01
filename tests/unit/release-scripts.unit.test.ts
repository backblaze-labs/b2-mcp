import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const root = join(__dirname, "../..");

type RegistryMetadataModule = {
  verifyNpmRegistryMetadata: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  isRetryableNpmViewFailure: (result: {
    status: number | null;
    stdout?: string;
    stderr?: string;
  }) => boolean;
  parseRegistryMetadata: (raw: unknown) => Record<string, unknown>;
  leakedRegistryMetadataKeys: (metadata: unknown) => string[];
};

type McpRegistryPublishModule = {
  publishMcpRegistry: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  isTransientMcpPublisherFailure: (result: {
    signal?: string | null;
    stderr?: string;
    stdout?: string;
    timedOut?: boolean;
  }) => boolean;
};

type McpRegistryManifest = Record<string, any>;
type McpPublisherRun = {
  args: string[];
  publisherPath?: string;
  timeoutMs?: number;
};

async function registryMetadataModule(): Promise<RegistryMetadataModule> {
  return (await import(
    "../../scripts/verify-npm-registry-metadata.mjs"
  )) as unknown as RegistryMetadataModule;
}

async function mcpRegistryPublishModule(): Promise<McpRegistryPublishModule> {
  return (await import(
    "../../scripts/mcp-registry-publish.mjs"
  )) as unknown as McpRegistryPublishModule;
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function withFixture(run: (fixtureRoot: string) => void): void {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "b2-mcp-release-scripts-"));
  try {
    mkdirSync(join(fixtureRoot, "docs"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "package.json"),
      JSON.stringify(
        {
          name: "@backblaze-labs/b2-mcp",
          version: "0.1.0",
          mcpName: "io.github.backblaze-labs/b2-mcp",
          license: "MIT",
          repository: {
            type: "git",
            url: "git+https://github.com/backblaze-labs/b2-mcp.git",
          },
          bugs: { url: "https://github.com/backblaze-labs/b2-mcp/issues" },
          homepage: "https://github.com/backblaze-labs/b2-mcp#readme",
          engines: { node: "^22.3.0 || ^24 || ^26" },
          bin: { "b2-mcp": "dist/index.js", "b2-mcp-server": "dist/index.js" },
          files: [
            "dist/**/*",
            "docs/AUTHENTICATION.md",
            "docs/CLIENTS.md",
            "docs/DEPLOY.md",
            "docs/tool-profile-contract.json",
            "docs/TOOL_PROFILES.md",
            "README.md",
            "CHANGELOG.md",
            "SECURITY.md",
            "LICENSE",
          ],
          dependencies: { "@backblaze-labs/b2-sdk": "0.2.0" },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(fixtureRoot, "server.json"),
      JSON.stringify(
        {
          $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
          name: "io.github.backblaze-labs/b2-mcp",
          title: "Backblaze B2 MCP Server",
          description:
            "Operate Backblaze B2 buckets, files, keys, Object Lock, and S3-compatible storage.",
          websiteUrl: "https://github.com/backblaze-labs/b2-mcp#readme",
          repository: {
            url: "https://github.com/backblaze-labs/b2-mcp",
            source: "github",
            id: "1241092911",
          },
          version: "0.1.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@backblaze-labs/b2-mcp",
              version: "0.1.0",
              transport: { type: "stdio" },
              environmentVariables: [
                {
                  description:
                    "Backblaze B2 application key ID for native B2 and S3-compatible tools.",
                  isRequired: true,
                  format: "string",
                  isSecret: true,
                  name: "B2_APPLICATION_KEY_ID",
                },
                {
                  description: "Backblaze B2 application key secret.",
                  isRequired: true,
                  format: "string",
                  isSecret: true,
                  name: "B2_APPLICATION_KEY",
                },
                {
                  description: "Optional fallback S3-compatible region used before authorization.",
                  isRequired: false,
                  format: "string",
                  isSecret: false,
                  placeholder: "us-east-005",
                  name: "B2_REGION",
                },
                {
                  description: "Optional master key ID for Partner/Groups API tools.",
                  isRequired: false,
                  format: "string",
                  isSecret: true,
                  name: "B2_MASTER_KEY_ID",
                },
                {
                  description: "Optional master key secret for Partner/Groups API tools.",
                  isRequired: false,
                  format: "string",
                  isSecret: true,
                  name: "B2_MASTER_KEY",
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(fixtureRoot, "CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "### Added",
        "- Future change.",
        "",
        "## [0.1.0] - 2026-08-07",
        "",
        "### Added",
        "- Initial public package.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(fixtureRoot, "runtime-policy.json"),
      JSON.stringify({ engineRange: "^22.3.0 || ^24 || ^26" }, null, 2),
    );
    run(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function scriptEnv(fixtureRoot: string): NodeJS.ProcessEnv {
  return { ...process.env, NODE_ENV: "test", B2_MCP_RELEASE_ROOT: fixtureRoot };
}

function readFixtureServerJson(fixtureRoot: string): Record<string, any> {
  return JSON.parse(readFileSync(join(fixtureRoot, "server.json"), "utf8"));
}

function writeFixtureServerJson(fixtureRoot: string, manifest: Record<string, any>): void {
  writeFileSync(join(fixtureRoot, "server.json"), JSON.stringify(manifest, null, 2));
}

async function withTempManifest(
  mutate: (manifest: McpRegistryManifest) => void,
  run: (manifestPath: string, manifest: McpRegistryManifest) => Promise<void>,
): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "b2-mcp-mcp-registry-"));
  try {
    const manifest = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
    mutate(manifest);
    const manifestPath = join(fixtureRoot, "server.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    await run(manifestPath, manifest);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function quietLog() {
  return { log: () => undefined, warn: () => undefined };
}

describe("release scripts", () => {
  it("extracts release notes from the matching changelog version section", () => {
    withFixture((fixtureRoot) => {
      const output = join(fixtureRoot, "release-notes.md");
      const result = spawnSync(
        process.execPath,
        ["scripts/extract-release-notes.mjs", "--version", "0.1.0", "--output", output],
        { cwd: root, env: scriptEnv(fixtureRoot), encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(output, "utf8")).toContain("# @backblaze-labs/b2-mcp v0.1.0");
      expect(readFileSync(output, "utf8")).toContain("Initial public package.");
      expect(readFileSync(output, "utf8")).not.toContain("Future change.");
    });
  });

  it("promotes Unreleased notes into the bumped version changelog section", () => {
    withFixture((fixtureRoot) => {
      const packagePath = join(fixtureRoot, "package.json");
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      writeFileSync(packagePath, JSON.stringify({ ...pkg, version: "0.2.0" }, null, 2));

      const result = spawnSync(process.execPath, ["scripts/cut-changelog.mjs"], {
        cwd: root,
        env: scriptEnv(fixtureRoot),
        encoding: "utf8",
      });

      const changelog = readFileSync(join(fixtureRoot, "CHANGELOG.md"), "utf8");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("cut-changelog: promoted [Unreleased] to [0.2.0]");
      expect(changelog).toMatch(/^## \[Unreleased\]\n\n## \[0\.2\.0\] - \d{4}-\d{2}-\d{2}/m);
      expect(changelog).toContain("Future change.");
      expect(changelog).toContain(
        "[Unreleased]: https://github.com/backblaze-labs/b2-mcp/compare/v0.2.0...HEAD",
      );
      expect(changelog).toContain(
        "[0.2.0]: https://github.com/backblaze-labs/b2-mcp/compare/v0.1.0...v0.2.0",
      );
    });
  });

  it("syncs server.json versions from package metadata", () => {
    withFixture((fixtureRoot) => {
      const packagePath = join(fixtureRoot, "package.json");
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      writeFileSync(packagePath, JSON.stringify({ ...pkg, version: "0.2.0" }, null, 2));

      const result = spawnSync(process.execPath, ["scripts/update-server-json-version.mjs"], {
        cwd: root,
        env: scriptEnv(fixtureRoot),
        encoding: "utf8",
      });

      const serverJson = JSON.parse(readFileSync(join(fixtureRoot, "server.json"), "utf8"));
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "server-json-version: updated io.github.backblaze-labs/b2-mcp@0.2.0",
      );
      expect(serverJson.version).toBe("0.2.0");
      expect(serverJson.packages[0].version).toBe("0.2.0");
    });
  });

  it("validates the checked-in MCP Registry manifest contract", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const result = spawnSync(
      process.execPath,
      [
        "scripts/verify-mcp-registry-manifest.mjs",
        "--server-json",
        "server.json",
        "--package-json",
        "package.json",
        "--version",
        packageJson.version,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `mcp-registry-manifest: verified io.github.backblaze-labs/b2-mcp@${packageJson.version}`,
    );
  });

  for (const testCase of [
    {
      name: "extra packages",
      message: "server.json packages must contain exactly one entry",
      mutate: (manifest: Record<string, any>) => {
        manifest.packages.push({
          registryType: "npm",
          identifier: "@attacker/b2-mcp",
          version: manifest.version,
          transport: { type: "stdio" },
        });
      },
    },
    {
      name: "non-canonical repository URLs",
      message: "server.json repository URL is not canonical",
      mutate: (manifest: Record<string, any>) => {
        manifest.repository.url = "https://example.com/backblaze-labs/b2-mcp";
      },
    },
    {
      name: "non-stdio transports",
      message: "server.json package transport must be stdio",
      mutate: (manifest: Record<string, any>) => {
        manifest.packages[0].transport = { type: "streamable-http" };
      },
    },
    {
      name: "unexpected environment variables",
      message: "server.json environment variable B2_LOG_FILE is not in the approved allowlist",
      mutate: (manifest: Record<string, any>) => {
        manifest.packages[0].environmentVariables.push({
          description: "Log file path.",
          format: "string",
          isRequired: false,
          isSecret: false,
          name: "B2_LOG_FILE",
        });
      },
    },
    {
      name: "omitted false environment variable flags",
      message: "server.json environment variable B2_REGION.isRequired must be false",
      mutate: (manifest: Record<string, any>) => {
        const variable = manifest.packages[0].environmentVariables.find(
          (candidate: Record<string, any>) => candidate.name === "B2_REGION",
        );
        delete variable.isRequired;
      },
    },
    {
      name: "secret-like B2 variables marked non-secret",
      message: "server.json environment variable B2_APPLICATION_KEY must be secret",
      mutate: (manifest: Record<string, any>) => {
        const variable = manifest.packages[0].environmentVariables.find(
          (candidate: Record<string, any>) => candidate.name === "B2_APPLICATION_KEY",
        );
        variable.isSecret = false;
      },
    },
    {
      name: "server version drift",
      message: "server.json version 0.9.9 does not match 0.1.0",
      mutate: (manifest: Record<string, any>) => {
        manifest.version = "0.9.9";
      },
    },
  ]) {
    it(`rejects ${testCase.name} in server.json`, () => {
      withFixture((fixtureRoot) => {
        const manifest = readFixtureServerJson(fixtureRoot);
        testCase.mutate(manifest);
        writeFixtureServerJson(fixtureRoot, manifest);

        const result = spawnSync(
          process.execPath,
          ["scripts/verify-release-input.mjs", "--tag", "v0.1.0"],
          { cwd: root, env: scriptEnv(fixtureRoot), encoding: "utf8" },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(testCase.message);
      });
    });
  }

  it("publishes stable MCP Registry versions after a missing-version lookup", async () => {
    const { publishMcpRegistry } = await mcpRegistryPublishModule();
    const calls: McpPublisherRun[] = [];

    await withTempManifest(
      () => undefined,
      async (manifestPath, manifest) => {
        const result = await publishMcpRegistry({
          attempts: 2,
          fetchText: async (url: string) => {
            expect(url).toBe(
              `https://registry.modelcontextprotocol.io/v0/servers/${encodeURIComponent(
                manifest.name,
              )}/versions/${manifest.version}`,
            );
            return { body: "not found", status: 404 };
          },
          initialDelayMs: 1,
          log: quietLog(),
          publisherPath: "/tmp/mcp-publisher",
          runPublisher: async (args: string[], options: Record<string, unknown>) => {
            calls.push({
              args,
              publisherPath: String(options.publisherPath),
              timeoutMs: Number(options.timeoutMs),
            });
            return { code: 0, stderr: "", stdout: "" };
          },
          serverJsonPath: manifestPath,
          sleep: async () => undefined,
          version: manifest.version,
        });

        expect(result).toMatchObject({ status: "published" });
        expect(calls).toEqual([
          {
            args: [
              "login",
              "github-oidc",
              "--registry",
              "https://registry.modelcontextprotocol.io",
            ],
            publisherPath: "/tmp/mcp-publisher",
            timeoutMs: 120000,
          },
          {
            args: ["publish", manifestPath],
            publisherPath: "/tmp/mcp-publisher",
            timeoutMs: 120000,
          },
        ]);
      },
    );
  });

  it("passes custom MCP Registry roots to mcp-publisher login", async () => {
    const { publishMcpRegistry } = await mcpRegistryPublishModule();
    const calls: McpPublisherRun[] = [];
    const lookupUrls: string[] = [];

    await withTempManifest(
      () => undefined,
      async (manifestPath, manifest) => {
        const result = await publishMcpRegistry({
          fetchText: async (url: string) => {
            lookupUrls.push(url);
            return { body: "not found", status: 404 };
          },
          log: quietLog(),
          publisherPath: "/tmp/mcp-publisher",
          registryBaseUrl: "https://registry.example.test/custom/v0",
          runPublisher: async (args: string[], options: Record<string, unknown>) => {
            calls.push({
              args,
              publisherPath: String(options.publisherPath),
              timeoutMs: Number(options.timeoutMs),
            });
            return { code: 0, stderr: "", stdout: "" };
          },
          serverJsonPath: manifestPath,
          sleep: async () => undefined,
          version: manifest.version,
        });

        expect(result).toMatchObject({ status: "published" });
        expect(lookupUrls).toEqual([
          `https://registry.example.test/custom/v0/servers/${encodeURIComponent(
            manifest.name,
          )}/versions/${manifest.version}`,
        ]);
        expect(calls[0]).toEqual({
          args: ["login", "github-oidc", "--registry", "https://registry.example.test/custom"],
          publisherPath: "/tmp/mcp-publisher",
          timeoutMs: 120000,
        });
      },
    );
  });

  it("skips prerelease MCP Registry publishing before lookup or OIDC login", async () => {
    const { publishMcpRegistry } = await mcpRegistryPublishModule();

    await withTempManifest(
      (manifest) => {
        manifest.version = "0.2.0-rc.1";
        manifest.packages[0].version = "0.2.0-rc.1";
      },
      async (manifestPath, manifest) => {
        const result = await publishMcpRegistry({
          fetchText: async () => {
            throw new Error("lookup should not run for prereleases");
          },
          log: quietLog(),
          publisherPath: "/tmp/mcp-publisher",
          runPublisher: async () => {
            throw new Error("mcp-publisher should not run for prereleases");
          },
          serverJsonPath: manifestPath,
          skipPrerelease: true,
          sleep: async () => undefined,
          version: manifest.version,
        });

        expect(result).toMatchObject({ status: "skipped-prerelease" });
      },
    );
  });

  it("rejects malformed MCP Registry retry integers", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/mcp-registry-publish.mjs", "--attempts", "3seconds"],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--attempts must be a positive integer");
  });

  it("retries only explicit MCP Registry npm propagation 404s", async () => {
    const { isTransientMcpPublisherFailure, publishMcpRegistry } = await mcpRegistryPublishModule();
    const propagationMessage =
      "404: A newly published release can take a moment to appear on the registry. Wait and retry...";

    expect(isTransientMcpPublisherFailure({ stderr: propagationMessage, stdout: "" })).toBe(true);
    expect(isTransientMcpPublisherFailure({ stderr: "404: package not found", stdout: "" })).toBe(
      false,
    );

    await withTempManifest(
      () => undefined,
      async (manifestPath, manifest) => {
        const publisherCalls: string[][] = [];
        const sleeps: number[] = [];
        const result = await publishMcpRegistry({
          attempts: 3,
          fetchText: async () => ({ body: "", status: 404 }),
          initialDelayMs: 17,
          log: quietLog(),
          publisherPath: "/tmp/mcp-publisher",
          runPublisher: async (args: string[]) => {
            publisherCalls.push(args);
            if (args[0] === "login") return { code: 0, stderr: "", stdout: "" };
            const publishAttempts = publisherCalls.filter(
              ([command]) => command === "publish",
            ).length;
            return publishAttempts === 1
              ? { code: 1, stderr: propagationMessage, stdout: "" }
              : { code: 0, stderr: "", stdout: "" };
          },
          serverJsonPath: manifestPath,
          sleep: async (delayMs: number) => {
            sleeps.push(delayMs);
          },
          version: manifest.version,
        });

        expect(result).toMatchObject({ status: "published" });
        expect(publisherCalls).toEqual([
          ["login", "github-oidc", "--registry", "https://registry.modelcontextprotocol.io"],
          ["publish", manifestPath],
          ["publish", manifestPath],
        ]);
        expect(sleeps).toEqual([17]);
      },
    );
  });

  it("reports actual attempts for permanent MCP Registry publisher failures", async () => {
    const { publishMcpRegistry } = await mcpRegistryPublishModule();

    await withTempManifest(
      () => undefined,
      async (manifestPath, manifest) => {
        const loginCalls: string[][] = [];
        await expect(
          publishMcpRegistry({
            attempts: 3,
            fetchText: async () => ({ body: "", status: 404 }),
            log: quietLog(),
            publisherPath: "/tmp/mcp-publisher",
            runPublisher: async (args: string[]) => {
              loginCalls.push(args);
              return { code: 1, stderr: "", stdout: "" };
            },
            serverJsonPath: manifestPath,
            sleep: async () => undefined,
            version: manifest.version,
          }),
        ).rejects.toThrow("mcp-publisher login github-oidc failed after 1 attempt with exit 1");
        expect(loginCalls).toEqual([
          ["login", "github-oidc", "--registry", "https://registry.modelcontextprotocol.io"],
        ]);
      },
    );

    await withTempManifest(
      () => undefined,
      async (manifestPath, manifest) => {
        const publishCalls: string[][] = [];
        await expect(
          publishMcpRegistry({
            attempts: 3,
            fetchText: async () => ({ body: "", status: 404 }),
            log: quietLog(),
            publisherPath: "/tmp/mcp-publisher",
            runPublisher: async (args: string[]) => {
              publishCalls.push(args);
              return args[0] === "login"
                ? { code: 0, stderr: "", stdout: "" }
                : { code: 1, stderr: "", stdout: "" };
            },
            serverJsonPath: manifestPath,
            sleep: async () => undefined,
            version: manifest.version,
          }),
        ).rejects.toThrow("mcp-publisher publish failed after 1 attempt with exit 1");
        expect(publishCalls).toEqual([
          ["login", "github-oidc", "--registry", "https://registry.modelcontextprotocol.io"],
          ["publish", manifestPath],
        ]);
      },
    );
  });

  it("fails closed when an existing MCP Registry version mismatches server.json", async () => {
    const { publishMcpRegistry } = await mcpRegistryPublishModule();

    await withTempManifest(
      () => undefined,
      async (manifestPath, manifest) => {
        const registeredManifest = JSON.parse(JSON.stringify(manifest));
        registeredManifest.packages[0].identifier = "@attacker/b2-mcp";

        await expect(
          publishMcpRegistry({
            fetchText: async () => ({
              body: JSON.stringify({ server: registeredManifest }),
              status: 200,
            }),
            log: quietLog(),
            publisherPath: "/tmp/mcp-publisher",
            runPublisher: async () => {
              throw new Error("mcp-publisher should not run after a mismatch");
            },
            serverJsonPath: manifestPath,
            sleep: async () => undefined,
            version: manifest.version,
          }),
        ).rejects.toThrow("server.json package identifier must be @backblaze-labs/b2-mcp");
      },
    );
  });

  it("accepts an existing MCP Registry version only when it matches server.json", async () => {
    const { publishMcpRegistry } = await mcpRegistryPublishModule();

    await withTempManifest(
      () => undefined,
      async (manifestPath, manifest) => {
        const result = await publishMcpRegistry({
          fetchText: async () => ({
            body: JSON.stringify({ server: manifest }),
            status: 200,
          }),
          log: quietLog(),
          publisherPath: "/tmp/mcp-publisher",
          runPublisher: async () => {
            throw new Error("mcp-publisher should not run for matching existing versions");
          },
          serverJsonPath: manifestPath,
          sleep: async () => undefined,
          version: manifest.version,
        });

        expect(result).toMatchObject({ status: "already-published" });
      },
    );
  });

  it("accepts registry response manifests that omit explicit false booleans", async () => {
    const { publishMcpRegistry } = await mcpRegistryPublishModule();

    await withTempManifest(
      () => undefined,
      async (manifestPath, manifest) => {
        const registeredManifest = JSON.parse(JSON.stringify(manifest));
        for (const variable of registeredManifest.packages[0].environmentVariables) {
          if (variable.isRequired === false) delete variable.isRequired;
          if (variable.isSecret === false) delete variable.isSecret;
        }

        const result = await publishMcpRegistry({
          fetchText: async () => ({
            body: JSON.stringify({
              _meta: {
                "io.modelcontextprotocol.registry/official": {
                  isLatest: true,
                  status: "active",
                },
              },
              server: registeredManifest,
            }),
            status: 200,
          }),
          log: quietLog(),
          publisherPath: "/tmp/mcp-publisher",
          runPublisher: async () => {
            throw new Error("mcp-publisher should not run for matching existing versions");
          },
          serverJsonPath: manifestPath,
          sleep: async () => undefined,
          version: manifest.version,
        });

        expect(result).toMatchObject({ status: "already-published" });
      },
    );
  });

  it("rechecks the registry after ambiguous mcp-publisher publish failures", async () => {
    const { publishMcpRegistry } = await mcpRegistryPublishModule();
    const publisherCalls: string[][] = [];
    const registryStatuses: number[] = [];
    const sleeps: number[] = [];

    await withTempManifest(
      () => undefined,
      async (manifestPath, manifest) => {
        const registryResponses = [
          { body: "", status: 404 },
          { body: "", status: 404 },
          { body: JSON.stringify({ server: manifest }), status: 200 },
        ];
        const result = await publishMcpRegistry({
          attempts: 3,
          fetchText: async () => {
            const response = registryResponses.shift();
            if (!response) throw new Error("unexpected registry lookup");
            registryStatuses.push(response.status);
            return response;
          },
          initialDelayMs: 13,
          log: quietLog(),
          publisherPath: "/tmp/mcp-publisher",
          runPublisher: async (args: string[]) => {
            publisherCalls.push(args);
            if (args[0] === "login") return { code: 0, stderr: "", stdout: "" };
            const publishAttempts = publisherCalls.filter(
              ([command]) => command === "publish",
            ).length;
            return publishAttempts === 1
              ? { code: 1, stderr: "", stdout: "", timedOut: true }
              : {
                  code: 1,
                  stderr: "cannot publish duplicate version",
                  stdout: "",
                };
          },
          serverJsonPath: manifestPath,
          sleep: async (delayMs: number) => {
            sleeps.push(delayMs);
          },
          version: manifest.version,
        });

        expect(result).toMatchObject({ status: "already-published" });
        expect(registryStatuses).toEqual([404, 404, 200]);
        expect(publisherCalls).toEqual([
          ["login", "github-oidc", "--registry", "https://registry.modelcontextprotocol.io"],
          ["publish", manifestPath],
          ["publish", manifestPath],
        ]);
        expect(sleeps).toEqual([13]);
      },
    );
  });

  it("retries transient MCP Registry lookup failures", async () => {
    const { publishMcpRegistry } = await mcpRegistryPublishModule();
    const statuses: number[] = [];
    const sleeps: number[] = [];
    let lookupAttempts = 0;

    await withTempManifest(
      () => undefined,
      async (manifestPath, manifest) => {
        const result = await publishMcpRegistry({
          attempts: 3,
          fetchText: async () => {
            lookupAttempts += 1;
            const status = lookupAttempts === 1 ? 503 : 404;
            statuses.push(status);
            return { body: "", status };
          },
          initialDelayMs: 7,
          log: quietLog(),
          publisherPath: "/tmp/mcp-publisher",
          runPublisher: async () => ({ code: 0, stderr: "", stdout: "" }),
          serverJsonPath: manifestPath,
          sleep: async (delayMs: number) => {
            sleeps.push(delayMs);
          },
          version: manifest.version,
        });

        expect(result).toMatchObject({ status: "published" });
        expect(statuses).toEqual([503, 404]);
        expect(sleeps).toEqual([7]);
      },
    );
  });

  it("retries transient mcp-publisher publish failures", async () => {
    const { publishMcpRegistry } = await mcpRegistryPublishModule();
    const publisherCalls: string[][] = [];
    const sleeps: number[] = [];

    await withTempManifest(
      () => undefined,
      async (manifestPath, manifest) => {
        const result = await publishMcpRegistry({
          attempts: 3,
          fetchText: async () => ({ body: "", status: 404 }),
          initialDelayMs: 11,
          log: quietLog(),
          publisherPath: "/tmp/mcp-publisher",
          runPublisher: async (args: string[]) => {
            publisherCalls.push(args);
            if (
              args[0] === "publish" &&
              publisherCalls.filter(([command]) => command === "publish").length === 1
            ) {
              return { code: 1, stderr: "", stdout: "", timedOut: true };
            }
            return { code: 0, stderr: "", stdout: "" };
          },
          serverJsonPath: manifestPath,
          sleep: async (delayMs: number) => {
            sleeps.push(delayMs);
          },
          version: manifest.version,
        });

        expect(result).toMatchObject({ status: "published" });
        expect(publisherCalls).toEqual([
          ["login", "github-oidc", "--registry", "https://registry.modelcontextprotocol.io"],
          ["publish", manifestPath],
          ["publish", manifestPath],
        ]);
        expect(sleeps).toEqual([11]);
      },
    );
  });

  it("runs the pnpm version changelog lifecycle with install scripts disabled", () => {
    withFixture((fixtureRoot) => {
      const packagePath = join(fixtureRoot, "package.json");
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      writeFileSync(
        packagePath,
        JSON.stringify(
          {
            ...pkg,
            scripts: {
              version: [
                `node ${join(root, "scripts/cut-changelog.mjs")}`,
                `node ${join(root, "scripts/update-server-json-version.mjs")}`,
                "git add CHANGELOG.md server.json",
              ].join(" && "),
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(join(fixtureRoot, ".npmrc"), "ignore-scripts=true\n");
      runGit(fixtureRoot, ["init", "-b", "main"]);
      runGit(fixtureRoot, ["config", "user.email", "release@example.com"]);
      runGit(fixtureRoot, ["config", "user.name", "Release Test"]);
      runGit(fixtureRoot, ["add", "."]);
      runGit(fixtureRoot, ["commit", "-m", "initial"]);

      const result = spawnSync(
        "pnpm",
        ["version", "patch", "--no-git-tag-version", "--no-commit-hooks"],
        { cwd: fixtureRoot, env: scriptEnv(fixtureRoot), encoding: "utf8" },
      );
      const changelog = readFileSync(join(fixtureRoot, "CHANGELOG.md"), "utf8");
      const bumpedPackage = JSON.parse(readFileSync(packagePath, "utf8"));
      const bumpedServerJson = JSON.parse(readFileSync(join(fixtureRoot, "server.json"), "utf8"));
      const stagedFiles = runGit(fixtureRoot, ["diff", "--cached", "--name-only"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("cut-changelog: promoted [Unreleased] to [0.1.1]");
      expect(bumpedPackage.version).toBe("0.1.1");
      expect(bumpedServerJson.version).toBe("0.1.1");
      expect(bumpedServerJson.packages[0].version).toBe("0.1.1");
      expect(changelog).toMatch(/^## \[Unreleased\]\n\n## \[0\.1\.1\] - \d{4}-\d{2}-\d{2}/m);
      expect(stagedFiles.split(/\r?\n/)).toContain("CHANGELOG.md");
      expect(stagedFiles.split(/\r?\n/)).toContain("server.json");
    });
  });

  it("keeps the issue 64 release automation entry in the changelog", () => {
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

    expect(changelog).toContain("issue #64 release verification");
  });

  it("derives safe npm dist-tags for stable and prerelease versions", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          'import { npmDistTag } from "./scripts/lib/release-utils.mjs";',
          "process.stdout.write(JSON.stringify([",
          '  npmDistTag("0.1.0"),',
          '  npmDistTag("0.2.0-rc.1"),',
          '  npmDistTag("0.2.0-preview.1"),',
          "]));",
        ].join("\n"),
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["latest", "rc", "next"]);
  });

  it("prints package publish metadata through the shared helper", () => {
    withFixture((fixtureRoot) => {
      const packagePath = join(fixtureRoot, "package.json");
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      writeFileSync(packagePath, JSON.stringify({ ...pkg, version: "0.2.0-preview.1" }, null, 2));

      const result = spawnSync(
        process.execPath,
        ["scripts/npm-publish-metadata.mjs", "--package-json", packagePath],
        { cwd: root, encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        spec: "@backblaze-labs/b2-mcp@0.2.0-preview.1",
        tag: "next",
      });
    });
  });

  it("writes a stable release marker after build output exists", () => {
    withFixture((fixtureRoot) => {
      mkdirSync(join(fixtureRoot, "dist"));

      const result = spawnSync(
        process.execPath,
        ["scripts/write-release-version.mjs", "--version", "0.1.0"],
        { cwd: root, env: scriptEnv(fixtureRoot), encoding: "utf8" },
      );
      const marker = JSON.parse(
        readFileSync(join(fixtureRoot, "dist/release-version.json"), "utf8"),
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("release-version: wrote dist/release-version.json");
      expect(marker).toEqual({
        name: "@backblaze-labs/b2-mcp",
        releaseChannel: "published",
        version: "0.1.0",
      });
    });
  });

  it("skips release markers for prerelease package versions", () => {
    withFixture((fixtureRoot) => {
      const packagePath = join(fixtureRoot, "package.json");
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      mkdirSync(join(fixtureRoot, "dist"));
      writeFileSync(packagePath, JSON.stringify({ ...pkg, version: "0.2.0-rc.1" }, null, 2));
      writeFileSync(join(fixtureRoot, "dist/release-version.json"), '{"version":"stale"}\n');

      const result = spawnSync(
        process.execPath,
        ["scripts/write-release-version.mjs", "--version", "0.2.0-rc.1"],
        { cwd: root, env: scriptEnv(fixtureRoot), encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("release-version: skipped dist/release-version.json");
      expect(() => readFileSync(join(fixtureRoot, "dist/release-version.json"), "utf8")).toThrow();
    });
  });

  it("cleans release markers after package lifecycle packing", () => {
    withFixture((fixtureRoot) => {
      mkdirSync(join(fixtureRoot, "dist"));
      writeFileSync(join(fixtureRoot, "dist/release-version.json"), '{"version":"stale"}\n');

      const result = spawnSync(process.execPath, ["scripts/write-release-version.mjs", "--clean"], {
        cwd: root,
        env: scriptEnv(fixtureRoot),
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("release-version: removed dist/release-version.json");
      expect(() => readFileSync(join(fixtureRoot, "dist/release-version.json"), "utf8")).toThrow();
    });
  });

  it("rejects leaked npm registry _from/_resolved metadata", async () => {
    const { verifyNpmRegistryMetadata } = await registryMetadataModule();

    await expect(
      verifyNpmRegistryMetadata({
        packageSpec: "@backblaze-labs/b2-mcp@9.9.9",
        viewMetadata: () => ({
          status: 0,
          stdout: JSON.stringify({
            _resolved:
              "/home/runner/work/b2-mcp/b2-mcp/publish-package/backblaze-labs-b2-mcp-9.9.9.tgz",
          }),
          stderr: "",
        }),
        wait: async () => undefined,
        log: { log: () => undefined, warn: () => undefined },
      }),
    ).rejects.toThrow("registry metadata exposes local publish coordinates");
  });

  it("classifies npm view failures as retryable only for transient signals", async () => {
    const { isRetryableNpmViewFailure } = await registryMetadataModule();
    const failing = (stderr: string) =>
      isRetryableNpmViewFailure({ status: 1, stdout: "", stderr });

    expect(failing("npm error 503 registry busy")).toBe(true);
    expect(failing("npm error 429 Too Many Requests")).toBe(true);
    expect(failing("npm error code E404")).toBe(true);
    expect(failing("npm error network timeout while fetching")).toBe(true);
    // Non-transient failures must fail fast, not retry to the deadline.
    expect(failing("npm error code E403 403 Forbidden")).toBe(false);
    expect(failing("EACCES: permission denied")).toBe(false);
    // An embedded version/number must not be misread as an HTTP status.
    expect(failing("cannot find matching version 1.500.0")).toBe(false);
  });

  it("reads registry metadata without assuming absent _from/_resolved are present", async () => {
    const { parseRegistryMetadata, leakedRegistryMetadataKeys } = await registryMetadataModule();

    expect(parseRegistryMetadata("")).toEqual({});
    expect(parseRegistryMetadata("{}")).toEqual({});
    expect(leakedRegistryMetadataKeys(parseRegistryMetadata("{}"))).toEqual([]);
    expect(leakedRegistryMetadataKeys({ _resolved: "" })).toEqual([]);
    expect(
      leakedRegistryMetadataKeys({ _from: "file:x.tgz", _resolved: "/Users/x/x.tgz" }),
    ).toEqual(["_from", "_resolved"]);
  });

  it("retries not-yet-visible npm registry metadata before passing", async () => {
    const { verifyNpmRegistryMetadata } = await registryMetadataModule();
    const warnings: string[] = [];
    const delays: number[] = [];
    let attempts = 0;

    const result = await verifyNpmRegistryMetadata({
      packageSpec: "@backblaze-labs/b2-mcp@9.9.9",
      timeoutMs: 1_000,
      initialIntervalMs: 1,
      maxIntervalMs: 4,
      viewMetadata: () => {
        attempts += 1;
        return attempts === 1
          ? { status: 1, stdout: "", stderr: "npm ERR! 404 not found" }
          : { status: 0, stdout: "{}", stderr: "" };
      },
      wait: async (delayMs: number) => {
        delays.push(delayMs);
      },
      log: { log: () => undefined, warn: (message: string) => warnings.push(message) },
    });

    expect(result).toMatchObject({ status: "verified", attempts: 2 });
    expect(delays).toEqual([1]);
    expect(warnings.join("\n")).toContain("retrying npm view");
  });

  it("allows matching-integrity reruns for documented legacy metadata leaks", async () => {
    const { verifyNpmRegistryMetadata } = await registryMetadataModule();
    const warnings: string[] = [];

    const result = await verifyNpmRegistryMetadata({
      packageSpec: "@backblaze-labs/b2-mcp@0.1.1",
      allowedLegacySpecs: new Set(["@backblaze-labs/b2-mcp@0.1.1"]),
      viewMetadata: () => ({
        status: 0,
        stdout: JSON.stringify({
          _from: "file:publish-package/backblaze-labs-b2-mcp-0.1.1.tgz",
          _resolved:
            "/home/runner/work/b2-mcp/b2-mcp/publish-package/backblaze-labs-b2-mcp-0.1.1.tgz",
        }),
        stderr: "",
      }),
      wait: async () => undefined,
      log: { log: () => undefined, warn: (message: string) => warnings.push(message) },
    });

    expect(result).toMatchObject({ status: "legacy-allowed", leaked: ["_from", "_resolved"] });
    expect(warnings.join("\n")).toContain("matching-integrity rerun is allowed");
  });

  it("fails registry metadata verification when the retry deadline expires", async () => {
    const { verifyNpmRegistryMetadata } = await registryMetadataModule();
    let nowCalls = 0;

    await expect(
      verifyNpmRegistryMetadata({
        packageSpec: "@backblaze-labs/b2-mcp@9.9.9",
        timeoutMs: 5,
        initialIntervalMs: 1,
        viewMetadata: () => ({ status: 1, stdout: "", stderr: "npm ERR! 503 registry busy" }),
        wait: async () => undefined,
        now: () => {
          nowCalls += 1;
          return nowCalls === 1 ? 0 : 10;
        },
        log: { log: () => undefined, warn: () => undefined },
      }),
    ).rejects.toThrow("did not complete within 5ms");
  });

  it("verifies tag, metadata, package files, and changelog agreement", () => {
    withFixture((fixtureRoot) => {
      const result = spawnSync(
        process.execPath,
        ["scripts/verify-release-input.mjs", "--tag", "v0.1.0"],
        { cwd: root, env: scriptEnv(fixtureRoot), encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("release-input: verified v0.1.0");
    });
  });

  it("rejects tag/version mismatches", () => {
    withFixture((fixtureRoot) => {
      const result = spawnSync(
        process.execPath,
        ["scripts/verify-release-input.mjs", "--tag", "v0.2.0"],
        { cwd: root, env: scriptEnv(fixtureRoot), encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("does not match package version 0.1.0");
    });
  });
});
