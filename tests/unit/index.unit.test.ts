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
import { restoreB2SdkTransportForTests } from "../support/sdk-factory-hook";
import {
  b2EndpointName,
  installSdkTransport,
  RecordingTransport,
  StaticHttpResponse,
} from "../support/sdk-test-helpers";

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
const executableEnvKeys = [...credentialEnvKeys, ...transportEnvKeys] as const;
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

async function waitForRecordedRequests(transport: RecordingTransport, count: number) {
  for (let i = 0; i < 20 && transport.requests.length < count; i++) {
    await Promise.resolve();
  }
  expect(transport.requests).toHaveLength(count);
}

describe("stdio entry point", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(credentialEnvKeys.map((key) => [key, process.env[key]]));
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreB2SdkTransportForTests();
    serverModule.invalidateCapabilityCache();
    serverModule.invalidateAuthManagerCache();
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
    const fetchCapabilities = vi
      .spyOn(serverModule, "fetchCapabilities")
      .mockResolvedValue(["listBuckets"]);
    const serveStdio = vi.mocked(stdioTransport.serveStdio).mockImplementation(
      () =>
        ({
          close: vi.fn(async () => undefined),
        }) as ReturnType<typeof stdioTransport.serveStdio>,
    );
    const warn = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(loggerModule.logger, "info").mockImplementation(() => undefined);
    const flushLogsSync = vi
      .spyOn(loggerModule, "flushLogsSync")
      .mockImplementation(() => undefined);

    await startStdio();

    const factory = serveStdio.mock.calls[0]?.[0] as (() => unknown) | undefined;
    const options = serveStdio.mock.calls[0]?.[1] as { onerror(error: Error): void } | undefined;
    expect(factory?.()).toBe(server);
    options?.onerror(new Error("stdio failed"));
    expect(createServer).toHaveBeenCalledWith(config, ["listBuckets"], {});
    expect(warn).toHaveBeenCalledWith({ err: "stdio failed" }, "mcp.stdio.error");
    expect(info).toHaveBeenCalledWith({ transport: "stdio" }, "server.starting");
    expect(info).toHaveBeenCalledWith({ transport: "stdio" }, "server.started");
    expect(fetchCapabilities.mock.invocationCallOrder[0]).toBeGreaterThan(
      info.mock.invocationCallOrder[0] ?? 0,
    );
    expect(flushLogsSync).toHaveBeenCalled();
    expect(fetchCapabilities.mock.invocationCallOrder[0]).toBeGreaterThan(
      flushLogsSync.mock.invocationCallOrder[0] ?? 0,
    );
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
    expect(createServer).toHaveBeenCalledWith(config, null, {});
    expect(warn).toHaveBeenCalledWith(
      {
        code: "capability_upstream_unavailable",
        message: "capability service unavailable",
      },
      "capability.fetch.stdio_degraded",
    );
  });

  it("bounds stdio capability discovery and degrades before client handshakes time out", async () => {
    vi.useFakeTimers();
    const config = testConfig();
    const server = { close: vi.fn(async () => undefined) };
    const createServer = vi.spyOn(serverModule, "createServer").mockReturnValue(server as never);
    vi.spyOn(serverModule, "loadConfig").mockReturnValue(config);
    vi.spyOn(serverModule, "fetchCapabilities").mockReturnValue(
      new Promise<string[] | null>(() => undefined),
    );
    const warn = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);
    const serveStdio = vi.mocked(stdioTransport.serveStdio).mockImplementation(
      () =>
        ({
          close: vi.fn(async () => undefined),
        }) as ReturnType<typeof stdioTransport.serveStdio>,
    );

    const started = startStdio();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(started).resolves.toBeUndefined();
    const factory = serveStdio.mock.calls[0]?.[0] as (() => unknown) | undefined;
    expect(factory?.()).toBe(server);
    expect(createServer).toHaveBeenCalledWith(config, [], {
      failClosed: true,
    });
    expect(warn).toHaveBeenCalledWith(
      {
        code: "capability_bootstrap_timeout",
        elapsedMs: 10_000,
        message: "B2 capability lookup exceeded the 10000 ms stdio bootstrap deadline",
        timeoutMs: 10_000,
      },
      "capability.fetch.stdio_degraded",
    );
  });

  it("aborts timed-out stdio capability discovery instead of leaving authorize work", async () => {
    vi.useFakeTimers();
    const config = testConfig();
    const server = { close: vi.fn(async () => undefined) };
    vi.spyOn(serverModule, "loadConfig").mockReturnValue(config);
    const createServer = vi.spyOn(serverModule, "createServer").mockReturnValue(server as never);
    const warn = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(loggerModule.logger, "info").mockImplementation(() => undefined);
    const serveStdio = vi.mocked(stdioTransport.serveStdio).mockImplementation(
      () =>
        ({
          close: vi.fn(async () => undefined),
        }) as ReturnType<typeof stdioTransport.serveStdio>,
    );
    let abortObserved = false;
    let authorizeSettled = false;
    const transport = new RecordingTransport((request) => {
      if (b2EndpointName(request) !== "b2_authorize_account") {
        return new StaticHttpResponse(200, {});
      }
      return new Promise<StaticHttpResponse>((_resolve, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => {
            abortObserved = true;
            authorizeSettled = true;
            reject(request.signal?.reason ?? new Error("authorize aborted"));
          },
          { once: true },
        );
      });
    });
    installSdkTransport(transport, {
      maxRetries: 3,
      initialRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      requestTimeoutMs: 30_000,
    });
    const authorizeRequests = () =>
      transport.requests.filter((request) => b2EndpointName(request) === "b2_authorize_account");

    const started = startStdio();
    await waitForRecordedRequests(transport, 1);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(started).resolves.toBeUndefined();
    await Promise.resolve();
    expect(abortObserved).toBe(true);
    expect(authorizeSettled).toBe(true);
    expect(transport.requests[0].signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    expect(authorizeRequests()).toHaveLength(1);
    expect(serverModule.capabilityCacheSizeForTests()).toBe(0);
    const factory = serveStdio.mock.calls[0]?.[0] as (() => unknown) | undefined;
    expect(factory?.()).toBe(server);
    expect(createServer).toHaveBeenCalledWith(config, [], {
      failClosed: true,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "capability_bootstrap_timeout",
        message: "B2 capability lookup exceeded the 10000 ms stdio bootstrap deadline",
        timeoutMs: 10_000,
      }),
      "capability.fetch.stdio_degraded",
    );
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), "capability.fetch.failed");
  });

  it("does not expose write or admin tools after a stdio capability timeout", async () => {
    vi.useFakeTimers();
    const config: B2Config = {
      ...testConfig(),
      masterKeyId: "distinct-master-id",
      masterKey: "distinct-master-secret",
      secretSink: { mode: "off" },
    };
    vi.spyOn(serverModule, "loadConfig").mockReturnValue(config);
    vi.spyOn(serverModule, "fetchCapabilities").mockReturnValue(
      new Promise<string[] | null>(() => undefined),
    );
    vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(loggerModule.logger, "info").mockImplementation(() => undefined);
    const serveStdio = vi.mocked(stdioTransport.serveStdio).mockImplementation(
      () =>
        ({
          close: vi.fn(async () => undefined),
        }) as ReturnType<typeof stdioTransport.serveStdio>,
    );

    const started = startStdio();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(started).resolves.toBeUndefined();
    const factory = serveStdio.mock.calls[0]?.[0] as (() => unknown) | undefined;
    const server = factory?.() as Parameters<typeof serverModule.getRegisteredTools>[0];
    const tools = serverModule.getRegisteredTools(server);
    expect(tools).not.toHaveProperty("s3_put_object");
    expect(tools).not.toHaveProperty("s3_delete_objects");
    expect(tools).not.toHaveProperty("s3_get_presigned_url");
    expect(tools).not.toHaveProperty("b2_create_key");
    expect(tools).not.toHaveProperty("b2_list_groups");
    expect(tools).not.toHaveProperty("b2_create_group_member");
    expect(tools).not.toHaveProperty("b2_eject_group_member");
    expect(tools).not.toHaveProperty("b2_list_group_members");
    expect(tools).not.toHaveProperty("b2_reserve_trial_create_account");
  });

  it("rethrows unexpected capability lookup failures", async () => {
    const config = testConfig();
    vi.spyOn(serverModule, "loadConfig").mockReturnValue(config);
    vi.spyOn(serverModule, "fetchCapabilities").mockRejectedValue(new Error("authorize failed"));

    await expect(startStdio()).rejects.toThrow("authorize failed");
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

    await indexTestSeams().runCli(["http", "--port", "4321"]);

    expect(startHttp).toHaveBeenCalledWith({ port: 4321 });
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

  it("redacts configured secrets from HTTP entrypoint startup errors", () => {
    const secret = "http-entrypoint-secret-value";
    const result = runEntrypoint(["http"], { B2_APPLICATION_KEY: secret, PORT: secret });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("b2-mcp: Invalid port: [redacted]");
    expect(result.stderr).not.toContain(secret);
  });
});
