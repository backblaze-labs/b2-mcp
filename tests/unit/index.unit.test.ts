import * as stdioTransport from "@modelcontextprotocol/server/stdio";
import { spawnSync } from "child_process";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import { helpText } from "../../src/cli";
import { CredentialResolutionError } from "../../src/credentials";
import * as packageRoot from "../../src/index";
import * as serverModule from "../../src/server";
import * as loggerModule from "../../src/utils/logger";
import type { B2Config } from "../../src/utils/types";
import { VERSION } from "../../src/version";

vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: vi.fn(),
}));

vi.mock("../../src/http-server.js", () => ({
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

const transportEnvKeys = ["B2_MCP_TRANSPORT"] as const;
const bootstrapEnvKeys = [
  "B2_STDIO_CAPABILITY_TIMEOUT_MS",
  "B2_REGISTER_ALL_TOOLS",
  "B2_SECRET_SINK",
] as const;
const executableEnvKeys = [...credentialEnvKeys, ...transportEnvKeys, ...bootstrapEnvKeys] as const;
const { startStdio } = packageRoot;

type IndexTestSeams = {
  runCli(argv?: string[]): Promise<void>;
  handleCliError(err: unknown): never;
};

function indexTestSeams(): IndexTestSeams {
  const seams = (globalThis as typeof globalThis & { __b2McpIndexTestSeams?: IndexTestSeams })
    .__b2McpIndexTestSeams;
  if (!seams) throw new Error("index test seams were not installed");
  return seams;
}

async function runMain(argv: string[]): Promise<void> {
  try {
    await indexTestSeams().runCli(argv);
  } catch (err) {
    indexTestSeams().handleCliError(err);
  }
}

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

function executableEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test" };
  for (const key of executableEnvKeys) delete env[key];
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return { ...env, ...overrides };
}

function runEntrypoint(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(tsxBin, ["src/index.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: executableEnv(env),
    timeout: 10_000,
  });
}

describe("stdio entry point", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(
      [...credentialEnvKeys, ...bootstrapEnvKeys].map((key) => [key, process.env[key]]),
    );
    // Default to the credentialed path; discovery-mode cases delete these.
    process.env.B2_APPLICATION_KEY_ID = "test-key-id";
    process.env.B2_APPLICATION_KEY = "test-key-secret";
    delete process.env.B2_REGISTER_ALL_TOOLS;
  });

  afterEach(() => {
    for (const key of [...credentialEnvKeys, ...bootstrapEnvKeys]) {
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
    const warn = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);

    await startStdio();

    const factory = serveStdio.mock.calls[0]?.[0] as (() => unknown) | undefined;
    const options = serveStdio.mock.calls[0]?.[1] as { onerror(error: Error): void } | undefined;
    expect(factory?.()).toBe(server);
    options?.onerror(new Error("stdio failed"));
    expect(createServer).toHaveBeenCalledWith(config, ["listBuckets"]);
    expect(warn).toHaveBeenCalledWith({ err: "stdio failed" }, "mcp.stdio.error");
  });

  it("enters credential-less discovery mode and enumerates the full surface", async () => {
    delete process.env.B2_APPLICATION_KEY_ID;
    delete process.env.B2_APPLICATION_KEY;
    const config = testConfig();
    const server = { close: vi.fn(async () => undefined) };
    const createServer = vi.spyOn(serverModule, "createServer").mockReturnValue(server as never);
    vi.spyOn(serverModule, "loadConfig").mockReturnValue(config);
    // B2_REGISTER_ALL_TOOLS=true makes the real fetchCapabilities resolve null;
    // the mock stands in for that full-surface result.
    const fetchCapabilities = vi.spyOn(serverModule, "fetchCapabilities").mockResolvedValue(null);
    const serveStdio = vi
      .mocked(stdioTransport.serveStdio)
      .mockImplementation(
        () =>
          ({ close: vi.fn(async () => undefined) }) as ReturnType<typeof stdioTransport.serveStdio>,
      );
    const warn = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);

    await startStdio();
    (serveStdio.mock.calls[0]?.[0] as (() => unknown) | undefined)?.();

    expect(process.env.B2_APPLICATION_KEY_ID).toBe("b2-mcp-discovery-mode");
    expect(process.env.B2_APPLICATION_KEY).toBe("b2-mcp-discovery-mode");
    expect(process.env.B2_REGISTER_ALL_TOOLS).toBe("true");
    expect(process.env.B2_SECRET_SINK).toBe("off");
    expect(fetchCapabilities).toHaveBeenCalled();
    expect(createServer).toHaveBeenCalledWith(config, null, { credentialsMissing: true });
    expect(warn).toHaveBeenCalledWith(
      { transport: "stdio", reason: "no_credentials" },
      "server.stdio_discovery_mode",
    );
  });

  it("does not enter discovery mode when credentials are present", async () => {
    process.env.B2_APPLICATION_KEY_ID = "test-key-id";
    process.env.B2_APPLICATION_KEY = "test-key-secret";
    const config = testConfig();
    const server = { close: vi.fn(async () => undefined) };
    const createServer = vi.spyOn(serverModule, "createServer").mockReturnValue(server as never);
    vi.spyOn(serverModule, "loadConfig").mockReturnValue(config);
    vi.spyOn(serverModule, "fetchCapabilities").mockResolvedValue(["listBuckets"]);
    const serveStdio = vi
      .mocked(stdioTransport.serveStdio)
      .mockImplementation(
        () =>
          ({ close: vi.fn(async () => undefined) }) as ReturnType<typeof stdioTransport.serveStdio>,
      );

    await startStdio();
    (serveStdio.mock.calls[0]?.[0] as (() => unknown) | undefined)?.();

    expect(process.env.B2_APPLICATION_KEY_ID).toBe("test-key-id");
    expect(createServer).toHaveBeenCalledWith(config, ["listBuckets"]);
    expect(createServer).not.toHaveBeenCalledWith(config, expect.anything(), {
      credentialsMissing: true,
    });
  });

  it("does not enter discovery mode with a partial credential pair", async () => {
    // Only the key id is set: a partial/mistyped pair must still fail fast as
    // invalid instead of overwriting the configured half and starting an unusable
    // discovery server.
    process.env.B2_APPLICATION_KEY_ID = "test-key-id";
    delete process.env.B2_APPLICATION_KEY;
    const config = testConfig();
    const server = { close: vi.fn(async () => undefined) };
    const createServer = vi.spyOn(serverModule, "createServer").mockReturnValue(server as never);
    vi.spyOn(serverModule, "loadConfig").mockReturnValue(config);
    vi.spyOn(serverModule, "fetchCapabilities").mockResolvedValue(["listBuckets"]);
    vi.mocked(stdioTransport.serveStdio).mockImplementation(
      () =>
        ({ close: vi.fn(async () => undefined) }) as ReturnType<typeof stdioTransport.serveStdio>,
    );

    await startStdio();

    // The configured half is left untouched (never overwritten with the
    // placeholder) and discovery mode is not activated.
    expect(process.env.B2_APPLICATION_KEY_ID).toBe("test-key-id");
    expect(process.env.B2_APPLICATION_KEY).toBeUndefined();
    expect(createServer).not.toHaveBeenCalledWith(config, expect.anything(), {
      credentialsMissing: true,
    });
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
    const warn = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);
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
    expect(warn).toHaveBeenCalledWith(
      { code: "capability_upstream_unavailable", reason: "upstream_unavailable" },
      "capability.fetch.stdio_degraded",
    );
  });

  it("starts discovery mode when bootstrap capability lookup rejects credentials", async () => {
    const config = testConfig();
    const server = { close: vi.fn(async () => undefined) };
    const createServer = vi.spyOn(serverModule, "createServer").mockReturnValue(server as never);
    vi.spyOn(serverModule, "loadConfig").mockReturnValue(config);
    vi.spyOn(serverModule, "fetchCapabilities").mockRejectedValue(
      new CredentialResolutionError(
        "Credential or capability resolution failed",
        401,
        "capability_auth_failed",
      ),
    );
    const warn = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);
    const serveStdio = vi.mocked(stdioTransport.serveStdio).mockImplementation(
      () =>
        ({
          close: vi.fn(async () => undefined),
        }) as ReturnType<typeof stdioTransport.serveStdio>,
    );

    await startStdio();

    const factory = serveStdio.mock.calls[0]?.[0] as (() => unknown) | undefined;
    expect(factory?.()).toBe(server);
    expect(createServer).toHaveBeenCalledWith(config, null, { credentialsMissing: true });
    expect(warn).toHaveBeenCalledWith(
      { code: "capability_auth_failed", reason: "auth_failed" },
      "capability.fetch.stdio_discovery_mode",
    );
  });

  it("bounds stdio capability lookup before starting with a fail-closed surface", async () => {
    vi.useFakeTimers();
    try {
      process.env.B2_STDIO_CAPABILITY_TIMEOUT_MS = "25";
      const config = testConfig();
      const server = { close: vi.fn(async () => undefined) };
      const createServer = vi.spyOn(serverModule, "createServer").mockReturnValue(server as never);
      vi.spyOn(serverModule, "loadConfig").mockReturnValue(config);
      vi.spyOn(serverModule, "fetchCapabilities").mockReturnValue(
        new Promise<string[] | null>(() => undefined),
      );
      const info = vi.spyOn(loggerModule.logger, "info").mockImplementation(() => undefined);
      const warn = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);
      const flushLogsSync = vi
        .spyOn(loggerModule, "flushLogsSync")
        .mockImplementation(() => undefined);
      const serveStdio = vi.mocked(stdioTransport.serveStdio).mockImplementation(
        () =>
          ({
            close: vi.fn(async () => undefined),
          }) as ReturnType<typeof stdioTransport.serveStdio>,
      );

      const started = startStdio();

      expect(serveStdio).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(
        { transport: "stdio", timeoutMs: 25 },
        "capability.fetch.stdio_starting",
      );
      expect(flushLogsSync).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(24);
      expect(serveStdio).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(started).resolves.toBeUndefined();

      const factory = serveStdio.mock.calls[0]?.[0] as (() => unknown) | undefined;
      expect(factory?.()).toBe(server);
      expect(createServer).toHaveBeenCalledWith(config, [], {
        failClosedUnknownCapabilities: true,
      });
      expect(warn).toHaveBeenCalledWith(
        {
          code: "stdio_capability_deadline_exceeded",
          reason: "stdio_bootstrap_deadline",
          deadlineMs: 25,
        },
        "capability.fetch.stdio_degraded",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rethrows unexpected capability lookup failures", async () => {
    const config = testConfig();
    vi.spyOn(serverModule, "loadConfig").mockReturnValue(config);
    vi.spyOn(serverModule, "fetchCapabilities").mockRejectedValue(new Error("authorize failed"));

    await expect(startStdio()).rejects.toThrow("authorize failed");
    expect(stdioTransport.serveStdio).not.toHaveBeenCalled();
  });

  it("starts in discovery mode instead of exiting when credentials are missing", async () => {
    for (const key of credentialEnvKeys) delete process.env[key];
    const exit = vi.spyOn(process, "exit").mockImplementation(((code) => {
      throw Object.assign(new Error(`process.exit(${code})`), { exitCode: code });
    }) as typeof process.exit);
    const config = testConfig();
    vi.spyOn(serverModule, "createServer").mockReturnValue({
      close: vi.fn(async () => undefined),
    } as never);
    vi.spyOn(serverModule, "loadConfig").mockReturnValue(config);
    vi.spyOn(serverModule, "fetchCapabilities").mockResolvedValue(null);
    vi.mocked(stdioTransport.serveStdio).mockImplementation(
      () =>
        ({ close: vi.fn(async () => undefined) }) as ReturnType<typeof stdioTransport.serveStdio>,
    );

    await expect(startStdio()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("package root surface", () => {
  it("exports only the supported startStdio API", () => {
    expect(Object.keys(packageRoot).sort()).toEqual(["startStdio"]);
  });
});

describe("CLI dispatch", () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  let savedTransportEnv: Record<(typeof transportEnvKeys)[number], string | undefined>;

  beforeEach(() => {
    savedTransportEnv = Object.fromEntries(
      transportEnvKeys.map((key) => [key, process.env[key]]),
    ) as Record<(typeof transportEnvKeys)[number], string | undefined>;
    for (const key of transportEnvKeys) delete process.env[key];
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    for (const key of transportEnvKeys) {
      const value = savedTransportEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("prints help without starting a transport", async () => {
    const loadConfig = vi.spyOn(serverModule, "loadConfig");

    await indexTestSeams().runCli(["--help"]);

    expect(stdout).toHaveBeenCalledWith(`${helpText()}\n`);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("prints the package version without starting a transport", async () => {
    const loadConfig = vi.spyOn(serverModule, "loadConfig");

    await indexTestSeams().runCli(["--version"]);

    expect(stdout).toHaveBeenCalledWith(`${VERSION}\n`);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("dispatches HTTP transport through the dynamic import seam", async () => {
    const httpServer = await import("../../src/http-server.js");
    const startHttp = vi.mocked(httpServer.startHttp).mockResolvedValue(undefined);

    await indexTestSeams().runCli(["http", "--host", "127.0.0.1", "--port", "4321"]);

    expect(startHttp).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4321 });
  });

  it("dispatches stdio by default", async () => {
    const config = testConfig();
    const server = { close: vi.fn(async () => undefined) };
    vi.spyOn(serverModule, "loadConfig").mockReturnValue(config);
    vi.spyOn(serverModule, "fetchCapabilities").mockResolvedValue(["listBuckets"]);
    vi.spyOn(serverModule, "createServer").mockReturnValue(server as never);
    vi.mocked(stdioTransport.serveStdio).mockImplementation(
      () =>
        ({
          close: vi.fn(async () => undefined),
        }) as ReturnType<typeof stdioTransport.serveStdio>,
    );

    await indexTestSeams().runCli([]);

    expect(stdioTransport.serveStdio).toHaveBeenCalledOnce();
  });
});

describe("CLI fatal-error handler", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  let exit: ReturnType<typeof vi.spyOn>;
  let flushLogsSync: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    exit = vi.spyOn(process, "exit").mockImplementation(((code) => {
      throw Object.assign(new Error(`process.exit(${code})`), { exitCode: code });
    }) as typeof process.exit);
    flushLogsSync = vi.spyOn(loggerModule, "flushLogsSync").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it.each([
    ["CLI usage", ["--transport", "sse"]],
    ["port usage", ["http", "--port", "nope"]],
  ])("exits with code 2 for %s errors", async (_name, argv) => {
    await expect(runMain(argv)).rejects.toThrow("process.exit(2)");

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("b2-mcp: "));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("\n\nUsage: b2-mcp"));
    expect(flushLogsSync).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("logs fatal and exits with code 1 for generic startup errors", async () => {
    const fatal = vi.spyOn(loggerModule.logger, "fatal").mockImplementation(() => undefined);
    vi.spyOn(serverModule, "loadConfig").mockImplementation(() => {
      throw new Error("startup failed");
    });

    await expect(runMain(["stdio"])).rejects.toThrow("process.exit(1)");

    expect(stderr).toHaveBeenCalledWith("b2-mcp: startup failed\n");
    expect(fatal).toHaveBeenCalledWith({ err: "startup failed" }, "server.fatal");
    expect(flushLogsSync).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("executable CLI entry point", () => {
  it("prints usage errors with help and exit code 2", () => {
    const result = runEntrypoint(["--transport", "sse"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("b2-mcp: Invalid transport: sse");
    expect(result.stderr).toContain("Usage: b2-mcp");
  });

  it("starts the stdio server in discovery mode when credentials are missing", () => {
    // Empty stdin makes the MCP stdio transport close promptly on EOF instead of
    // blocking; the discovery warning is flushed synchronously at startup.
    const result = spawnSync(tsxBin, ["src/index.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: executableEnv({}),
      input: "",
      timeout: 10_000,
    });

    // No longer exits with the missing-credential fatal (previously status 1);
    // the server starts in discovery mode and closes cleanly on stdin EOF. Assert
    // an exact clean exit so a timeout (status null + error set) or any alternate
    // startup crash cannot pass. The discovery warning itself is asserted in the
    // mocked stdio-entry test above.
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).not.toContain(
      "B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY are required for stdio",
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

  it("redacts configured secrets from HTTP entrypoint startup errors", () => {
    const secret = "http-entrypoint-secret-value";
    const result = runEntrypoint(["http"], { B2_APPLICATION_KEY: secret, PORT: secret });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("b2-mcp: Invalid port: [redacted]");
    expect(result.stderr).not.toContain(secret);
  });
});
