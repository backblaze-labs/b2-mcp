import { spawnSync } from "child_process";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import * as stdioTransport from "@modelcontextprotocol/server/stdio";
import { CliUsageError, helpText } from "../../src/cli";
import { CredentialResolutionError } from "../../src/credentials";
import { exitOnFatalError, runCli, startStdio } from "../../src/index";
import * as httpServerModule from "../../src/http-server";
import * as serverModule from "../../src/server";
import { PortUsageError } from "../../src/utils/config";
import { logger } from "../../src/utils/logger";
import type { B2Config } from "../../src/utils/types";
import { VERSION } from "../../src/version";

vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: vi.fn(),
}));

vi.mock("../../src/http-server", () => ({
  startHttp: vi.fn(async () => undefined),
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

  it("rethrows a capability failure that is not an upstream outage", async () => {
    vi.spyOn(serverModule, "loadConfig").mockReturnValue(testConfig());
    vi.spyOn(serverModule, "fetchCapabilities").mockRejectedValue(
      new CredentialResolutionError("bad key", 401, "invalid_credentials"),
    );

    // Only capability_upstream_unavailable degrades to the full surface; an
    // auth failure must fail closed rather than register every tool.
    await expect(startStdio()).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(stdioTransport.serveStdio).not.toHaveBeenCalled();
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

describe("runCli dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("prints help and starts no transport", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli(["--help"]);

    expect(stdout).toHaveBeenCalledWith(`${helpText()}\n`);
    expect(httpServerModule.startHttp).not.toHaveBeenCalled();
    expect(stdioTransport.serveStdio).not.toHaveBeenCalled();
  });

  it("prints the package version and starts no transport", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli(["--version"]);

    expect(stdout).toHaveBeenCalledWith(`${VERSION}\n`);
    expect(httpServerModule.startHttp).not.toHaveBeenCalled();
    expect(stdioTransport.serveStdio).not.toHaveBeenCalled();
  });

  it("starts the HTTP transport with the requested port", async () => {
    await runCli(["http", "--port", "4321"]);

    expect(httpServerModule.startHttp).toHaveBeenCalledWith({ port: 4321 });
    expect(stdioTransport.serveStdio).not.toHaveBeenCalled();
  });

  it("starts the HTTP transport without a port so the default applies", async () => {
    await runCli(["--transport=http"]);

    expect(httpServerModule.startHttp).toHaveBeenCalledWith({ port: undefined });
  });

  it("starts stdio by default", async () => {
    const server = { close: vi.fn(async () => undefined) };
    vi.spyOn(serverModule, "loadConfig").mockReturnValue(testConfig());
    vi.spyOn(serverModule, "createServer").mockReturnValue(server as never);
    vi.spyOn(serverModule, "fetchCapabilities").mockResolvedValue(["listBuckets"]);
    const serveStdio = vi.mocked(stdioTransport.serveStdio).mockImplementation(
      () =>
        ({
          close: vi.fn(async () => undefined),
        }) as ReturnType<typeof stdioTransport.serveStdio>,
    );

    await runCli([]);

    expect(serveStdio).toHaveBeenCalledTimes(1);
    expect(httpServerModule.startHttp).not.toHaveBeenCalled();
  });

  it("rejects with the usage error instead of exiting", async () => {
    await expect(runCli(["--transport", "sse"])).rejects.toBeInstanceOf(CliUsageError);
  });
});

describe("exitOnFatalError", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw Object.assign(new Error(`process.exit(${code})`), { exitCode: code });
    }) as typeof process.exit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("exits 2 with help for a CLI usage error", () => {
    const fatal = vi.spyOn(logger, "fatal").mockImplementation(() => undefined);

    expect(() => exitOnFatalError(new CliUsageError("Invalid transport: sse"))).toThrow(
      "process.exit(2)",
    );
    expect(stderr).toHaveBeenCalledWith(`b2-mcp: Invalid transport: sse\n\n${helpText()}\n`);
    // A usage error is user input, not a server failure: no fatal log.
    expect(fatal).not.toHaveBeenCalled();
  });

  it("exits 2 with help for a port usage error", () => {
    expect(() => exitOnFatalError(new PortUsageError("Invalid port: 0"))).toThrow(
      "process.exit(2)",
    );
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("exits 1 and logs a fatal event for an unexpected error", () => {
    const fatal = vi.spyOn(logger, "fatal").mockImplementation(() => undefined);

    expect(() => exitOnFatalError(new Error("listen EADDRINUSE"))).toThrow("process.exit(1)");
    expect(stderr).toHaveBeenCalledWith("b2-mcp: listen EADDRINUSE\n");
    expect(fatal).toHaveBeenCalledWith({ err: "listen EADDRINUSE" }, "server.fatal");
  });

  it("stringifies a non-Error rejection", () => {
    const fatal = vi.spyOn(logger, "fatal").mockImplementation(() => undefined);

    expect(() => exitOnFatalError("boom")).toThrow("process.exit(1)");
    expect(stderr).toHaveBeenCalledWith("b2-mcp: boom\n");
    expect(fatal).toHaveBeenCalledWith({ err: "boom" }, "server.fatal");
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
