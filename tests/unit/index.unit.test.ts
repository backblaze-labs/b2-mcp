import * as http from "http";
import type { AddressInfo } from "net";
import { CredentialResolutionError } from "../../src/credentials";
import { runCli, startStdio, type StdioBootstrapDependencies } from "../../src/index";
import { logger } from "../../src/utils/logger";
import type { B2Config } from "../../src/utils/types";
import { VERSION } from "../../src/version";

const credentialEnvKeys = [
  "B2_APPLICATION_KEY_ID",
  "B2_APPLICATION_KEY",
  "B2_APP_KEY_ID",
  "B2_APP_KEY",
  "B2_MASTER_KEY_ID",
  "B2_MASTER_KEY",
] as const;

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
  });

  it("bootstraps stdio with fetched credential capabilities", async () => {
    const config = testConfig();
    const server = { close: vi.fn(async () => undefined) };
    const createServer = vi.fn(() => server);
    const serveStdio = vi.fn();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    await startStdio({
      loadConfig: vi.fn(() => config),
      fetchCapabilities: vi.fn(async () => ["listBuckets"]),
      createServer: createServer as unknown as StdioBootstrapDependencies["createServer"],
      serveStdio: serveStdio as unknown as StdioBootstrapDependencies["serveStdio"],
    });

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
    const createServer = vi.fn(() => server);
    const serveStdio = vi.fn();

    await startStdio({
      loadConfig: vi.fn(() => config),
      fetchCapabilities: vi.fn(async () => {
        throw new CredentialResolutionError(
          "capability service unavailable",
          503,
          "capability_upstream_unavailable",
        );
      }),
      createServer: createServer as unknown as StdioBootstrapDependencies["createServer"],
      serveStdio: serveStdio as unknown as StdioBootstrapDependencies["serveStdio"],
    });

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

describe("unified CLI entry point", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes HTTP transport to startHttp with the parsed port", async () => {
    const startHttp = vi.fn(async () => undefined);
    const startStdio = vi.fn(async () => undefined);

    await runCli(["http", "--port", "4321"], { startHttp, startStdio });

    expect(startHttp).toHaveBeenCalledWith({ port: 4321 });
    expect(startStdio).not.toHaveBeenCalled();
  });

  it("routes stdio transport to startStdio", async () => {
    const startHttp = vi.fn(async () => undefined);
    const startStdio = vi.fn(async () => undefined);

    await runCli(["--transport", "stdio"], { startHttp, startStdio });

    expect(startStdio).toHaveBeenCalledTimes(1);
    expect(startHttp).not.toHaveBeenCalled();
  });

  it("prints help and version without starting a transport", async () => {
    const output: string[] = [];
    const runtime = {
      startHttp: vi.fn(async () => undefined),
      startStdio: vi.fn(async () => undefined),
      stdout: {
        write(chunk: string) {
          output.push(chunk);
        },
      },
    };

    await runCli(["--help"], runtime);
    await runCli(["--version"], runtime);

    expect(output[0]).toContain("Usage: b2-mcp");
    expect(output[1]).toBe(`${VERSION}\n`);
    expect(runtime.startHttp).not.toHaveBeenCalled();
    expect(runtime.startStdio).not.toHaveBeenCalled();
  });

  it("uses the default HTTP starter when no runtime override is supplied", async () => {
    const portProbe = http.createServer();
    await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
    const port = (portProbe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));
    const beforeTerm = new Set(process.listeners("SIGTERM"));
    const beforeInt = new Set(process.listeners("SIGINT"));
    const exitCodes: Array<string | number | null | undefined> = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code) => {
      exitCodes.push(code);
      return undefined as never;
    }) as typeof process.exit);
    let listener: (() => void) | undefined;

    try {
      await runCli(["http", "--port", String(port)]);
      listener = process.listeners("SIGTERM").find((candidate) => !beforeTerm.has(candidate)) as
        | (() => void)
        | undefined;
      expect(listener).toBeTypeOf("function");
      listener?.();
      await vi.waitFor(() => expect(exitCodes).toContain(0));
    } finally {
      if (listener && !exitCodes.includes(0)) {
        listener();
        await vi.waitFor(() => expect(exitCodes).toContain(0));
      }
      exitSpy.mockRestore();
      for (const candidate of process.listeners("SIGTERM")) {
        if (!beforeTerm.has(candidate)) process.off("SIGTERM", candidate);
      }
      for (const candidate of process.listeners("SIGINT")) {
        if (!beforeInt.has(candidate)) process.off("SIGINT", candidate);
      }
    }
  });
});
