import { spawnSync } from "child_process";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import * as stdioTransport from "@modelcontextprotocol/server/stdio";
import { helpText } from "../../src/cli";
import { CredentialResolutionError } from "../../src/credentials";
import { runCli, startStdio } from "../../src/index";
import * as serverModule from "../../src/server";
import { logger } from "../../src/utils/logger";
import type { B2Config } from "../../src/utils/types";
import { VERSION } from "../../src/version";

vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: vi.fn(),
}));

// runCli's http branch resolves this via a dynamic import(); mocking the
// statically-imported specifier here still intercepts it, since Vitest keys
// mocks by resolved module id rather than by import syntax.
vi.mock("../../src/http-server", () => ({
  startHttp: vi.fn(),
}));

const credentialEnvKeys = [
  "B2_APPLICATION_KEY_ID",
  "B2_APPLICATION_KEY",
  "B2_APP_KEY_ID",
  "B2_APP_KEY",
  "B2_MASTER_KEY_ID",
  "B2_MASTER_KEY",
] as const;

const tsxBin = path.join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

function testConfig(): B2Config {
  return {
    applicationKeyId: "app-id",
    applicationKey: "app-secret",
    appKeyId: "app-id",
    appKey: "app-secret",
    masterKeyId: "app-id",
    masterKey: "app-secret",
    region: "us-west-004",
    allowLocalFiles: true,
    fileRoot: null,
    destructivePolicy: "confirm",
    outputFormat: "json",
    transport: "stdio",
    credentialFingerprint: "credential-fingerprint",
  };
}

function executableEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test" };
  for (const key of credentialEnvKeys) delete env[key];
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

function runEntrypoint(args: string[]) {
  return spawnSync(tsxBin, ["src/index.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: executableEnv(),
    timeout: 10_000,
  });
}

describe("stdio entry point", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(credentialEnvKeys.map((key) => [key, process.env[key]]));
  });

  afterEach(() => {
    for (const key of credentialEnvKeys) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("bootstraps stdio with fetched credential capabilities", async () => {
    const config = testConfig();
    const server = { close: vi.fn(async () => undefined) };
    const createServer = vi.spyOn(serverModule, "createServer").mockReturnValue(server as never);
    vi.spyOn(serverModule, "loadConfig").mockReturnValue(config);
    vi.spyOn(serverModule, "fetchCapabilities").mockResolvedValue(["listBuckets"]);
    const serveStdio = vi.mocked(stdioTransport.serveStdio).mockImplementation(
      () =>
        ({
          close: vi.fn(async () => undefined),
        }) as ReturnType<typeof stdioTransport.serveStdio>,
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    await startStdio();

    const factory = serveStdio.mock.calls[0]?.[0] as (() => unknown) | undefined;
    const options = serveStdio.mock.calls[0]?.[1] as { onerror(error: Error): void } | undefined;
    expect(factory?.()).toBe(server);
    options?.onerror(new Error("stdio failed"));
    expect(createServer).toHaveBeenCalledWith(config, ["listBuckets"]);
    expect(warn).toHaveBeenCalledWith({ err: "stdio failed" }, "mcp.stdio.error");
  });

  it("falls back to the full stdio surface when capability lookup is unavailable", async () => {
    const config = testConfig();
    const server = { close: vi.fn(async () => undefined) };
    const createServer = vi.spyOn(serverModule, "createServer").mockReturnValue(server as never);
    vi.spyOn(serverModule, "loadConfig").mockReturnValue(config);
    vi.spyOn(serverModule, "fetchCapabilities").mockRejectedValue(
      new CredentialResolutionError(
        "capability service unavailable",
        503,
        "capability_upstream_unavailable",
      ),
    );
    const serveStdio = vi.mocked(stdioTransport.serveStdio).mockImplementation(
      () =>
        ({
          close: vi.fn(async () => undefined),
        }) as ReturnType<typeof stdioTransport.serveStdio>,
    );

    await startStdio();

    const factory = serveStdio.mock.calls[0]?.[0] as (() => unknown) | undefined;
    expect(factory?.()).toBe(server);
    expect(createServer).toHaveBeenCalledWith(config, null);
  });

  it("writes the missing-credential message and exits non-zero", async () => {
    for (const key of credentialEnvKeys) delete process.env[key];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(((code) => {
      throw Object.assign(new Error(`process.exit(${code})`), { exitCode: code });
    }) as typeof process.exit);

    await expect(startStdio()).rejects.toMatchObject({ exitCode: 1 });
    expect(stderr).toHaveBeenCalledWith(
      "b2-mcp: B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY are required for stdio\n",
    );
  });
});

describe("runCli dispatch (in-process)", () => {
  // These call the exported runCli() directly rather than spawning a
  // subprocess, so v8 coverage attributes to the lines it executes -- the
  // "executable CLI entry point" tests below exercise the same behavior
  // black-box, through the real CLI, but coverage cannot see into a spawned
  // child process.
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("--help prints usage and does not start a server", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const loadConfig = vi.spyOn(serverModule, "loadConfig");

    await runCli(["--help"]);

    expect(stdout).toHaveBeenCalledWith(`${helpText()}
`);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("-h is the same as --help", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli(["-h"]);

    expect(stdout).toHaveBeenCalledWith(`${helpText()}
`);
  });

  it("--version prints the package version and does not start a server", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const loadConfig = vi.spyOn(serverModule, "loadConfig");

    await runCli(["--version"]);

    expect(stdout).toHaveBeenCalledWith(`${VERSION}
`);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("dispatches to the HTTP transport when transport is http", async () => {
    const { startHttp } = await import("../../src/http-server");

    await runCli(["http", "--port", "4321"]);

    expect(vi.mocked(startHttp)).toHaveBeenCalledWith({ port: 4321 });
  });

  it("dispatches to startStdio by default", async () => {
    const config = testConfig();
    const server = { close: vi.fn(async () => undefined) };
    vi.spyOn(serverModule, "createServer").mockReturnValue(server as never);
    vi.spyOn(serverModule, "loadConfig").mockReturnValue(config);
    vi.spyOn(serverModule, "fetchCapabilities").mockResolvedValue(["listBuckets"]);
    const serveStdio = vi.mocked(stdioTransport.serveStdio).mockImplementation(
      () =>
        ({
          close: vi.fn(async () => undefined),
        }) as ReturnType<typeof stdioTransport.serveStdio>,
    );

    await runCli([]);

    expect(serveStdio).toHaveBeenCalled();
  });

  it("propagates a CLI usage error to the caller rather than swallowing it", async () => {
    await expect(runCli(["--transport", "sse"])).rejects.toThrow("Invalid transport: sse");
  });
});

describe("executable CLI entry point", () => {
  it("prints usage errors with help and exit code 2", () => {
    const result = runEntrypoint(["--transport", "sse"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("b2-mcp: Invalid transport: sse");
    expect(result.stderr).toContain("Usage: b2-mcp");
  });

  it("selects stdio by default and reports missing credentials with exit code 1", () => {
    const result = runEntrypoint([]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "b2-mcp: B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY are required for stdio",
    );
  });

  it("selects HTTP transport and reports startup failures with exit code 1", async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const port = (blocker.address() as AddressInfo).port;

    try {
      const result = runEntrypoint(["http", "--port", String(port)]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("b2-mcp: listen EADDRINUSE");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
